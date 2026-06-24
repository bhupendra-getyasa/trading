// apps/ingestion-service/src/fib/fibProcessor.js
// ─────────────────────────────────────────────────────────────────────────────
// FIB PROCESSOR — THREE-ZONE EARLY-ENTRY REWRITE
// ─────────────────────────────────────────────────────────────────────────────
//
// The original two-path design (PATH A retracement + PATH B breakout) is
// COMMENTED OUT below.  The new design uses three independent zones that fire
// at progressively earlier stages of the trade setup.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ ORIGINAL PATHS (commented out)                                           │
// │                                                                          │
// │ PATH A — Retracement:                                                    │
// │   Price touches fib level → bounceConfirmer waits 2 ticks at level      │
// │   → waits 2 more rising ticks → signal fires.                           │
// │   Problem: 4 minutes after the LOW. Stock already moved 2-3%.           │
// │                                                                          │
// │ PATH B — Breakout:                                                       │
// │   Price reverses from BEARISH→BULLISH (after 3 confirm ticks = 3 min)   │
// │   → must CLEAR a fib level upward → signal fires.                       │
// │   Problem: 5-8 minutes after the LOW. Major move already happened.      │
// └──────────────────────────────────────────────────────────────────────────┘
//
// NEW THREE-ZONE DESIGN:
//
// ┌─ ZONE 1 — RETRACEMENT TOUCH (existing, faster) ────────────────────────┐
// │  On a BULLISH swing, price retraces DOWN to a key fib level.           │
// │  Signal fires after 1 tick at the level + 1 rising tick (was 2+2).     │
// │  Signal type: BUY / STRONG_BUY (from DB signal_types)                  │
// │  Entry: AT the fib support level.                                       │
// │  Timing: 2 ticks (2 min) after price reaches the level.                │
// └─────────────────────────────────────────────────────────────────────────┘
//
// ┌─ ZONE 2 — ANTICIPATORY (new, earliest entry) ───────────────────────────┐
// │  On a BULLISH swing retracement, price is APPROACHING a fib level       │
// │  from above (within 1.5%).                                              │
// │  Signal fires IMMEDIATELY — no bounce wait.                             │
// │  Signal type: EARLY_BUY, approachDirection: APPROACHING                 │
// │  Entry: ABOVE the level — trader places a limit order at the fib price. │
// │  Timing: BEFORE the level is touched.                                   │
// └─────────────────────────────────────────────────────────────────────────┘
//
// ┌─ ZONE 3 — BREAKOUT CONFIRMATION (existing, kept as high-conviction) ────┐
// │  After a BEARISH→BULLISH reversal, price breaks above a fib level.     │
// │  Signal fires after 1 tick above the level (was 2).                    │
// │  Signal type: STRONG_BUY, approachDirection: BREAKOUT_UP               │
// │  Entry: just above the level on a genuine breakout.                    │
// │  Timing: 3-4 ticks after the swing low (improved from 6-8).            │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Zones are independent. All three can fire for the same symbol on the same
// session:  Zone 2 fires first (anticipatory), Zone 1 fires at the level,
// Zone 3 fires on the upside breakout. Different signal types and cooldowns
// prevent duplicate alerts.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { parsePrice }                          = require('@trading/shared/src/normalization/parsePrice');
const { processSwing, isCompletedSwingMeaningful } = require('./swingDetector');
const {
    computeAllLevels,
    findTouchedLevels,
    findApproachingLevels,     // NEW: Zone 2
    computeBreakoutLevels,
    findBreakoutLevels,
    PRE_ENTRY_ZONE_PCT,
} = require('./fibCalculator');
const { processSignals } = require('./signalGenerator');
const {
    upsertTouch,
    isBounceConfirmed,
    upsertApproachTouch,      // NEW: Zone 2
    isApproachConfirmed,      // NEW: Zone 2
    upsertBreakoutTouch,
    isMomentumConfirmed,
    markTouchConfirmed,
    expireStaleTouches,
} = require('./bounceConfirmer');

const SESSION_OPEN_UTC  = 6;
const SESSION_CLOSE_UTC = 10;

