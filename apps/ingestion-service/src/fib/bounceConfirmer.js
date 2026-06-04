// apps/ingestion-service/src/fib/bounceConfirmer.js
'use strict';

// How many ticks price must HOLD near the level before we watch for bounce
const MIN_TOUCH_TICKS   = parseInt(process.env.MIN_TOUCH_TICKS   || '2');
// How many ticks price must move UP to confirm bounce
const MIN_BOUNCE_TICKS  = parseInt(process.env.MIN_BOUNCE_TICKS  || '2');
// If price breaks this far BELOW the level, it's not bouncing — abort
const BREAK_BELOW_PCT   = parseFloat(process.env.BREAK_BELOW_PCT || '1.0');

// ─────────────────────────────────────────────────────────────────────────────
// upsertTouch
// Creates or updates a touch record for this symbol + level.
// Returns the updated touch row.
// ─────────────────────────────────────────────────────────────────────────────
// async function upsertTouch(pool, { symbol, swingId, levelPercent, levelPrice, currentPrice }) {
//     // Check if an active WATCHING touch exists
//     const { rows } = await pool.query(
//         `SELECT * FROM public.fib_level_touches
//          WHERE  symbol        = $1
//            AND  level_percent = $2
//            AND  status        = 'WATCHING'
//          ORDER  BY created_at DESC
//          LIMIT  1`,
//         [symbol, levelPercent]
//     );

//     if (rows.length === 0) {
//         // First touch — create new record
//         const { rows: inserted } = await pool.query(
//             `INSERT INTO public.fib_level_touches
//                (symbol, swing_id, level_percent, level_price,
//                 first_touch_price, lowest_touch_price, last_price,
//                 touch_ticks, bounce_ticks, status)
//              VALUES ($1,$2,$3,$4,$5,$5,$5, 1, 0, 'WATCHING')
//              RETURNING *`,
//             [symbol, swingId, levelPercent, levelPrice, currentPrice]
//         );
//         return inserted[0];
//     }

//     const touch = rows[0];
//     const lastPrice    = parseFloat(touch.last_price);
//     const levelPriceFl = parseFloat(touch.level_price);

//     // Check if price broke too far below level — expired
//     const breakPct = ((levelPriceFl - currentPrice) / levelPriceFl) * 100;
//     if (breakPct > BREAK_BELOW_PCT) {
//         await pool.query(
//             `UPDATE public.fib_level_touches
//              SET status = 'EXPIRED', updated_at = NOW()
//              WHERE id = $1`,
//             [touch.id]
//         );
//         console.log(`[bounce] EXPIRED ${symbol} @ ${levelPercent*100}% — broke below level`);
//         return null; // signal this touch is dead
//     }

//     // Count as bounce tick if price moved UP from last tick
//     // const isBouncing = currentPrice > lastPrice;

//     const levelPriceFl = parseFloat(touch.level_price);
//     const risingFromLevel = currentPrice > lastPrice && currentPrice > levelPriceFl;
//     const isBouncing = risingFromLevel;

//     const { rows: updated } = await pool.query(
//         `UPDATE public.fib_level_touches SET
//            last_price         = $1,
//            lowest_touch_price = LEAST(lowest_touch_price, $1),
//            touch_ticks        = touch_ticks + 1,
//            bounce_ticks       = bounce_ticks + $2,
//            updated_at         = NOW()
//          WHERE id = $3
//          RETURNING *`,
//         [currentPrice, isBouncing ? 1 : 0, touch.id]
//     );

//     return updated[0];
// }

