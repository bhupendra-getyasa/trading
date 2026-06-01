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
//   Step 1 — Load the current ACTIVE swing for this symbol (if any).
//
//   Step 2 — Feed the new price into the swing machine:
//     a) If no active swing exists → create a new one with the current price
//        as both swing_low and swing_high (single-price seed).
//
//     b) If an active swing exists:
//        • Update current_price always.
//        • Track min_price_after_high: lowest price seen AFTER the swing_high.
//          If this drops far enough below swing_high → potential bearish reversal.
//        • Track max_price_after_low: highest price seen AFTER the swing_low.
//          If this rises far enough above swing_low → potential bullish continuation.
//
//        • If new price > swing_high → extend swing_high (bullish continuation).
//        • If new price < swing_low  → extend swing_low  (bearish continuation).
//
//        • REVERSAL CHECK:
//          If price has fallen SWING_REVERSAL_PCT% from swing_high
//          AND swing range is at least MIN_SWING_RANGE_PCT% of price
//          → mark current swing COMPLETED, start new BEARISH swing.
//
//          If price has risen SWING_REVERSAL_PCT% from swing_low
//          AND swing range is meaningful
//          → mark current swing COMPLETED, start new BULLISH swing.
//
//   Step 3 — Return the (updated or new) active swing for signal evaluation.
//
// CONFIGURATION (tune these to match KSE volatility):
//   SWING_REVERSAL_PCT   — how much price must retrace from extreme to flip swing (default 2%)
//   MIN_SWING_RANGE_PCT  — minimum swing range as % of price to be meaningful (default 0.5%)
//   MIN_TICKS_TO_CONFIRM — minimum ticks before a swing can be reversed (default 2)

'use strict';

const { parsePrice } = require('@trading/shared/src/normalization/parsePrice');

// ─── Tunable parameters ───────────────────────────────────────────────────────
const SWING_REVERSAL_PCT   = parseFloat(process.env.SWING_REVERSAL_PCT   || '2.0');
const MIN_SWING_RANGE_PCT  = parseFloat(process.env.MIN_SWING_RANGE_PCT  || '0.5');
const MIN_TICKS_TO_CONFIRM = parseInt(process.env.MIN_TICKS_TO_CONFIRM   || '2', 10);

