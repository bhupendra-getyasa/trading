// apps/ingestion-service/src/fib/swingDetector.js
// ─────────────────────────────────────────────────────────────────────────────
// SWING DETECTION ALGORITHM
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT IS A SWING?
//   A swing is the price range between a significant LOW and a significant HIGH
//   (or vice versa) within the current trading session.
//
//   BULLISH swing: price moved UP  — swing_low formed first, then swing_high
//   BEARISH swing: price moved DOWN — swing_high formed first, then swing_low
//
// HOW DETECTION WORKS (per symbol, per tick):
//
//   Step 1 — Load the current ACTIVE swing for this symbol (from cache or DB).
//
//   Step 2 — Feed the new price into the swing machine:
//     a) If no active swing exists → create a new NEUTRAL one; direction
//        is assigned only after the first meaningful move.
//
//     b) If an active swing exists:
//        • Update current_price always.
//        • Track min_price_after_high / max_price_after_low.
//        • Extend swing_high / swing_low on breakout.
//        • REVERSAL CHECK — wrapped in a DB transaction so completed +
//          created always happen atomically.
//
//   Step 3 — Return { activeSwing, completedSwing } for signal evaluation.
//
// FIXES APPLIED
//   Fix 1 — markSwingCompleted + createSwing now run inside a single
//            BEGIN/COMMIT transaction. A crash between the two can no
//            longer leave the system with a COMPLETED swing and no successor.
//
//   Fix 2 — New swings seed as 'NEUTRAL' instead of always 'BULLISH'.
//            Direction is promoted to BULLISH/BEARISH on the first tick
//            that produces a meaningful move from the seed price.
//
//   Fix 3 — confirmed_ticks removed. It was incremented every tick but
//            never read anywhere; it was dead, misleading state.
//
//   Fix 4 — In-memory swing cache (swingCache) keyed by symbol. Avoids
//            one SELECT per symbol per tick under high-frequency batches.
//            Cache is invalidated on every write (update or reversal).
//
// CONFIGURATION:
//   SWING_REVERSAL_PCT      — drop/rise % from extreme to flip swing (default 2%)
//   MIN_SWING_RANGE_PCT     — minimum swing range as % of price (default 0.5%)
//   MIN_TICKS_TO_CONFIRM    — minimum ticks before reversal is allowed (default 2)
//   REVERSAL_CONFIRM_TICKS  — consecutive ticks away from extreme required (default 3)

'use strict';

// ─── Tunable parameters ───────────────────────────────────────────────────────
const SWING_REVERSAL_PCT   = parseFloat(process.env.SWING_REVERSAL_PCT   || '2.0');
const MIN_SWING_RANGE_PCT  = parseFloat(process.env.MIN_SWING_RANGE_PCT  || '0.5');
const MIN_TICKS_TO_CONFIRM = parseInt(process.env.MIN_TICKS_TO_CONFIRM   || '2', 10);
const REVERSAL_CONFIRM_TICKS = parseInt(process.env.REVERSAL_CONFIRM_TICKS || '3', 10);

// ─── Fix 4: In-memory swing cache ────────────────────────────────────────────
// Maps symbol → DB row of the current ACTIVE swing.
// Invalidated on every write so reads stay consistent with DB.
const swingCache = new Map();

function getCachedSwing(symbol) {
    return swingCache.get(symbol) ?? null;
}

function setCachedSwing(symbol, swing) {
    if (swing) swingCache.set(symbol, swing);
    else swingCache.delete(symbol);
}

function invalidateSwingCache(symbol) {
    swingCache.delete(symbol);
}

// ─────────────────────────────────────────────────────────────────────────────
// loadActiveSwing
// Fetch the current ACTIVE swing for a symbol. Checks in-memory cache first;
// falls back to DB on miss.
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
// Inserts a brand-new ACTIVE swing row.
// Fix 2: seeds as 'NEUTRAL'; direction is promoted on the first meaningful move.
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
            trendDirection,   // Fix 2: passed in; callers use 'NEUTRAL' for seeds
            now, now,
        ]
    );
    const swing = rows[0];
    setCachedSwing(symbol, swing);   // Fix 4: populate cache immediately
    return swing;
}