// Zone 1 / Zone 3 minimum swing range (unchanged)
const MIN_SWING_RANGE_FOR_SIGNALS          = parseFloat(process.env.MIN_SWING_RANGE_FOR_SIGNALS          || '1.5');
// Zone 3 requires a larger swing (unchanged, higher bar for breakout path)
const MIN_SWING_RANGE_FOR_BREAKOUT_SIGNALS = parseFloat(process.env.MIN_SWING_RANGE_FOR_BREAKOUT_SIGNALS || '2.5');
// Zone 2: anticipatory signals only need a moderate swing (lower bar because
// we're alerting BEFORE the level is reached — the swing is still forming)
const MIN_SWING_RANGE_FOR_APPROACH_SIGNALS = parseFloat(process.env.MIN_SWING_RANGE_FOR_APPROACH_SIGNALS || '1.0');

function isSessionActive() {
    const h = new Date().getUTCHours();
    const d = new Date().getUTCDay();
    return d >= 0 && d <= 4 && h >= SESSION_OPEN_UTC && h < SESSION_CLOSE_UTC;
}

// ─────────────────────────────────────────────────────────────────────────────
// _runZone1  — RETRACEMENT TOUCH (faster confirmation)
//
// CHANGES vs original _runRetracementPath:
//   - Same logic, but bounceConfirmer now fires after 1+1 ticks (was 2+2).
//   - No structural change here — the speed improvement comes from
//     bounceConfirmer.js constant changes.
// ─────────────────────────────────────────────────────────────────────────────
async function _runZone1(pool, evalSwing, currentPrice, stockRow) {
    const swingLow  = parseFloat(evalSwing.swing_low);
    const swingHigh = parseFloat(evalSwing.swing_high);
    if (swingHigh <= swingLow) return { touchedLevels: [], signals: [] };

    const swingRangePct = ((swingHigh - swingLow) / swingHigh) * 100;
    if (swingRangePct < MIN_SWING_RANGE_FOR_SIGNALS) return { touchedLevels: [], signals: [] };

    const levels = await computeAllLevels(pool, stockRow.symbol, swingLow, swingHigh, evalSwing.trend_direction);
    if (levels.length === 0) return { touchedLevels: [], signals: [] };

    const touchedLevels = findTouchedLevels(currentPrice, levels);
    if (touchedLevels.length === 0) return { touchedLevels: [], signals: [] };

    const confirmedLevels = [];
    for (const level of touchedLevels) {
        const touch = await upsertTouch(pool, {
            symbol: stockRow.symbol, swingId: evalSwing.id,
            levelPercent: level.level_percent, levelPrice: level.computed_price,
            currentPrice, trendDirection: evalSwing.trend_direction,
        });
        if (!touch) continue;
        if (isBounceConfirmed(touch)) {
            await markTouchConfirmed(pool, touch.id);
            confirmedLevels.push(level);
        }
    }

    if (confirmedLevels.length === 0) return { touchedLevels, signals: [] };

    const signals = await processSignals(pool, evalSwing, { ...stockRow, currentPrice }, confirmedLevels);
    return { touchedLevels, signals };
}