async function upsertTouch(pool, { symbol, swingId, levelPercent, levelPrice, currentPrice }) {
    const { rows } = await pool.query(
        `SELECT * FROM public.fib_level_touches
         WHERE  symbol        = $1
           AND  level_percent = $2
           AND  swing_id      = $3
           AND  status        = 'WATCHING'
         ORDER  BY created_at DESC
         LIMIT  1`,
        [symbol, levelPercent, swingId]
    );

    if (rows.length === 0) {
        const { rows: inserted } = await pool.query(
            `INSERT INTO public.fib_level_touches
               (symbol, swing_id, level_percent, level_price,
                first_touch_price, lowest_touch_price, last_price,
                touch_ticks, bounce_ticks, status)
             VALUES ($1,$2,$3,$4,$5,$5,$5, 1, 0, 'WATCHING')
             RETURNING *`,
            [symbol, swingId, levelPercent, levelPrice, currentPrice]
        );
        return inserted[0];
    }

    const touch        = rows[0];
    const lastPrice    = parseFloat(touch.last_price);
    const levelPriceFl = parseFloat(touch.level_price);
    // Fix 3: removed unused lowestPrice variable

    // Expire if broke too far below level
    const breakPct = ((levelPriceFl - currentPrice) / levelPriceFl) * 100;
    if (breakPct > BREAK_BELOW_PCT) {
        await pool.query(
            `UPDATE public.fib_level_touches SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
            [touch.id]
        );
        console.log(`[bounce] EXPIRED ${symbol} @ ${(levelPercent * 100).toFixed(1)}% — broke below level`);
        return null;
    }

    // Fix 4: bounce = price rising AND above the fib level (not just any upward tick)
    // const isBouncing = currentPrice > parseFloat(touch.lowest_touch_price);
    const MIN_BOUNCE_PCT = parseFloat(process.env.MIN_BOUNCE_PCT || '0.3');

    // Replace isBouncing logic:
    const lowestTouchPrice = parseFloat(touch.lowest_touch_price);
    const bouncePct = ((currentPrice - lowestTouchPrice) / lowestTouchPrice) * 100;
    const isBouncing = bouncePct >= MIN_BOUNCE_PCT;

    const { rows: updated } = await pool.query(
        `UPDATE public.fib_level_touches SET
           last_price         = $1,
           lowest_touch_price = LEAST(lowest_touch_price, $1),
           touch_ticks        = touch_ticks + 1,
           bounce_ticks       = bounce_ticks + $2,
           updated_at         = NOW()
         WHERE id = $3
         RETURNING *`,
        [currentPrice, isBouncing ? 1 : 0, touch.id]
    );

    return updated[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// isBounceConfirmed
// Returns true when price has held the level long enough AND is now rising.
// ─────────────────────────────────────────────────────────────────────────────
function isBounceConfirmed(touch) {
    return (
        parseInt(touch.touch_ticks)  >= MIN_TOUCH_TICKS &&
        parseInt(touch.bounce_ticks) >= MIN_BOUNCE_TICKS
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// markTouchConfirmed
// ─────────────────────────────────────────────────────────────────────────────
async function markTouchConfirmed(pool, touchId) {
    await pool.query(
        `UPDATE public.fib_level_touches
         SET status = 'CONFIRMED', updated_at = NOW()
         WHERE id = $1`,
        [touchId]
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// expireOldTouches
// Clean up WATCHING touches that are too old (stale from previous session).
// Call this at the start of each batch.
// ─────────────────────────────────────────────────────────────────────────────
async function expireOldTouches(pool) {
    await pool.query(
        `UPDATE public.fib_level_touches
         SET    status = 'EXPIRED'
         WHERE  status = 'WATCHING'
           AND  updated_at < NOW() - INTERVAL '2 hours'`
    );
}

async function expireYesterdayTouches(pool) {
    await pool.query(
        `UPDATE public.fib_level_touches
         SET    status = 'EXPIRED'
         WHERE  status = 'WATCHING'
           AND created_at::date < (NOW() AT TIME ZONE 'Asia/Kuwait')::date`
    );
}

module.exports = {
    upsertTouch,
    isBounceConfirmed,
    markTouchConfirmed,
    expireOldTouches,
    expireYesterdayTouches
};