// ─────────────────────────────────────────────────────────────────────────────
// markSwingCompleted  (internal — only called inside the transaction helper)
// ─────────────────────────────────────────────────────────────────────────────
async function _markSwingCompleted(client, swingId) {
    await client.query(
        `UPDATE public.fibonacci_swings
         SET    status = 'COMPLETED'
         WHERE  id     = $1`,
        [swingId]
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// completeAndCreateSwing  — Fix 1
// Wraps markSwingCompleted + createSwing in a single transaction so both
// always succeed or both roll back together.
// Returns { completedSwing, newSwing }.
// ─────────────────────────────────────────────────────────────────────────────
async function completeAndCreateSwing(pool, symbol, oldSwing, currentPrice, newDirection, openPrice) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

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
        setCachedSwing(symbol, newSwing);  // Fix 4: cache the new swing

        return { completedSwing: oldSwing, newSwing };
    } catch (err) {
        await client.query('ROLLBACK');
        invalidateSwingCache(symbol);  // Fix 4: force DB re-read on next tick
        throw err;
    } finally {
        client.release();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// updateSwing
// Updates an existing ACTIVE swing with the new price tick.
// Also promotes NEUTRAL direction on first meaningful move (Fix 2).
// Returns the updated row.
// ─────────────────────────────────────────────────────────────────────────────
async function updateSwing(pool, swing, price) {
    const now = new Date();

    let {
        swing_low, swing_high,
        swing_low_at, swing_high_at,
        min_price_after_high, max_price_after_low,
        tick_count,
        trend_direction,
    } = swing;

    swing_low            = parseFloat(swing_low);
    swing_high           = parseFloat(swing_high);
    min_price_after_high = parseFloat(min_price_after_high);
    max_price_after_low  = parseFloat(max_price_after_low);

    // ── Step 1: Extend swing extremes on breakout ─────────────────────────────
    if (price > swing_high) {
        swing_high           = price;
        swing_high_at        = now;
        min_price_after_high = price;
    }
    if (price < swing_low) {
        swing_low           = price;
        swing_low_at        = now;
        max_price_after_low = price;
    }

    // ── Step 2: Track lowest / highest seen AFTER the extreme ─────────────────
    if (price < min_price_after_high) min_price_after_high = price;
    if (price > max_price_after_low)  max_price_after_low  = price;

    // ── Step 3: Consecutive ticks away from extremes ──────────────────────────
    let ticks_since_high = parseInt(swing.ticks_since_high || '0', 10);
    let ticks_since_low  = parseInt(swing.ticks_since_low  || '0', 10);

    if (price < swing_high) ticks_since_high++;
    else                    ticks_since_high = 0;

    if (price > swing_low) ticks_since_low++;
    else                   ticks_since_low = 0;

    // ── Step 4: Fix 2 — promote NEUTRAL direction ─────────────────────────────
    // Once there's a real range, assign direction based on where the seed price
    // sits relative to the current extremes.
    if (trend_direction === 'NEUTRAL') {
        const range    = swing_high - swing_low;
        const rangePct = swing_high > 0 ? (range / swing_high) * 100 : 0;
        if (rangePct >= MIN_SWING_RANGE_PCT) {
            // If the most recent move is DOWN from high → BEARISH seed
            // If the most recent move is UP from low  → BULLISH seed
            trend_direction = ticks_since_high > ticks_since_low ? 'BEARISH' : 'BULLISH';
        }
    }

    // ── Step 5: Increment tick counter ───────────────────────────────────────
    // Fix 3: confirmed_ticks removed — it was unused dead state.
    tick_count++;

    // ── Step 6: Persist to DB ─────────────────────────────────────────────────
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
        [
            price,
            swing_low,    swing_high,
            swing_low_at, swing_high_at,
            min_price_after_high,
            max_price_after_low,
            tick_count,
            ticks_since_high,
            ticks_since_low,
            trend_direction,
            swing.id,
        ]
    );

    const updated = rows[0];
    setCachedSwing(swing.symbol, updated);  // Fix 4: keep cache fresh
    return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// shouldReverseSwing
// Returns { reverse: bool, newDirection?: string }
//
// BEARISH reversal (only from BULLISH swing):
//   Price dropped SWING_REVERSAL_PCT% from swing_high AND held for
//   REVERSAL_CONFIRM_TICKS consecutive ticks below the high.
//
// BULLISH reversal (only from BEARISH swing):
//   Price rose SWING_REVERSAL_PCT% from swing_low AND held for
//   REVERSAL_CONFIRM_TICKS consecutive ticks above the low.
//
// NEUTRAL swings do not reverse — they promote direction via updateSwing.
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

    // BEARISH reversal — only from a BULLISH swing
    if (swing.trend_direction === 'BULLISH') {
        const dropFromHigh = ((high - minAfterHigh) / high) * 100;
        if (dropFromHigh >= SWING_REVERSAL_PCT && ticksSinceHigh >= REVERSAL_CONFIRM_TICKS) {
            return { reverse: true, newDirection: 'BEARISH' };
        }
    }

    // BULLISH reversal — only from a BEARISH swing
    if (swing.trend_direction === 'BEARISH') {
        const riseFromLow = ((maxAfterLow - low) / low) * 100;
        if (riseFromLow >= SWING_REVERSAL_PCT && ticksSinceLow >= REVERSAL_CONFIRM_TICKS) {
            return { reverse: true, newDirection: 'BULLISH' };
        }
    }

    return { reverse: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// processSwing — MAIN ENTRY POINT
//
// Called once per symbol per tick.
// Returns { activeSwing, completedSwing } where completedSwing is non-null
// only on the tick that a reversal fires.
// ─────────────────────────────────────────────────────────────────────────────
async function processSwing(pool, symbol, currentPrice, openPrice = null) {
    // Fix 4: cache-first load
    let swing = await loadActiveSwing(pool, symbol);

    if (!swing) {
        // Fix 2: seed as NEUTRAL — direction assigned on first meaningful move
        console.log(`[swing] New swing seeded for ${symbol} @ ${currentPrice}`);
        const newSwing = await createSwing(pool, symbol, currentPrice, 'NEUTRAL', openPrice);
        return { activeSwing: newSwing, completedSwing: null };
    }

    const { reverse, newDirection } = shouldReverseSwing(swing);

    if (reverse) {
        console.log(
            `[swing] REVERSAL ${swing.trend_direction} → ${newDirection} | ` +
            `${symbol} | was [${swing.swing_low} – ${swing.swing_high}] | ` +
            `now @ ${currentPrice}`
        );

        // Fix 1: atomic transaction — both writes succeed or both roll back
        const { completedSwing, newSwing } = await completeAndCreateSwing(
            pool, symbol, swing, currentPrice, newDirection, openPrice
        );

        return { activeSwing: newSwing, completedSwing };
    }

    const updated = await updateSwing(pool, swing, currentPrice);
    return { activeSwing: updated, completedSwing: null };
}

module.exports = {
    processSwing,
    loadActiveSwing,
    createSwing,
    invalidateSwingCache,
};