// ─────────────────────────────────────────────────────────────────────────────
// loadActiveSwing
// Fetch the current ACTIVE swing for a symbol from the DB.
// Returns null if none exists.
// ─────────────────────────────────────────────────────────────────────────────
async function loadActiveSwing(pool, symbol) {
    const { rows } = await pool.query(
        `SELECT *
         FROM   public.fibonacci_swings
         WHERE  symbol = $1
           AND  status = 'ACTIVE'
         ORDER  BY created_at DESC
         LIMIT  1`,
        [symbol]
    );
    return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// createSwing
// Inserts a brand-new ACTIVE swing row.
// Called when: (a) no swing exists, (b) a reversal is confirmed.
// ─────────────────────────────────────────────────────────────────────────────
async function createSwing(pool, symbol, price, trendDirection, openPrice = null) {
    const now = new Date();
    const { rows } = await pool.query(
        `INSERT INTO public.fibonacci_swings
           (symbol, swing_low, swing_high, current_price, open_price,
            min_price_after_high, max_price_after_low,
            trend_direction, status,
            swing_low_at, swing_high_at,
            tick_count, confirmed_ticks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9, $10, 1, 0)
         RETURNING *`,
        [
            symbol,
            price,          // swing_low  = current price (seed)
            price,          // swing_high = current price (seed)
            price,          // current_price
            openPrice ?? price,
            price,          // min_price_after_high = price (nothing seen yet)
            price,          // max_price_after_low  = price (nothing seen yet)
            trendDirection, // BULLISH | BEARISH
            now,            // swing_low_at
            now,            // swing_high_at
        ]
    );
    return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// markSwingCompleted
// Marks the swing as COMPLETED (price reversed past the threshold).
// ─────────────────────────────────────────────────────────────────────────────
async function markSwingCompleted(pool, swingId) {
    await pool.query(
        `UPDATE public.fibonacci_swings
         SET    status = 'COMPLETED'
         WHERE  id     = $1`,
        [swingId]
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// updateSwing
// Updates an existing ACTIVE swing with the new price tick.
// Returns the updated row.
// ─────────────────────────────────────────────────────────────────────────────
async function updateSwing(pool, swing, price) {
    const now = new Date();

    let {
        swing_low, swing_high,
        swing_low_at, swing_high_at,
        min_price_after_high, max_price_after_low,
        tick_count, confirmed_ticks,
    } = swing;

    // Cast DB numeric strings to JS numbers
    swing_low            = parseFloat(swing_low);
    swing_high           = parseFloat(swing_high);
    min_price_after_high = parseFloat(min_price_after_high);
    max_price_after_low  = parseFloat(max_price_after_low);

    // ── Extend swing extremes if price breaks out ─────────────────────────────
    if (price > swing_high) {
        swing_high     = price;
        swing_high_at  = now;
    }
    if (price < swing_low) {
        swing_low    = price;
        swing_low_at = now;
    }

    // ── Track price extremes AFTER the anchor point ───────────────────────────
    // min_price_after_high: lowest price seen since the swing_high was set
    //   Used to detect bearish reversal (price fell X% from high)
    if (price < min_price_after_high) {
        min_price_after_high = price;
    }

    // max_price_after_low: highest price seen since the swing_low was set
    //   Used to detect bullish continuation/reversal
    if (price > max_price_after_low) {
        max_price_after_low = price;
    }

    tick_count++;
    confirmed_ticks++;

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
           confirmed_ticks      = $9
         WHERE id = $10
         RETURNING *`,
        [
            price,
            swing_low,    swing_high,
            swing_low_at, swing_high_at,
            min_price_after_high,
            max_price_after_low,
            tick_count,
            confirmed_ticks,
            swing.id,
        ]
    );

    return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// shouldReverseSwing
// Decides whether the current swing should be flipped.
//
// BEARISH REVERSAL (from BULLISH swing):
//   Price has dropped SWING_REVERSAL_PCT% from swing_high
//   AND the swing range is >= MIN_SWING_RANGE_PCT% of swing_high
//   AND we have seen enough ticks to confirm it's not a spike
//
// BULLISH REVERSAL (from BEARISH swing):
//   Price has risen SWING_REVERSAL_PCT% from swing_low
//   AND same range/tick guards
// ─────────────────────────────────────────────────────────────────────────────
function shouldReverseSwing(swing, currentPrice) {
    const high      = parseFloat(swing.swing_high);
    const low       = parseFloat(swing.swing_low);
    const range     = high - low;
    const ticks     = parseInt(swing.tick_count, 10);

    // Not enough data yet
    if (ticks < MIN_TICKS_TO_CONFIRM) {
        return { reverse: false };
    }

    // Swing range must be meaningful (avoid noise on flat/illiquid stocks)
    const rangePct = (range / high) * 100;
    if (rangePct < MIN_SWING_RANGE_PCT) {
        return { reverse: false };
    }

    // ── BEARISH reversal: price dropped from swing_high ─────────────────────
    const dropFromHigh = ((high - currentPrice) / high) * 100;
    if (dropFromHigh >= SWING_REVERSAL_PCT) {
        return { reverse: true, newDirection: 'BEARISH' };
    }

    // ── BULLISH reversal: price rose from swing_low ──────────────────────────
    const riseFromLow = ((currentPrice - low) / low) * 100;
    if (riseFromLow >= SWING_REVERSAL_PCT && swing.trend_direction === 'BEARISH') {
        return { reverse: true, newDirection: 'BULLISH' };
    }

    return { reverse: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// processSwing — MAIN ENTRY POINT
//
// Called once per symbol per tick (from the fib processor).
// Returns the current active swing row after all updates.
//
// @param {Pool}   pool
// @param {string} symbol
// @param {number} currentPrice   — already parsed float
// @param {number} [openPrice]    — first price of the session (for reference)
// @returns {object}  DB row from fibonacci_swings
// ─────────────────────────────────────────────────────────────────────────────
async function processSwing(pool, symbol, currentPrice, openPrice = null) {

    // 1. Load existing active swing
    let swing = await loadActiveSwing(pool, symbol);

    // 2. No swing yet → seed a new BULLISH one (we'll update direction as data comes in)
    if (!swing) {
        console.log(`[swing] New swing seeded for ${symbol} @ ${currentPrice}`);
        return createSwing(pool, symbol, currentPrice, 'BULLISH', openPrice);
    }

    // 3. Check for reversal before updating
    const { reverse, newDirection } = shouldReverseSwing(swing, currentPrice);

    if (reverse) {
        console.log(
            `[swing] REVERSAL ${swing.trend_direction} → ${newDirection} | ` +
            `${symbol} | was [${swing.swing_low} – ${swing.swing_high}] | ` +
            `now @ ${currentPrice}`
        );

        // Mark the old swing completed
        await markSwingCompleted(pool, swing.id);

        // Start a new swing from the old swing's extreme point
        // New swing_low/high seed = current price (will update immediately below)
        return createSwing(pool, symbol, currentPrice, newDirection, openPrice);
    }

    // 4. No reversal → update the existing swing with the new price
    return updateSwing(pool, swing, currentPrice);
}

module.exports = {
    processSwing,
    loadActiveSwing,
    createSwing,
    markSwingCompleted,
};