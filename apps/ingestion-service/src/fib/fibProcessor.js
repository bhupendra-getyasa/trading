// apps/ingestion-service/src/fib/fibProcessor.js
// ─────────────────────────────────────────────────────────────────────────────
// FIB PROCESSOR — orchestrates one tick through the full pipeline:
//   swingDetector → fibCalculator → bounceConfirmer → signalGenerator
//
// FIXES APPLIED
//   Fix 1 — swingHigh > swingLow guard moved BEFORE swingRange and
//            swingRangePct are computed.  Previously swingRange was
//            calculated first, so a freshly-seeded swing with equal
//            high/low produced 0/0 = NaN for swingRangePct, which
//            silently passed the range filter.
//
//   Fix 2 — trendDirection passed to upsertTouch so bounceConfirmer
//            can apply the correct direction-aware break detection
//            (support broken vs resistance broken).
//
//   Fix 3 — expireOldTouches + expireYesterdayTouches replaced by the
//            merged expireStaleTouches (single DB round-trip).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { parsePrice }                          = require('@trading/shared/src/normalization/parsePrice');
const { processSwing }                        = require('./swingDetector');
const { computeAllLevels, findTouchedLevels } = require('./fibCalculator');
const { processSignals }                      = require('./signalGenerator');
const {
    upsertTouch,
    isBounceConfirmed,
    markTouchConfirmed,
    expireStaleTouches,     // Fix 3: merged function replaces the old pair
} = require('./bounceConfirmer');

const SESSION_OPEN_UTC  = 6;
const SESSION_CLOSE_UTC = 10;

const MIN_SWING_RANGE_FOR_SIGNALS = parseFloat(process.env.MIN_SWING_RANGE_FOR_SIGNALS || '1.5');

function isSessionActive() {
    const h = new Date().getUTCHours();
    const d = new Date().getUTCDay();
    return d >= 0 && d <= 4 && h >= SESSION_OPEN_UTC && h < SESSION_CLOSE_UTC;
}

async function processOneTick(pool, stock) {
    const symbol        = stock.symbol;
    const lastPriceRaw  = stock.last_price    ?? stock.lastPrice    ?? '0';
    const companyName   = stock.company_name  ?? stock.companyName  ?? '';
    const changePercent = stock.change_percent ?? stock.changePercent ?? '0';

    const currentPrice = parsePrice(lastPriceRaw);
    if (!currentPrice || currentPrice <= 0) {
        return null;
    }

    // ── 1. Swing detection ────────────────────────────────────────────────────
    const { activeSwing, completedSwing } = await processSwing(pool, symbol, currentPrice);

    // ── 2. Choose which swing to evaluate fib levels on ──────────────────────
    //    If a reversal just fired, use the completedSwing (has the full range).
    //    Otherwise use the activeSwing (ongoing move).
    const evalSwing = completedSwing ?? activeSwing;

    const swingLow  = parseFloat(evalSwing.swing_low);
    const swingHigh = parseFloat(evalSwing.swing_high);

    // Fix 1: guard BEFORE arithmetic to avoid NaN on a freshly-seeded swing
    if (swingHigh <= swingLow) {
        return { swing: activeSwing, touchedLevels: [], signals: [] };
    }

    const swingRange    = swingHigh - swingLow;
    const swingRangePct = (swingRange / swingHigh) * 100;

    if (swingRangePct < MIN_SWING_RANGE_FOR_SIGNALS) {
        return { swing: activeSwing, touchedLevels: [], signals: [] };
    }

    // ── 3. Compute fib levels for this swing ─────────────────────────────────
    const levels = await computeAllLevels(
        pool, symbol, swingLow, swingHigh, evalSwing.trend_direction
    );

    if (levels.length === 0) {
        return { swing: activeSwing, touchedLevels: [], signals: [] };
    }

    // ── 4. Find which levels price is currently touching ─────────────────────
    const touchedLevels = findTouchedLevels(currentPrice, levels);

    if (touchedLevels.length === 0) {
        return { swing: activeSwing, touchedLevels: [], signals: [] };
    }

    // ── 5. Bounce confirmation gate ───────────────────────────────────────────
    const confirmedLevels = [];

    for (const level of touchedLevels) {
        const touch = await upsertTouch(pool, {
            symbol,
            swingId:       evalSwing.id,
            levelPercent:  level.level_percent,
            levelPrice:    level.computed_price,
            currentPrice,
            trendDirection: evalSwing.trend_direction,  // Fix 2: direction-aware expiry
        });

        if (!touch) {
            // null = price broke through the level (expired) OR already CONFIRMED (Fix 2)
            continue;
        }

        if (isBounceConfirmed(touch)) {
            // touch.status is guaranteed WATCHING here (CONFIRMED was caught above)
            await markTouchConfirmed(pool, touch.id);
            confirmedLevels.push(level);
        }
    }

    if (confirmedLevels.length === 0) {
        return { swing: activeSwing, touchedLevels, signals: [] };
    }

    // ── 6. Generate signals for confirmed bounces ─────────────────────────────
    const signals = await processSignals(
        pool,
        evalSwing,
        { symbol, companyName, changePercent, currentPrice },
        confirmedLevels
    );

    return { swing: activeSwing, touchedLevels, signals };
}

async function processBatch(pool, stocks) {
    // Fix 3: single DB round-trip instead of two
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
        errors:     [],
    };

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected') {
            summary.errors.push({ symbol: stocks[i]?.symbol, error: r.reason?.message });
            continue;
        }
        if (!r.value) continue;

        summary.processed++;
        const { touchedLevels, signals } = r.value;
        if (touchedLevels?.length > 0) summary.touched++;
        summary.signals += (signals?.length ?? 0);

        for (const s of (signals || [])) {
            if (s.signal_type === 'STRONG_BUY') summary.strongBuys.push(s.symbol);
        }
    }

    return summary;
}

module.exports = { processBatch, processOneTick, isSessionActive };