// apps/ingestion-service/src/fib/bounceConfirmer.js
// ─────────────────────────────────────────────────────────────────────────────
// BOUNCE CONFIRMER — EARLY-ENTRY REWRITE
// ─────────────────────────────────────────────────────────────────────────────
//
// ROOT CAUSE OF LATE SIGNALS:
//   MIN_TOUCH_TICKS=2 and MIN_BOUNCE_TICKS=2 meant:
//     - Price must touch the level for 2 ticks (2 minutes on 1-min scrape)
//     - Then bounce for another 2 ticks
//   = 4 minutes minimum AFTER price hits the level before a signal fires.
//   On a stock that moves 3-5% in 5 minutes, that is catastrophically late.
//
// FIX:
//   MIN_TOUCH_TICKS lowered 2 → 1: fire after the FIRST tick at the level.
//   MIN_BOUNCE_TICKS lowered 2 → 1: confirm after the FIRST rising tick.
//   Combined: signal fires after 2 ticks total instead of 4.
//   This cuts the entry delay roughly in half.
//
// ANTICIPATORY ENTRY (upsertApproachTouch — NEW):
//   For Zone 2 (approaching from above), we do NOT require any bounce
//   confirmation at all.  The signal fires immediately when price enters
//   the pre-entry zone — it is an alert to "place your limit order NOW".
//   No touch row is needed; the signal is generated directly in fibProcessor.
//
// BREAKOUT PATH (unchanged logic, MIN thresholds lowered to match):
//   MIN_BREAKOUT_TOUCH_TICKS  2 → 1
//   MIN_BREAKOUT_RISING_TICKS 2 → 1
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// CHANGED: 2 → 1 on all confirmation thresholds
const MIN_TOUCH_TICKS  = parseInt(process.env.MIN_TOUCH_TICKS  || '1', 10);  // ← was 2
const MIN_BOUNCE_TICKS = parseInt(process.env.MIN_BOUNCE_TICKS || '1', 10);  // ← was 2
const BREAK_BELOW_PCT  = parseFloat(process.env.BREAK_BELOW_PCT || '1.0');
const MIN_BOUNCE_PCT   = parseFloat(process.env.MIN_BOUNCE_PCT  || '0.2');   // ← was 0.3, lowered slightly

const BREAKOUT_FAIL_PCT = parseFloat(process.env.BREAKOUT_FAIL_PCT || '0.2');

const MIN_BREAKOUT_TOUCH_TICKS  = parseInt(process.env.MIN_BREAKOUT_TOUCH_TICKS  || '1', 10); // ← was 2
const MIN_BREAKOUT_RISING_TICKS = parseInt(process.env.MIN_BREAKOUT_RISING_TICKS || '1', 10); // ← was 2

