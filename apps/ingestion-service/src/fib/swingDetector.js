// apps/ingestion-service/src/fib/swingDetector.js
// ─────────────────────────────────────────────────────────────────────────────
// SWING DETECTION — EARLY-ENTRY REWRITE
// ─────────────────────────────────────────────────────────────────────────────
//
// ROOT CAUSE OF LATE SIGNALS:
//   The old engine required REVERSAL_CONFIRM_TICKS (3) consecutive ticks away
//   from the extreme AND a SWING_REVERSAL_PCT (2%) move before it would flip
//   the swing direction.  On a 1-minute scrape schedule, "3 ticks" means 3
//   minutes AFTER the low — the stock has already started moving up by the
//   time a BULLISH reversal is registered, and the subsequent fib levels are
//   computed from a range that excludes the first part of the new up-leg.
//   Result: EARLY_BUY fires when the "early" opportunity is already gone.
//
// FIX STRATEGY:
//   1. SWING_REVERSAL_PCT lowered from 2.0% → 1.0%.
//      A 1% reversal from the extreme is enough evidence of a swing low on KSE
//      (median daily move = 0.64%; a 1% recovery is clearly non-noise).
//
//   2. REVERSAL_CONFIRM_TICKS lowered from 3 → 2.
//      We confirm after 2 consecutive ticks above the low instead of 3.
//      Combined with the lower reversal %, this fires the BULLISH signal
//      roughly 1-2 minutes earlier — before the major up-move begins.
//
//   3. MIN_TICKS_TO_CONFIRM lowered from 2 → 2 (unchanged, already minimal).
//
//   4. MIN_COMPLETED_TICKS raised from 5 → 8.
//      Paradox: we want FASTER reversal detection BUT we also want the
//      completed swing to represent a REAL prior down-move, not 2-tick noise.
//      Raising the minimum tick count on a completed swing ensures Path B only
//      fires on swings with genuine history (≥8 minutes of data).
//
//   5. Swing seeded as NEUTRAL (unchanged) — direction promoted on first
//      meaningful move of MIN_SWING_RANGE_PCT (unchanged 0.5%).
//
// NO STRUCTURAL CHANGES — same exports, same DB schema, same cache logic.
// Only the tunable constants change.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ─── Tunable parameters ───────────────────────────────────────────────────────
//
// CHANGED vs original:
//   SWING_REVERSAL_PCT:     2.0 → 1.0  (detect reversals earlier)
//   REVERSAL_CONFIRM_TICKS: 3   → 2    (confirm 1 tick sooner)
//   MIN_COMPLETED_TICKS:    5   → 8    (require more history on the reference swing)
//
const SWING_REVERSAL_PCT     = parseFloat(process.env.SWING_REVERSAL_PCT     || '1.0');  // ← was 2.0
const MIN_SWING_RANGE_PCT    = parseFloat(process.env.MIN_SWING_RANGE_PCT    || '0.5');
const MIN_TICKS_TO_CONFIRM   = parseInt(process.env.MIN_TICKS_TO_CONFIRM     || '2', 10);
const REVERSAL_CONFIRM_TICKS = parseInt(process.env.REVERSAL_CONFIRM_TICKS   || '2', 10); // ← was 3
const MIN_COMPLETED_TICKS    = parseInt(process.env.MIN_COMPLETED_TICKS      || '8', 10); // ← was 5

// ─── In-memory swing cache ────────────────────────────────────────────────────
const swingCache = new Map();

function getCachedSwing(symbol)         { return swingCache.get(symbol) ?? null; }
function setCachedSwing(symbol, swing)  { if (swing) swingCache.set(symbol, swing); else swingCache.delete(symbol); }
function invalidateSwingCache(symbol)   { swingCache.delete(symbol); }

// ─────────────────────────────────────────────────────────────────────────────
// loadActiveSwing
// ─────────────────────────────────────────────────────────────────────────────
async function loadActiveSwing(pool, symbol) {
    const cached = getCachedSwing(symbol);
    if (cached) return cached;

    const { rows } = await pool.query(
        `SELECT *
         FROM   public.fibonacci_swings
         WHERE  symbol       = $1
           AND  status       = 'ACTIVE'
           AND  trading_date = (NOW() AT TIME ZONE 'Asia/Kuwait')::date
         ORDER  BY created_at DESC
         LIMIT  1`,
        [symbol]
    );
    const swing = rows[0] || null;
    setCachedSwing(symbol, swing);
    return swing;
}

