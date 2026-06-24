// apps/ingestion-service/src/fib/fibCalculator.js
// ─────────────────────────────────────────────────────────────────────────────
// FIBONACCI LEVEL CALCULATOR — EARLY-ENTRY REWRITE
// ─────────────────────────────────────────────────────────────────────────────
//
// ROOT CAUSE OF LATE SIGNALS:
//   The old code commented out the original Fibonacci Retracement strategy
//   and replaced it with a "breakout" path (Path B) that only fires when
//   price has ALREADY cleared a fib level from below.  That means by the time
//   the EARLY_BUY fires, price has already risen from the swing low through
//   the 38.2% recovery level — the "early" entry is already 38% of the move
//   into the trade.
//
// NEW STRATEGY — THREE ZONES:
//
//   ZONE 1 — RETRACEMENT SUPPORT (highest priority, earliest entry):
//     On a BULLISH swing, price retraces DOWN to a key fib level (38.2%,
//     50%, 61.8%).  We generate a BUY signal when price touches and holds
//     that level.  Entry is at the BOTTOM of the retracement — before any
//     upward move.
//
//   ZONE 2 — ANTICIPATORY ENTRY (new):
//     When price is within a PRE_ENTRY_ZONE_PCT band ABOVE a key fib support
//     level (not yet touching it, but approaching it), generate an
//     EARLY_BUY signal so the trader can place a limit order at the level
//     before price arrives.  This is the earliest possible signal.
//
//   ZONE 3 — BREAKOUT CONFIRMATION (kept, but de-prioritised):
//     When price breaks ABOVE the previous swing high after a confirmed
//     BEARISH → BULLISH reversal, generate a STRONG_BUY.  This is the
//     latest signal but the highest-conviction.
//
// FORMULA (unchanged):
//   BULLISH retracement: level_price = high − (high − low) × ratio
//   BEARISH recovery:    level_price = low  + (high − low) × ratio
//
// TOLERANCE CHANGES:
//   TOUCH_TOLERANCE_PCT raised 0.3% → 0.5% so approaching price is caught
//   slightly earlier (before it reaches the exact level).
//   PRE_ENTRY_ZONE_PCT = 1.5% above the level — the anticipatory zone.
//   BREAKOUT_TOLERANCE_PCT unchanged at 0.5%.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// CHANGED: raised 0.3 → 0.5 so price is caught slightly before touching level
const TOUCH_TOLERANCE_PCT    = parseFloat(process.env.TOUCH_TOLERANCE_PCT    || '0.5');
const MIN_ABSOLUTE_BAND      = parseFloat(process.env.MIN_ABSOLUTE_BAND      || '0.1');
const BREAKOUT_TOLERANCE_PCT = parseFloat(process.env.BREAKOUT_TOLERANCE_PCT || '0.5');

// NEW: anticipatory zone — how far ABOVE a support level we start watching
// for an approaching price.  1.5% means "price is 1.5% above the fib level
// and falling toward it — alert the trader now".
const PRE_ENTRY_ZONE_PCT = parseFloat(process.env.PRE_ENTRY_ZONE_PCT || '1.5');

// ─── Cache ────────────────────────────────────────────────────────────────────
const fibLevelsCache   = new Map();
const FIB_CACHE_TTL_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// loadUserFibLevels
// ─────────────────────────────────────────────────────────────────────────────
async function loadUserFibLevels(pool, symbol) {
    const cached = fibLevelsCache.get(symbol);
    if (cached && (Date.now() - cached.loadedAt) < FIB_CACHE_TTL_MS) return cached.rows;

    const { rows } = await pool.query(
        `SELECT fl.id,
                fl.symbol,
                fl.level_percent,
                fl.level_price,
                fl.trend_direction,
                fst.signal_code  AS type,
                fst.display_name AS type_label,
                fst.strength
         FROM   public.fibonacci_levels fl
         LEFT JOIN fibonacci_signal_types fst ON fst.id = fl.signal_id
         WHERE  fl.symbol     = $1
           AND  fl.is_active  = true
           AND  fl.is_deleted = false
         ORDER  BY fl.symbol, fl.level_percent ASC`,
        [symbol]
    );

    fibLevelsCache.set(symbol, { rows, loadedAt: Date.now() });
    return rows;
}