// ─────────────────────────────────────────────────────────────────────────────
// upsertTouch  — Zone 1 (retracement support)
// ─────────────────────────────────────────────────────────────────────────────
async function upsertTouch(pool, { symbol, swingId, levelPercent, levelPrice, currentPrice, trendDirection }) {
    const { rows } = await pool.query(
        `SELECT * FROM public.fib_level_touches
         WHERE  symbol           = $1
           AND  level_percent    = $2
           AND  swing_id         = $3
           AND  approach_direction IN ('FROM_ABOVE','FROM_BELOW')
           AND  status           IN ('WATCHING', 'CONFIRMED')
         ORDER  BY created_at DESC
         LIMIT  1`,
        [symbol, levelPercent, swingId]
    );

    if (rows.length > 0 && rows[0].status === 'CONFIRMED') return null;

    const approachDirection = trendDirection === 'BEARISH' ? 'FROM_BELOW' : 'FROM_ABOVE';

    if (rows.length === 0) {
        const { rows: inserted } = await pool.query(
            `INSERT INTO public.fib_level_touches
               (symbol, swing_id, level_percent, level_price,
                first_touch_price, lowest_touch_price, highest_touch_price, last_price,
                touch_ticks, bounce_ticks, status, approach_direction)
             VALUES ($1,$2,$3,$4,$5,$5,$5,$5, 1, 0, 'WATCHING', $6)
             RETURNING *`,
            [symbol, swingId, levelPercent, levelPrice, currentPrice, approachDirection]
        );
        return inserted[0];
    }

    const touch        = rows[0];
    const levelPriceFl = parseFloat(touch.level_price);

    let breakPct;
    if (trendDirection === 'BEARISH') {
        breakPct = ((currentPrice - levelPriceFl) / levelPriceFl) * 100;
    } else {
        breakPct = ((levelPriceFl - currentPrice) / levelPriceFl) * 100;
    }

    if (breakPct > BREAK_BELOW_PCT) {
        await pool.query(
            `UPDATE public.fib_level_touches SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
            [touch.id]
        );
        return null;
    }

    let bouncePct;
    if (trendDirection === 'BEARISH') {
        bouncePct = ((parseFloat(touch.highest_touch_price) - currentPrice) / parseFloat(touch.highest_touch_price)) * 100;
    } else {
        bouncePct = ((currentPrice - parseFloat(touch.lowest_touch_price)) / parseFloat(touch.lowest_touch_price)) * 100;
    }
    const isBouncing = bouncePct >= MIN_BOUNCE_PCT;

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
// upsertApproachTouch  — Zone 2 (anticipatory entry)
//
// Called when price is APPROACHING a fib level from above (within
// PRE_ENTRY_ZONE_PCT%) but has NOT yet touched it.
//
// BUG FIX: The original version used approach_direction = 'APPROACHING' which
// is NOT in the fibonacci_signals.approach_direction CHECK constraint:
//   CHECK (approach_direction = ANY (ARRAY['FROM_ABOVE','FROM_BELOW','BREAKOUT_UP']))
// Every Zone 2 signal INSERT was rejected with a constraint violation.
// Fix: use 'FROM_ABOVE' which correctly describes the direction (price is above
// the level, approaching from above) AND satisfies the DB constraint.
// The zone can still be distinguished by signal_type = 'EARLY_BUY'.
// ─────────────────────────────────────────────────────────────────────────────
async function upsertApproachTouch(pool, { symbol, swingId, levelPercent, levelPrice, currentPrice }) {
    const { rows } = await pool.query(
        `SELECT * FROM public.fib_level_touches
         WHERE  symbol            = $1
           AND  level_percent     = $2
           AND  swing_id          = $3
           AND  approach_direction = 'FROM_ABOVE'
           AND  status            IN ('WATCHING', 'CONFIRMED')
         ORDER  BY created_at DESC
         LIMIT  1`,
        [symbol, levelPercent, swingId]
    );

    if (rows.length > 0 && rows[0].status === 'CONFIRMED') return null;

    if (rows.length === 0) {
        const { rows: inserted } = await pool.query(
            `INSERT INTO public.fib_level_touches
               (symbol, swing_id, level_percent, level_price,
                first_touch_price, lowest_touch_price, highest_touch_price, last_price,
                touch_ticks, bounce_ticks, status, approach_direction)
             VALUES ($1,$2,$3,$4,$5,$5,$5,$5, 1, 1, 'WATCHING', 'FROM_ABOVE')
             RETURNING *`,
            [symbol, swingId, levelPercent, levelPrice, currentPrice]
        );
        return inserted[0];
    }

    const touch = rows[0];
    const lp = parseFloat(touch.level_price);
    const distancePct = ((currentPrice - lp) / lp) * 100;

    if (distancePct < 0) {
        // Price dropped below the level — now in TOUCH zone, expire this record
        await pool.query(
            `UPDATE public.fib_level_touches SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
            [touch.id]
        );
        return null;
    }

    // BUG FIX: was WHERE id = $3 with params [currentPrice, 0, touch.id] — $2 phantom param
    const { rows: updated } = await pool.query(
        `UPDATE public.fib_level_touches SET
           last_price           = $1,
           lowest_touch_price   = LEAST(lowest_touch_price, $1),
           highest_touch_price  = GREATEST(highest_touch_price, $1),
           touch_ticks          = touch_ticks + 1,
           updated_at           = NOW()
         WHERE id = $2
         RETURNING *`,
        [currentPrice, touch.id]
    );
    return updated[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// upsertBreakoutTouch  — Zone 3 (breakout, kept)
// ─────────────────────────────────────────────────────────────────────────────
async function upsertBreakoutTouch(pool, { symbol, swingId, levelPercent, levelPrice, currentPrice }) {
    const { rows } = await pool.query(
        `SELECT * FROM public.fib_level_touches
         WHERE  symbol            = $1
           AND  level_percent     = $2
           AND  swing_id          = $3
           AND  approach_direction = 'BREAKOUT_UP'
           AND  status            IN ('WATCHING', 'CONFIRMED')
         ORDER  BY created_at DESC
         LIMIT  1`,
        [symbol, levelPercent, swingId]
    );

    if (rows.length > 0 && rows[0].status === 'CONFIRMED') return null;

    if (rows.length === 0) {
        const { rows: inserted } = await pool.query(
            `INSERT INTO public.fib_level_touches
               (symbol, swing_id, level_percent, level_price,
                first_touch_price, lowest_touch_price, highest_touch_price, last_price,
                touch_ticks, bounce_ticks, status, approach_direction)
             VALUES ($1,$2,$3,$4,$5,$5,$5,$5, 1, 1, 'WATCHING', 'BREAKOUT_UP')
             RETURNING *`,
            [symbol, swingId, levelPercent, levelPrice, currentPrice]
        );
        return inserted[0];
    }

    const touch        = rows[0];
    const levelPriceFl = parseFloat(touch.level_price);

    if (currentPrice < levelPriceFl) {
        const dropBelowPct = ((levelPriceFl - currentPrice) / levelPriceFl) * 100;
        if (dropBelowPct > BREAKOUT_FAIL_PCT) {
            await pool.query(
                `UPDATE public.fib_level_touches SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
                [touch.id]
            );
            return null;
        }
    }

    const isRising = currentPrice > parseFloat(touch.last_price);

    const { rows: updated } = await pool.query(
        `UPDATE public.fib_level_touches SET
           last_price           = $1,
           highest_touch_price  = GREATEST(highest_touch_price, $1),
           lowest_touch_price   = LEAST(lowest_touch_price, $1),
           touch_ticks          = touch_ticks + 1,
           bounce_ticks         = bounce_ticks + $2,
           updated_at           = NOW()
         WHERE id = $3
         RETURNING *`,
        [currentPrice, isRising ? 1 : 0, touch.id]
    );
    return updated[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirmation functions
// FIX: thresholds all lowered to 1 so confirmation fires after 1 tick
// ─────────────────────────────────────────────────────────────────────────────
function isBounceConfirmed(touch) {
    return (
        parseInt(touch.touch_ticks,  10) >= MIN_TOUCH_TICKS &&
        parseInt(touch.bounce_ticks, 10) >= MIN_BOUNCE_TICKS
    );
}

// Zone 2 (approach): no confirmation needed — fires immediately on first entry
function isApproachConfirmed(touch) {
    // touch_ticks >= 1 means we just entered the zone this tick or lingered
    // We fire on the FIRST tick in the zone (touch_ticks=1)
    return parseInt(touch.touch_ticks, 10) >= 1;
}

function isMomentumConfirmed(touch) {
    return (
        parseInt(touch.touch_ticks,  10) >= MIN_BREAKOUT_TOUCH_TICKS &&
        parseInt(touch.bounce_ticks, 10) >= MIN_BREAKOUT_RISING_TICKS
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// markTouchConfirmed
// ─────────────────────────────────────────────────────────────────────────────
async function markTouchConfirmed(pool, touchId) {
    await pool.query(
        `UPDATE public.fib_level_touches SET status = 'CONFIRMED', updated_at = NOW() WHERE id = $1`,
        [touchId]
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// expireStaleTouches  — covers all approach_direction types
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
    upsertApproachTouch,    // NEW: Zone 2 anticipatory
    isBounceConfirmed,
    isApproachConfirmed,    // NEW: Zone 2 confirmation (fires immediately)
    upsertBreakoutTouch,
    isMomentumConfirmed,
    markTouchConfirmed,
    expireStaleTouches,
};
