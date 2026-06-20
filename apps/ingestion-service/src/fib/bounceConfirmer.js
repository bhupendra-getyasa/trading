// apps/ingestion-service/src/fib/bounceConfirmer.js
// ─────────────────────────────────────────────────────────────────────────────
// BOUNCE CONFIRMER
// ─────────────────────────────────────────────────────────────────────────────
//
// Tracks whether price is genuinely bouncing off a fib level or just
// passing through it.  A "confirmed bounce" requires:
//   1. Price stays near the level for MIN_TOUCH_TICKS ticks.
//   2. Price then rises (BULLISH) or falls (BEARISH) at least MIN_BOUNCE_PCT%
//      from the most extreme touch point.
//
// FIXES APPLIED
//   Fix 1 — breakPct direction-aware.
//            BULLISH: expire when price breaks too far BELOW the level.
//            BEARISH: expire when price breaks too far ABOVE the level
//            (recovery failed; no signal to generate).
//            Previously the formula always subtracted currentPrice from
//            levelPrice, which gave a negative result for BEARISH touches
//            and the expire guard never fired.
//
//   Fix 2 — Duplicate signal guard on CONFIRMED touches.
//            If isBounceConfirmed fires on an already-CONFIRMED touch
//            (price dips back to the same level on the same swing),
//            upsertTouch now returns null so the caller skips it instead
//            of generating a second signal.
//
//   Fix 3 — MIN_BOUNCE_PCT moved to module scope.
//            It was re-parsed via process.env on every upsertTouch call
//            (potentially thousands of times per batch).
//
//   Fix 4 — expireOldTouches and expireYesterdayTouches merged into a
//            single expireStaleTouches function with one DB round-trip.
//            Both conditions are now in a single UPDATE WHERE clause.
//
//   Fix 5 — Removed dead `lastPrice` variable that was declared but
//            never used after the bouncePct refactor.

'use strict';

// ── Configuration ─────────────────────────────────────────────────────────────
const MIN_TOUCH_TICKS  = parseInt(process.env.MIN_TOUCH_TICKS  || '2',   10);
const MIN_BOUNCE_TICKS = parseInt(process.env.MIN_BOUNCE_TICKS || '2',   10);
const BREAK_BELOW_PCT  = parseFloat(process.env.BREAK_BELOW_PCT || '1.0');
const MIN_BOUNCE_PCT   = parseFloat(process.env.MIN_BOUNCE_PCT  || '0.3'); // Fix 3: module scope

