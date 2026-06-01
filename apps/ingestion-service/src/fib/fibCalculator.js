// apps/ingestion-service/src/fib/fibCalculator.js
// ─────────────────────────────────────────────────────────────────────────────
// FIBONACCI LEVEL CALCULATOR
// ─────────────────────────────────────────────────────────────────────────────
//
// Unlike the standard fixed set (23.6, 38.2, 50, 61.8…), YOUR system uses
// fully user-defined percentages stored in fibonacci_levels per symbol.
// e.g. Stock ABC: [22, 45, 53, 78, 98]
//      Stock XYZ: [10, 30, 70]
//
// FORMULA
//   For a BULLISH swing (price went UP, now retracing DOWN):
//     level_price = swing_high − (swing_high − swing_low) × (pct / 100)
//
//     pct = 0   → at swing_high   (top of move, resistance)
//     pct = 100 → at swing_low    (full retracement, support)
//     pct = 50  → midpoint
//
//   For a BEARISH swing (price went DOWN, levels measured from low):
//     level_price = swing_low + (swing_high − swing_low) × (pct / 100)
//
//     pct = 0   → at swing_low    (bottom of drop)
//     pct = 100 → at swing_high   (full recovery)
//
// TOLERANCE
//   When checking if current_price "touches" a level, we allow a small band.
//   Default: ±TOUCH_TOLERANCE_PCT% of the level price.
//   This is configurable via TOUCH_TOLERANCE_PCT env var.

'use strict';

const TOUCH_TOLERANCE_PCT = parseFloat(process.env.TOUCH_TOLERANCE_PCT || '0.5');

// ─────────────────────────────────────────────────────────────────────────────
// loadUserFibLevels
// Fetches the user-defined fib levels for a symbol from fibonacci_levels table.
// Returns an array ordered by level_percent ASC.
// ─────────────────────────────────────────────────────────────────────────────
async function loadUserFibLevels(pool, symbol) {
    const { rows } = await pool.query(
        `SELECT id, symbol, level_percent, level_price, trend_direction
         FROM   public.fibonacci_levels
         WHERE  symbol     = $1
           AND  is_active  = true
           AND  is_deleted = false
         ORDER  BY level_percent ASC`,
        [symbol]
    );
    return rows; // may be empty if user hasn't configured this symbol
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateLevelPrices
// Given swing_low, swing_high, trend_direction, and an array of user fib rows,
// returns enriched array with computed level_price for each %.
//
// @param {number}   swingLow
// @param {number}   swingHigh
// @param {string}   trendDirection  — 'BULLISH' | 'BEARISH'
// @param {object[]} fibRows         — rows from fibonacci_levels (have level_percent)
// @returns {object[]}               — fibRows enriched with computed_price
// ─────────────────────────────────────────────────────────────────────────────
function calculateLevelPrices(swingLow, swingHigh, trendDirection, fibRows) {
    const range = swingHigh - swingLow;

    if (range <= 0) return [];

    return fibRows.map(row => {
        const pct   = parseFloat(row.level_percent);
        const ratio = pct / 100;

        let computedPrice;

        if (trendDirection === 'BULLISH') {
            // Retracement levels: measured DOWN from swing_high
            // pct=0 → swing_high (no retracement)
            // pct=100 → swing_low (full retracement)
            computedPrice = swingHigh - range * ratio;
        } else {
            // Bearish swing: recovery levels measured UP from swing_low
            // pct=0 → swing_low
            // pct=100 → swing_high
            computedPrice = swingLow + range * ratio;
        }

        return {
            ...row,
            computed_price: parseFloat(computedPrice.toFixed(3)),
            pct,
        };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// findTouchedLevels
// Checks which fib levels the current price is within tolerance of.
// Returns array sorted by proximity (closest first).
//
// @param {number}   currentPrice
// @param {object[]} levelsWithPrices — output of calculateLevelPrices()
// @param {number}   [tolerancePct]   — override the default tolerance
// @returns {object[]}  matched levels, each with deviationPct added
// ─────────────────────────────────────────────────────────────────────────────
function findTouchedLevels(currentPrice, levelsWithPrices, tolerancePct = TOUCH_TOLERANCE_PCT) {
    const band    = tolerancePct / 100;
    const touched = [];

    for (const level of levelsWithPrices) {
        const deviation = Math.abs(currentPrice - level.computed_price) / level.computed_price;

        if (deviation <= band) {
            touched.push({
                ...level,
                deviationPct: parseFloat((deviation * 100).toFixed(4)),
            });
        }
    }

    // Sort by closest first
    return touched.sort((a, b) => a.deviationPct - b.deviationPct);
}

// ─────────────────────────────────────────────────────────────────────────────
// classifySignalType
// Maps a fib level percentage to a signal type.
// Uses configurable thresholds — these come from the environment or defaults.
//
// These thresholds are applied REGARDLESS of what % the user chose.
// The user's custom %s are compared against these ranges.
//
// Strong buy zone: level_pct >= STRONG_BUY_FLOOR (default 55%)
//   i.e. price has retraced 55%+ of the move → strong support
// Buy zone: 35% – 55%
// Resistance zone: level_pct <= 25% (price near swing_high)
// ─────────────────────────────────────────────────────────────────────────────
const STRONG_BUY_FLOOR  = parseFloat(process.env.STRONG_BUY_FLOOR  || '55');
const BUY_FLOOR         = parseFloat(process.env.BUY_FLOOR         || '35');
const RESISTANCE_CEIL   = parseFloat(process.env.RESISTANCE_CEIL   || '25');

function classifySignalType(levelPct, trendDirection) {
    const pct = parseFloat(levelPct);

    if (trendDirection === 'BULLISH') {
        // In a bullish swing, high % = deep retracement = strong support
        if (pct >= STRONG_BUY_FLOOR) return { type: 'STRONG_BUY', strength: 5 };
        if (pct >= BUY_FLOOR)        return { type: 'BUY',         strength: 3 };
        if (pct <= RESISTANCE_CEIL)  return { type: 'RESISTANCE',  strength: 3 };
        return { type: 'TOUCH', strength: 2 };
    } else {
        // In a bearish swing, high % = price recovering = resistance
        if (pct >= STRONG_BUY_FLOOR) return { type: 'RESISTANCE',  strength: 3 };
        if (pct >= BUY_FLOOR)        return { type: 'TOUCH',        strength: 2 };
        if (pct <= RESISTANCE_CEIL)  return { type: 'WEAK',         strength: 4 };
        return { type: 'TOUCH', strength: 2 };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// computeAllLevels (convenience — load + calculate in one call)
// Returns enriched fib levels for a symbol's current swing.
// Returns [] if user hasn't defined any levels for this symbol.
// ─────────────────────────────────────────────────────────────────────────────
async function computeAllLevels(pool, symbol, swingLow, swingHigh, trendDirection) {
    const fibRows = await loadUserFibLevels(pool, symbol);

    if (fibRows.length === 0) {
        return []; // user hasn't set up fib levels for this symbol yet
    }

    return calculateLevelPrices(swingLow, swingHigh, trendDirection, fibRows);
}

module.exports = {
    loadUserFibLevels,
    calculateLevelPrices,
    findTouchedLevels,
    classifySignalType,
    computeAllLevels,
    TOUCH_TOLERANCE_PCT,
};