// ─────────────────────────────────────────────────────────────────────────────
// _runZone2 — ANTICIPATORY ENTRY (NEW)
//
// Fires BEFORE price reaches the fib level.  Only active on BULLISH swing
// retracements where price is heading DOWN toward support.
//
// Pipeline:
//   1. Compute fib levels for the active BULLISH swing.
//   2. findApproachingLevels: price is within PRE_ENTRY_ZONE_PCT% above level.
//   3. upsertApproachTouch: create/update approach touch record.
//   4. isApproachConfirmed: fires on the FIRST tick in the zone.
//   5. processSignals with signalType=EARLY_BUY, approachDirection=APPROACHING.
//
// The signal tells the trader: "Price is 1.5% above the 38.2% fib support.
// Place your limit buy order at [level_price] now."
// ─────────────────────────────────────────────────────────────────────────────
async function _runZone2(pool, activeSwing, currentPrice, stockRow) {
    // Zone 2 only fires on BULLISH swings (price retracing DOWN toward support)
    if (activeSwing.trend_direction !== 'BULLISH') return { approachLevels: [], signals: [] };

    const swingLow  = parseFloat(activeSwing.swing_low);
    const swingHigh = parseFloat(activeSwing.swing_high);
    if (swingHigh <= swingLow) return { approachLevels: [], signals: [] };

    const swingRangePct = ((swingHigh - swingLow) / swingHigh) * 100;
    if (swingRangePct < MIN_SWING_RANGE_FOR_APPROACH_SIGNALS) return { approachLevels: [], signals: [] };

    const levels = await computeAllLevels(pool, stockRow.symbol, swingLow, swingHigh, 'BULLISH');
    if (levels.length === 0) return { approachLevels: [], signals: [] };

    // findApproachingLevels only returns levels that price is approaching FROM ABOVE
    const approachLevels = findApproachingLevels(currentPrice, levels, 'BULLISH');
    if (approachLevels.length === 0) return { approachLevels: [], signals: [] };

    const confirmedApproachLevels = [];
    for (const level of approachLevels) {
        const touch = await upsertApproachTouch(pool, {
            symbol:       stockRow.symbol,
            swingId:      activeSwing.id,
            levelPercent: level.level_percent,
            levelPrice:   level.computed_price,
            currentPrice,
        });
        if (!touch) continue;

        // isApproachConfirmed fires on the first tick in the zone (touch_ticks >= 1)
        if (isApproachConfirmed(touch)) {
            await markTouchConfirmed(pool, touch.id);
            confirmedApproachLevels.push(level);
        }
    }

    if (confirmedApproachLevels.length === 0) return { approachLevels, signals: [] };

    const signals = await processSignals(
        pool, activeSwing, { ...stockRow, currentPrice }, confirmedApproachLevels,
        // BUG FIX: approachDirection was 'APPROACHING' which is NOT in the DB CHECK
        // constraint for fibonacci_signals.approach_direction.
        // The constraint allows: FROM_ABOVE | FROM_BELOW | BREAKOUT_UP
        // Zone 2 (anticipatory) fires while price is ABOVE the level heading down,
        // so FROM_ABOVE is the correct and constraint-compatible value.
        // The signal is still distinguishable by signal_type = 'EARLY_BUY'.
        { signalType: 'EARLY_BUY', approachDirection: 'FROM_ABOVE' }
    );

    return { approachLevels, signals };
}

// ─────────────────────────────────────────────────────────────────────────────
// _runZone3 — BREAKOUT CONFIRMATION (kept, faster)
//
// CHANGES vs original _runBreakoutPath:
//   - isMomentumConfirmed now requires 1+1 ticks (was 2+2) → fires ~2 min earlier.
//   - Everything else unchanged.
// ─────────────────────────────────────────────────────────────────────────────
async function _runZone3(pool, completedBearishSwing, activeSwing, currentPrice, stockRow) {
    if (!isCompletedSwingMeaningful(completedBearishSwing)) {
        console.log(`[zone3] Skipping ${stockRow.symbol} — completed swing too thin`);
        return { breakoutTouchedLevels: [], signals: [] };
    }

    const swingLow  = parseFloat(completedBearishSwing.swing_low);
    const swingHigh = parseFloat(completedBearishSwing.swing_high);
    if (swingHigh <= swingLow) return { breakoutTouchedLevels: [], signals: [] };

    const swingRangePct = ((swingHigh - swingLow) / swingHigh) * 100;
    if (swingRangePct < MIN_SWING_RANGE_FOR_BREAKOUT_SIGNALS) {
        console.log(`[zone3] Skipping ${stockRow.symbol} — range ${swingRangePct.toFixed(2)}% < threshold`);
        return { breakoutTouchedLevels: [], signals: [] };
    }

    const breakoutLevels = await computeBreakoutLevels(pool, stockRow.symbol, completedBearishSwing);
    if (breakoutLevels.length === 0) return { breakoutTouchedLevels: [], signals: [] };

    const breakoutTouchedLevels = findBreakoutLevels(currentPrice, breakoutLevels);
    if (breakoutTouchedLevels.length === 0) return { breakoutTouchedLevels: [], signals: [] };

    const confirmedBreakoutLevels = [];
    for (const level of breakoutTouchedLevels) {
        const touch = await upsertBreakoutTouch(pool, {
            symbol: stockRow.symbol, swingId: activeSwing.id,
            levelPercent: level.level_percent, levelPrice: level.computed_price, currentPrice,
        });
        if (!touch) continue;
        if (isMomentumConfirmed(touch)) {
            await markTouchConfirmed(pool, touch.id);
            confirmedBreakoutLevels.push(level);
        }
    }

    if (confirmedBreakoutLevels.length === 0) return { breakoutTouchedLevels, signals: [] };

    const signals = await processSignals(
        pool, activeSwing, { ...stockRow, currentPrice }, confirmedBreakoutLevels,
        { signalType: 'EARLY_BUY', approachDirection: 'BREAKOUT_UP' }
    );

    return { breakoutTouchedLevels, signals };
}