// ─────────────────────────────────────────────────────────────────────────────
// upsertTouch
// Creates or updates a touch record for this symbol + level + swing.
//
// Returns:
//   - updated DB row  → price is still near the level (WATCHING or just inserted)
//   - null            → touch is expired (price broke through) OR touch is
//                       already CONFIRMED (duplicate guard, Fix 2)
// ─────────────────────────────────────────────────────────────────────────────
async function upsertTouch(pool, { symbol, swingId, levelPercent, levelPrice, currentPrice, trendDirection }) {
    const { rows } = await pool.query(
        `SELECT * FROM public.fib_level_touches
         WHERE  symbol        = $1
           AND  level_percent = $2
           AND  swing_id      = $3
           AND  status        IN ('WATCHING', 'CONFIRMED')
         ORDER  BY created_at DESC
         LIMIT  1`,
        [symbol, levelPercent, swingId]
    );

    // ── Fix 2: if already CONFIRMED on this swing, do not re-signal ──────────
    if (rows.length > 0 && rows[0].status === 'CONFIRMED') {
        return null;
    }

    if (rows.length === 0) {
        // First touch — create new WATCHING record
        const { rows: inserted } = await pool.query(
            `INSERT INTO public.fib_level_touches
               (symbol, swing_id, level_percent, level_price,
                first_touch_price, lowest_touch_price, highest_touch_price, last_price,
                touch_ticks, bounce_ticks, status)
             VALUES ($1,$2,$3,$4,$5,$5,$5,$5, 1, 0, 'WATCHING')
             RETURNING *`,
            [symbol, swingId, levelPercent, levelPrice, currentPrice]
        );
        return inserted[0];
    }

    const touch        = rows[0];
    const levelPriceFl = parseFloat(touch.level_price);

    // ── Fix 1: direction-aware break detection ────────────────────────────────
    // BULLISH: expire if price falls too far BELOW the level (support broken).
    // BEARISH: expire if price rises too far ABOVE the level (resistance broken).
    let breakPct;
    if (trendDirection === 'BEARISH') {
        breakPct = ((currentPrice - levelPriceFl) / levelPriceFl) * 100;
    } else {
        // BULLISH (default)
        breakPct = ((levelPriceFl - currentPrice) / levelPriceFl) * 100;
    }

    if (breakPct > BREAK_BELOW_PCT) {
        await pool.query(
            `UPDATE public.fib_level_touches
             SET    status = 'EXPIRED', updated_at = NOW()
             WHERE  id = $1`,
            [touch.id]
        );
        console.log(`[bounce] EXPIRED ${symbol} @ ${(levelPercent * 100).toFixed(1)}% — broke through level`);
        return null;
    }

    // ── Bounce detection ──────────────────────────────────────────────────────
    // BULLISH: price rising from lowest touch = bouncing off support.
    // BEARISH: price falling from highest touch = bouncing off resistance.
    let bouncePct;
    if (trendDirection === 'BEARISH') {
        const highestTouchPrice = parseFloat(touch.highest_touch_price);
        bouncePct = ((highestTouchPrice - currentPrice) / highestTouchPrice) * 100;
    } else {
        const lowestTouchPrice = parseFloat(touch.lowest_touch_price);
        bouncePct = ((currentPrice - lowestTouchPrice) / lowestTouchPrice) * 100;
    }
    const isBouncing = bouncePct >= MIN_BOUNCE_PCT; // Fix 3: module-scoped constant

    const { rows: updated } = await pool.query(
        `UPDATE public.fib_level_touches SET
           last_price           = $1,
           lowest_touch_price   = LEAST(lowest_touch_price, $1),
           highest_touch_price  = GREATEST(highest_touch_price, $1),
           touch_ticks          = touch_ticks + 1,
           bounce_ticks         = bounce_ticks + $2,
           updated_at           = NOW()
         WHERE id = $3
         RETURNING *`,
        [currentPrice, isBouncing ? 1 : 0, touch.id]
    );

    return updated[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// isBounceConfirmed
// Returns true when price has held near the level long enough AND bounced.
// ─────────────────────────────────────────────────────────────────────────────
function isBounceConfirmed(touch) {
    return (
        parseInt(touch.touch_ticks,  10) >= MIN_TOUCH_TICKS &&
        parseInt(touch.bounce_ticks, 10) >= MIN_BOUNCE_TICKS
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// markTouchConfirmed
// ─────────────────────────────────────────────────────────────────────────────
async function markTouchConfirmed(pool, touchId) {
    await pool.query(
        `UPDATE public.fib_level_touches
         SET    status = 'CONFIRMED', updated_at = NOW()
         WHERE  id = $1`,
        [touchId]
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// expireStaleTouches  — Fix 4
// Replaces the previous expireOldTouches + expireYesterdayTouches pair.
// Both conditions are now in a single UPDATE so there is only one DB
// round-trip per batch instead of two.
//
// Expires WATCHING touches that are either:
//   a) older than 2 hours (stale intra-day), OR
//   b) created on a previous trading day (session boundary).
// ─────────────────────────────────────────────────────────────────────────────
async function expireStaleTouches(pool) {
    await pool.query(
        `UPDATE public.fib_level_touches
         SET    status = 'EXPIRED'
         WHERE  status = 'WATCHING'
           AND (
                 updated_at  < NOW() - INTERVAL '2 hours'
                 OR
                 created_at::date < (NOW() AT TIME ZONE 'Asia/Kuwait')::date
               )`
    );
}

module.exports = {
    upsertTouch,
    isBounceConfirmed,
    markTouchConfirmed,
    expireStaleTouches,
};