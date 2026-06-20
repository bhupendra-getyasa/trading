// apps/ingestion-service/src/fib/fibCalculator.js
// ─────────────────────────────────────────────────────────────────────────────
// FIBONACCI LEVEL CALCULATOR
// ─────────────────────────────────────────────────────────────────────────────
//
// Your system uses fully user-defined percentages stored in fibonacci_levels
// per symbol (e.g. Stock ABC: [0.22, 0.45, 0.78]).  The signal type and
// strength are stored alongside each level in fibonacci_signal_types and
// are loaded via the LEFT JOIN in loadUserFibLevels.
//
// FORMULA
//   BULLISH swing (price went UP, now retracing DOWN):
//     level_price = swing_high − (swing_high − swing_low) × ratio
//     ratio=0 → swing_high (no retracement / resistance)
//     ratio=1 → swing_low  (full retracement / deep support)
//
//   BEARISH swing (price went DOWN, levels measured from low):
//     level_price = swing_low + (swing_high − swing_low) × ratio
//     ratio=0 → swing_low  (bottom)
//     ratio=1 → swing_high (full recovery)
//
// TOLERANCE
//   findTouchedLevels uses a percentage band with a KWF-aware absolute floor
//   so cheap stocks get a meaningful minimum band width.
//
// FIXES APPLIED
//   Fix 1 — classifySignalType removed. It compared level_percent against
//            hard-coded standard fib thresholds (23.6, 38.2, 61.8, 78.6)
//            but the system uses arbitrary user-defined ratios, so the
//            classification was effectively random.  Signal type and strength
//            now come exclusively from the DB join (fst.display_name,
//            fst.strength) loaded in loadUserFibLevels.
//
//   Fix 2 — invalidateFibCache is now called automatically whenever the
//            admin endpoint or any write path updates fibonacci_levels.
//            The export is kept so external callers (admin routes, tests)
//            can still trigger it manually.
//
//   Fix 3 — loadUserFibLevels now selects fst.signal_code AS type instead
//            of fst.display_name AS type. signalGenerator.js writes this
//            value straight into fibonacci_signals.signal_type, which has
//            CHECK (signal_type = ANY ('STRONG_BUY','BUY','RESISTANCE',
//            'TARGET_HIT','WEAK','TOUCH')). display_name values ("Strong
//            Buy", "Buy", ...) never matched that constraint, so every
//            INSERT was rejected and no signal ever made it to the table —
//            silently, since processOneTick errors are swallowed by
//            Promise.allSettled in processBatch. display_name is still
//            exposed as type_label for UI/WhatsApp copy if needed.

'use strict';

const TOUCH_TOLERANCE_PCT = parseFloat(process.env.TOUCH_TOLERANCE_PCT || '0.3');
const MIN_ABSOLUTE_BAND   = parseFloat(process.env.MIN_ABSOLUTE_BAND   || '0.1'); // KWF floor

// ─── In-process cache ────────────────────────────────────────────────────────
const fibLevelsCache  = new Map();
const FIB_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─────────────────────────────────────────────────────────────────────────────
// loadUserFibLevels
// Fetches user-defined fib levels for a symbol, joined with signal type metadata.
// Results are cached for FIB_CACHE_TTL_MS to avoid a DB hit every tick.
//
// Fix 2: cache is invalidated immediately on any write to fibonacci_levels
// via invalidateFibCache() so stale levels are never served after an edit.
// ─────────────────────────────────────────────────────────────────────────────
async function loadUserFibLevels(pool, symbol) {
    const cached = fibLevelsCache.get(symbol);
    if (cached && (Date.now() - cached.loadedAt) < FIB_CACHE_TTL_MS) {
        return cached.rows;
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// invalidateFibCache
// Call this whenever fibonacci_levels rows are inserted, updated, or deleted
// so the next tick loads fresh data.  Pass symbol to invalidate one entry;
// omit it (or pass null) to clear the entire cache.
// ─────────────────────────────────────────────────────────────────────────────
function invalidateFibCache(symbol = null) {
    if (symbol) fibLevelsCache.delete(symbol);
    else        fibLevelsCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateLevelPrices
// Enriches fib rows with a computed_price for the given swing range.
//
// @param {number}   swingLow
// @param {number}   swingHigh
// @param {string}   trendDirection  — 'BULLISH' | 'BEARISH'
// @param {object[]} fibRows         — rows from fibonacci_levels (level_percent is 0–1)
// @returns {object[]}               — fibRows enriched with { computed_price, pct }
// ─────────────────────────────────────────────────────────────────────────────
function calculateLevelPrices(swingLow, swingHigh, trendDirection, fibRows) {
    const range = swingHigh - swingLow;
    if (range <= 0) return [];

    return fibRows.map(row => {
        // level_percent is stored as a ratio (0–1), e.g. 0.618 for 61.8%
        const ratio = parseFloat(row.level_percent);
        const pct   = ratio * 100;  // human-readable percentage for display only

        let computedPrice;
        if (trendDirection === 'BULLISH') {
            // Retracement DOWN from swing_high
            computedPrice = swingHigh - range * ratio;
        } else {
            // Recovery UP from swing_low
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
// Returns fib levels whose computed_price is within tolerance of currentPrice,
// sorted by proximity (closest first).
//
// Uses an absolute floor (MIN_ABSOLUTE_BAND) so cheap KWF stocks get a
// meaningful band even when the percentage band is tiny.
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
            });
        }
    }

    return touched.sort((a, b) => a.deviationPct - b.deviationPct);
}

// ─────────────────────────────────────────────────────────────────────────────
// computeAllLevels
// Convenience wrapper: load + calculate in one call.
// Returns [] if no fib levels are configured for this symbol.
// ─────────────────────────────────────────────────────────────────────────────
async function computeAllLevels(pool, symbol, swingLow, swingHigh, trendDirection) {
    const fibRows = await loadUserFibLevels(pool, symbol);
    if (fibRows.length === 0) return [];
    return calculateLevelPrices(swingLow, swingHigh, trendDirection, fibRows);
}

module.exports = {
    loadUserFibLevels,
    calculateLevelPrices,
    findTouchedLevels,
    computeAllLevels,
    invalidateFibCache,
    TOUCH_TOLERANCE_PCT,
};