// ─────────────────────────────────────────────────────────────────────────────
// processOneTick — MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
async function processOneTick(pool, stock) {
    const symbol        = stock.symbol;
    const lastPriceRaw  = stock.last_price    ?? stock.lastPrice    ?? '0';
    const companyName   = stock.company_name  ?? stock.companyName  ?? '';
    const changePercent = stock.change_percent ?? stock.changePercent ?? '0';

    const currentPrice = parsePrice(lastPriceRaw);
    if (!currentPrice || currentPrice <= 0) return null;

    const stockRow = { symbol, companyName, changePercent };

    // ── 1. Swing detection ────────────────────────────────────────────────────
    const { activeSwing, completedSwing, reversalDirection } = await processSwing(
        pool, symbol, currentPrice
    );

    // BUG FIX: processSwing can return activeSwing=undefined when updateSwing's
    // UPDATE matches no rows (deleted/race-condition swing).  Guard here so the
    // three zone functions never receive undefined and crash on .swing_low.
    if (!activeSwing) {
        console.warn(`[processOneTick] ${symbol}: processSwing returned no activeSwing — skipping tick`);
        return null;
    }

    // ── 2. ZONE 1: Retracement touch (faster, 1+1 tick confirmation) ─────────
    // evalSwing: use completedSwing (full range) if a reversal just fired,
    // otherwise use activeSwing (ongoing move).
    const evalSwing = completedSwing ?? activeSwing;
    const { touchedLevels, signals: zone1Signals } = await _runZone1(
        pool, evalSwing, currentPrice, stockRow
    );

    // ── 3. ZONE 2: Anticipatory entry (NEW — fires before the level) ──────────
    // Runs on every tick for BULLISH swings, not just on reversal tick.
    const { approachLevels, signals: zone2Signals } = await _runZone2(
        pool, activeSwing, currentPrice, stockRow
    );

    // ── 4. ZONE 3: Breakout confirmation (faster, 1+1 tick confirmation) ─────
    let breakoutTouchedLevels = [], zone3Signals = [];
    if (reversalDirection === 'BULLISH' && completedSwing) {
        const result = await _runZone3(
            pool, completedSwing, activeSwing, currentPrice, stockRow
        );
        breakoutTouchedLevels = result.breakoutTouchedLevels;
        zone3Signals          = result.signals;
    }

    // ── 5. Merge ──────────────────────────────────────────────────────────────
    return {
        swing:                activeSwing,
        completedSwing,
        reversalDirection,
        touchedLevels:        [...touchedLevels, ...approachLevels, ...breakoutTouchedLevels],
        signals:              [...zone1Signals, ...zone2Signals, ...zone3Signals],
        // Per-zone for logging (parallel to original retracementSignals / breakoutSignals)
        zone1Signals,
        zone2Signals,
        zone3Signals,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// processBatch
// ─────────────────────────────────────────────────────────────────────────────
async function processBatch(pool, stocks) {
    await expireStaleTouches(pool);

    const results = await Promise.allSettled(
        stocks.map(stock => processOneTick(pool, stock))
    );

    const summary = {
        total:      stocks.length,
        processed:  0,
        touched:    0,
        signals:    0,
        strongBuys: [],
        earlyBuys:  [],
        errors:     [],
    };

    for (let i = 0; i < results.length; i++) {
        const r      = results[i];
        const symbol = stocks[i]?.symbol ?? '(unknown)';

        if (r.status === 'rejected') {
            const errMsg = r.reason?.message ?? String(r.reason);
            console.error(`[processBatch] ERROR for ${symbol}: ${errMsg}\n${r.reason?.stack ?? ''}`);
            summary.errors.push({ symbol, error: errMsg });
            continue;
        }
        if (!r.value) continue;

        summary.processed++;
        if (r.value.touchedLevels?.length > 0) summary.touched++;
        summary.signals += (r.value.signals?.length ?? 0);

        for (const s of (r.value.signals || [])) {
            if (s.signal_type === 'STRONG_BUY') summary.strongBuys.push(s.symbol);
            if (s.signal_type === 'EARLY_BUY')  summary.earlyBuys.push(s.symbol);
        }
    }

    if (summary.errors.length > 0) {
        console.error(`[processBatch] ${summary.errors.length}/${summary.total} symbols failed: ${summary.errors.map(e => e.symbol).join(', ')}`);
    }

    return summary;
}

module.exports = { processBatch, processOneTick, isSessionActive };