function invalidateFibCache(symbol = null) {
    if (symbol) fibLevelsCache.delete(symbol);
    else        fibLevelsCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateLevelPrices
// ─────────────────────────────────────────────────────────────────────────────
function calculateLevelPrices(swingLow, swingHigh, trendDirection, fibRows) {
    const range = swingHigh - swingLow;
    if (range <= 0) return [];

    return fibRows.map(row => {
        const ratio = parseFloat(row.level_percent);
        const pct   = ratio * 100;
        const computedPrice = trendDirection === 'BULLISH'
            ? swingHigh - range * ratio    // retracement DOWN from high
            : swingLow  + range * ratio;   // recovery UP from low

        return { ...row, computed_price: parseFloat(computedPrice.toFixed(3)), pct };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// findTouchedLevels  — ZONE 1 (retracement support)
// Price is AT or within TOUCH_TOLERANCE_PCT of the fib level.
// CHANGED: tolerance raised 0.3% → 0.5% for earlier detection.
// ─────────────────────────────────────────────────────────────────────────────
function findTouchedLevels(currentPrice, levelsWithPrices, tolerancePct = TOUCH_TOLERANCE_PCT) {
    const touched = [];
    for (const level of levelsWithPrices) {
        const deviation     = Math.abs(currentPrice - level.computed_price);
        const pctBand       = level.computed_price * (tolerancePct / 100);
        const effectiveBand = Math.max(pctBand, MIN_ABSOLUTE_BAND);

        if (deviation <= effectiveBand) {
            touched.push({
                ...level,
                deviationPct: parseFloat(((deviation / level.computed_price) * 100).toFixed(4)),
                zone: 'TOUCH',
            });
        }
    }
    return touched.sort((a, b) => a.deviationPct - b.deviationPct);
}

// ─────────────────────────────────────────────────────────────────────────────
// findApproachingLevels  — ZONE 2 (NEW: anticipatory / pre-entry)
//
// Returns fib levels that price is APPROACHING FROM ABOVE (on a BULLISH swing
// retracement).  The trader gets an alert BEFORE price reaches the level so
// they can place a limit order at the exact fib price.
//
// A level is "approaching" when:
//   level_price < currentPrice ≤ level_price × (1 + PRE_ENTRY_ZONE_PCT/100)
//
// Only fires on BULLISH swing retracements (price heading down toward support).
// On BEARISH swings the price is heading UP so there is no "approaching
// from above" — use findTouchedLevels instead.
//
// Returns levels sorted by proximity (closest first).
// ─────────────────────────────────────────────────────────────────────────────
function findApproachingLevels(currentPrice, levelsWithPrices, trendDirection) {
    // Only meaningful when price is falling toward fib support
    if (trendDirection !== 'BULLISH') return [];

    const approaching = [];
    for (const level of levelsWithPrices) {
        const lp = level.computed_price;
        if (lp <= 0) continue;

        // Price must be ABOVE the level (hasn't touched yet)
        // AND within PRE_ENTRY_ZONE_PCT% above it
        const zoneTop = lp * (1 + PRE_ENTRY_ZONE_PCT / 100);
        if (currentPrice > lp && currentPrice <= zoneTop) {
            const distancePct = ((currentPrice - lp) / lp) * 100;
            approaching.push({
                ...level,
                deviationPct: parseFloat(distancePct.toFixed(4)),
                zone: 'APPROACHING',
            });
        }
    }
    return approaching.sort((a, b) => a.deviationPct - b.deviationPct);
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateBreakoutTargets  — ZONE 3 (breakout, kept)
// ─────────────────────────────────────────────────────────────────────────────
function calculateBreakoutTargets(swingLow, swingHigh, fibRows) {
    return calculateLevelPrices(swingLow, swingHigh, 'BEARISH', fibRows);
}

// ─────────────────────────────────────────────────────────────────────────────
// findBreakoutLevels  — ZONE 3
// ─────────────────────────────────────────────────────────────────────────────
function findBreakoutLevels(currentPrice, levelsWithPrices, tolerancePct = BREAKOUT_TOLERANCE_PCT) {
    const broken = [];
    for (const level of levelsWithPrices) {
        if (currentPrice <= level.computed_price) continue;
        const overshoot     = currentPrice - level.computed_price;
        const pctBand       = level.computed_price * (tolerancePct / 100);
        const effectiveBand = Math.max(pctBand, MIN_ABSOLUTE_BAND);
        if (overshoot <= effectiveBand) {
            broken.push({
                ...level,
                deviationPct: parseFloat(((overshoot / level.computed_price) * 100).toFixed(4)),
                zone: 'BREAKOUT',
            });
        }
    }
    return broken.sort((a, b) => a.deviationPct - b.deviationPct);
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience wrappers
// ─────────────────────────────────────────────────────────────────────────────
async function computeAllLevels(pool, symbol, swingLow, swingHigh, trendDirection) {
    const fibRows = await loadUserFibLevels(pool, symbol);
    if (fibRows.length === 0) return [];
    return calculateLevelPrices(swingLow, swingHigh, trendDirection, fibRows);
}

async function computeBreakoutLevels(pool, symbol, completedBearishSwing) {
    const fibRows = await loadUserFibLevels(pool, symbol);
    if (fibRows.length === 0) return [];
    return calculateBreakoutTargets(
        parseFloat(completedBearishSwing.swing_low),
        parseFloat(completedBearishSwing.swing_high),
        fibRows
    );
}

module.exports = {
    loadUserFibLevels,
    calculateLevelPrices,
    findTouchedLevels,
    findApproachingLevels,     // NEW: Zone 2 — anticipatory entry
    computeAllLevels,
    invalidateFibCache,
    TOUCH_TOLERANCE_PCT,
    PRE_ENTRY_ZONE_PCT,        // exported so fibProcessor can log it
    calculateBreakoutTargets,
    findBreakoutLevels,
    computeBreakoutLevels,
    BREAKOUT_TOLERANCE_PCT,
};