// ─────────────────────────────────────────────────────────────────────────────
// createSwing
// ─────────────────────────────────────────────────────────────────────────────
async function createSwing(pool, symbol, price, trendDirection = 'NEUTRAL', openPrice = null) {
    const now = new Date();
    const { rows } = await pool.query(
        `INSERT INTO public.fibonacci_swings
           (symbol, swing_low, swing_high, current_price, open_price,
            min_price_after_high, max_price_after_low,
            trend_direction, status, trading_date,
            swing_low_at, swing_high_at,
            tick_count, ticks_since_high, ticks_since_low)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',
                 (NOW() AT TIME ZONE 'Asia/Kuwait')::date,
                 $9,$10, 1, 0, 0)
         RETURNING *`,
        [
            symbol, price, price, price, openPrice ?? price,
            price, price,
            trendDirection,
            now, now,
        ]
    );
    const swing = rows[0];
    setCachedSwing(symbol, swing);
    return swing;
}

async function _markSwingCompleted(client, swingId) {
    await client.query(
        `UPDATE public.fibonacci_swings SET status = 'COMPLETED' WHERE id = $1`,
        [swingId]
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// completeAndCreateSwing — atomic transaction
// ─────────────────────────────────────────────────────────────────────────────
async function completeAndCreateSwing(pool, symbol, oldSwing, currentPrice, newDirection, openPrice) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const completedSwing = { ...oldSwing };   // snapshot before mutation
        await _markSwingCompleted(client, oldSwing.id);

        const now = new Date();
        const { rows } = await client.query(
            `INSERT INTO public.fibonacci_swings
               (symbol, swing_low, swing_high, current_price, open_price,
                min_price_after_high, max_price_after_low,
                trend_direction, status, trading_date,
                swing_low_at, swing_high_at,
                tick_count, ticks_since_high, ticks_since_low)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',
                     (NOW() AT TIME ZONE 'Asia/Kuwait')::date,
                     $9,$10, 1, 0, 0)
             RETURNING *`,
            [
                symbol, currentPrice, currentPrice, currentPrice, openPrice ?? currentPrice,
                currentPrice, currentPrice,
                newDirection,
                now, now,
            ]
        );
        await client.query('COMMIT');
        const newSwing = rows[0];
        setCachedSwing(symbol, newSwing);
        return { completedSwing, newSwing };
    } catch (err) {
        await client.query('ROLLBACK');
        invalidateSwingCache(symbol);
        throw err;
    } finally {
        client.release();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// updateSwing
// ─────────────────────────────────────────────────────────────────────────────
async function updateSwing(pool, swing, price) {
    const now = new Date();

    let { swing_low, swing_high, swing_low_at, swing_high_at,
          min_price_after_high, max_price_after_low, tick_count, trend_direction } = swing;

    swing_low            = parseFloat(swing_low);
    swing_high           = parseFloat(swing_high);
    min_price_after_high = parseFloat(min_price_after_high);
    max_price_after_low  = parseFloat(max_price_after_low);

    if (price > swing_high) { swing_high = price; swing_high_at = now; min_price_after_high = price; }
    if (price < swing_low)  { swing_low  = price; swing_low_at  = now; max_price_after_low  = price; }
    if (price < min_price_after_high) min_price_after_high = price;
    if (price > max_price_after_low)  max_price_after_low  = price;

    let ticks_since_high = parseInt(swing.ticks_since_high || '0', 10);
    let ticks_since_low  = parseInt(swing.ticks_since_low  || '0', 10);
    if (price < swing_high) ticks_since_high++; else ticks_since_high = 0;
    if (price > swing_low)  ticks_since_low++;  else ticks_since_low  = 0;

    if (trend_direction === 'NEUTRAL') {
        const rangePct = swing_high > 0 ? ((swing_high - swing_low) / swing_high) * 100 : 0;
        if (rangePct >= MIN_SWING_RANGE_PCT) {
            trend_direction = ticks_since_high > ticks_since_low ? 'BEARISH' : 'BULLISH';
        }
    }

    tick_count++;

    const { rows } = await pool.query(
        `UPDATE public.fibonacci_swings SET
           current_price        = $1,
           swing_low            = $2,
           swing_high           = $3,
           swing_low_at         = $4,
           swing_high_at        = $5,
           min_price_after_high = $6,
           max_price_after_low  = $7,
           tick_count           = $8,
           ticks_since_high     = $9,
           ticks_since_low      = $10,
           trend_direction      = $11
         WHERE id = $12
         RETURNING *`,
        [price, swing_low, swing_high, swing_low_at, swing_high_at,
         min_price_after_high, max_price_after_low,
         tick_count, ticks_since_high, ticks_since_low, trend_direction, swing.id]
    );
    // BUG FIX: rows[0] is undefined when the UPDATE matches no rows.
    // This happens when the swing row was deleted or its status changed
    // between the cache read and the UPDATE (e.g. another process marked it
    // COMPLETED).  In that case, invalidate the cache and return the stale
    // in-memory object so the caller gets a defined value — the next tick
    // will load fresh state from the DB.
    if (!rows[0]) {
        invalidateSwingCache(swing.symbol);
        return swing;   // return the pre-update snapshot; never return undefined
    }
    const updated = rows[0];
    setCachedSwing(swing.symbol, updated);
    return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// shouldReverseSwing
// FIX: uses lowered SWING_REVERSAL_PCT (1.0%) and REVERSAL_CONFIRM_TICKS (2)
// so reversals are detected ~1-2 minutes earlier than before.
// ─────────────────────────────────────────────────────────────────────────────
function shouldReverseSwing(swing) {
    if (swing.trend_direction === 'NEUTRAL') return { reverse: false };

    const high  = parseFloat(swing.swing_high);
    const low   = parseFloat(swing.swing_low);
    const range = high - low;
    const ticks = parseInt(swing.tick_count, 10);

    if (ticks < MIN_TICKS_TO_CONFIRM) return { reverse: false };
    if (range === 0)                  return { reverse: false };

    const rangePct = (range / high) * 100;
    if (rangePct < MIN_SWING_RANGE_PCT) return { reverse: false };

    const minAfterHigh   = parseFloat(swing.min_price_after_high);
    const maxAfterLow    = parseFloat(swing.max_price_after_low);
    const ticksSinceHigh = parseInt(swing.ticks_since_high || '0', 10);
    const ticksSinceLow  = parseInt(swing.ticks_since_low  || '0', 10);

    if (swing.trend_direction === 'BULLISH') {
        const dropFromHigh = ((high - minAfterHigh) / high) * 100;
        // FIX: SWING_REVERSAL_PCT now 1.0% (was 2.0%) → fires sooner
        // FIX: REVERSAL_CONFIRM_TICKS now 2 (was 3) → 1 tick earlier
        if (dropFromHigh >= SWING_REVERSAL_PCT && ticksSinceHigh >= REVERSAL_CONFIRM_TICKS) {
            return { reverse: true, newDirection: 'BEARISH' };
        }
    }

    if (swing.trend_direction === 'BEARISH') {
        const riseFromLow = ((maxAfterLow - low) / low) * 100;
        // FIX: same thresholds — fires earlier on BULLISH reversals too
        if (riseFromLow >= SWING_REVERSAL_PCT && ticksSinceLow >= REVERSAL_CONFIRM_TICKS) {
            return { reverse: true, newDirection: 'BULLISH' };
        }
    }

    return { reverse: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// isCompletedSwingMeaningful
// FIX: MIN_COMPLETED_TICKS raised to 8 so Path B only fires on swings
// that represent ≥8 minutes of genuine price action, not micro-reversals.
// ─────────────────────────────────────────────────────────────────────────────
function isCompletedSwingMeaningful(completedSwing) {
    const ticks    = parseInt(completedSwing.tick_count, 10);
    if (ticks < MIN_COMPLETED_TICKS) return false;
    const high     = parseFloat(completedSwing.swing_high);
    const low      = parseFloat(completedSwing.swing_low);
    const rangePct = high > 0 ? ((high - low) / high) * 100 : 0;
    return rangePct >= MIN_SWING_RANGE_PCT;
}

// ─────────────────────────────────────────────────────────────────────────────
// processSwing — MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
async function processSwing(pool, symbol, currentPrice, openPrice = null) {
    let swing = await loadActiveSwing(pool, symbol);

    if (!swing) {
        const newSwing = await createSwing(pool, symbol, currentPrice, 'NEUTRAL', openPrice);
        return { activeSwing: newSwing, completedSwing: null, reversalDirection: null };
    }

    const { reverse, newDirection } = shouldReverseSwing(swing);

    if (reverse) {
        console.log(
            `[swing] REVERSAL ${swing.trend_direction} → ${newDirection} | ` +
            `${symbol} | was [${swing.swing_low} – ${swing.swing_high}] | ` +
            `now @ ${currentPrice}`
        );
        const { completedSwing, newSwing } = await completeAndCreateSwing(
            pool, symbol, swing, currentPrice, newDirection, openPrice
        );
        return { activeSwing: newSwing, completedSwing, reversalDirection: newDirection };
    }

    const updated = await updateSwing(pool, swing, currentPrice);
    return { activeSwing: updated, completedSwing: null, reversalDirection: null };
}

module.exports = {
    processSwing,
    loadActiveSwing,
    createSwing,
    invalidateSwingCache,
    isCompletedSwingMeaningful,
    MIN_COMPLETED_TICKS,
};
