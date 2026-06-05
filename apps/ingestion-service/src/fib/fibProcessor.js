'use strict';

const { parsePrice }                          = require('@trading/shared/src/normalization/parsePrice');
const { processSwing }                        = require('./swingDetector');
const { computeAllLevels, findTouchedLevels } = require('./fibCalculator');
const { processSignals }                      = require('./signalGenerator');
const {
    upsertTouch,
    isBounceConfirmed,
    markTouchConfirmed,
    expireOldTouches,
    expireYesterdayTouches
} = require('./bounceConfirmer');

const SESSION_OPEN_UTC  = 6;
const SESSION_CLOSE_UTC = 10;

function isSessionActive() {
    const h = new Date().getUTCHours();
    const d = new Date().getUTCDay();
    return d >= 0 && d <= 4 && h >= SESSION_OPEN_UTC && h < SESSION_CLOSE_UTC;
}

async function processOneTick(pool, stock) {
    const symbol       = stock.symbol;
    const lastPriceRaw = stock.last_price ?? stock.lastPrice ?? '0';
    const companyName  = stock.company_name ?? stock.companyName ?? '';
    const changePercent  = stock.change_percent ?? stock.changePercent ?? '0';

    const currentPrice = parsePrice(lastPriceRaw);
    if (!currentPrice || currentPrice <= 0) {
        console.warn(`[fib] Skipping ${symbol} — unparseable price: "${lastPriceRaw}"`);
        return null;
    }

    // 1. Process swing — may return a completedSwing if reversal just happened
    const { activeSwing, completedSwing } = await processSwing(pool, symbol, currentPrice);

    // 2. Decide WHICH swing to evaluate fib levels on:
    //    - If reversal just happened → use completedSwing (has the full range)
    //    - Otherwise → use activeSwing (ongoing move)
    const evalSwing = completedSwing ?? activeSwing;

    const swingLow  = parseFloat(evalSwing.swing_low);
    const swingHigh = parseFloat(evalSwing.swing_high);

    const swingRange = swingHigh - swingLow;
    const swingRangePct = (swingRange / swingHigh) * 100;

    const MIN_SWING_RANGE_FOR_SIGNALS = parseFloat(process.env.MIN_SWING_RANGE_FOR_SIGNALS || '1.5');

    if (swingHigh <= swingLow) {
        return { swing: activeSwing, touchedLevels: [], signals: [] };
    }

    if (swingRangePct < MIN_SWING_RANGE_FOR_SIGNALS) {
        console.log(`[fib] ${symbol} swing range ${swingRangePct.toFixed(2)}% too small — skipping`);
        return { swing: activeSwing, touchedLevels: [], signals: [] };
    }

    // 3. Compute fib levels on the relevant swing
    const levels = await computeAllLevels(
        pool, symbol, swingLow, swingHigh, evalSwing.trend_direction
    );

    if (levels.length === 0) {
        return { swing: activeSwing, touchedLevels: [], signals: [] };
    }

    const touchedLevels = findTouchedLevels(currentPrice, levels);

    if (touchedLevels.length === 0) {
        return { swing: activeSwing, touchedLevels: [], signals: [] };
    }

    console.log(
        `[fib] ${symbol} @ ${currentPrice} | ` +
        `swing [${swingLow}–${swingHigh}] ${evalSwing.trend_direction} | ` +
        `touched: ${touchedLevels.map(l => `${l.pct}%`).join(', ')}`
    );

    // 5. Bounce confirmation gate — only fire signal after price holds + bounces
    const confirmedLevels = [];

    for (const level of touchedLevels) {
        const touch = await upsertTouch(pool, {
            symbol,
            swingId:      evalSwing.id,   // reference the active (new) swing
            levelPercent: level.level_percent, // raw ratio e.g. 0.75
            levelPrice:   level.computed_price,
            currentPrice,
        });

        if (!touch) {
            // null = price broke below level, expired
            console.log(`[bounce] EXPIRED ${symbol} @ ${level.pct}% — broke below`);
            continue;
        }

        if (isBounceConfirmed(touch)) {
            if (touch.status !== 'CONFIRMED') {
                await markTouchConfirmed(pool, touch.id);
                confirmedLevels.push(level);
                console.log(
                    `[bounce] ✅ CONFIRMED ${symbol} @ ${level.pct}% | ` +
                    `touch_ticks: ${touch.touch_ticks} bounce_ticks: ${touch.bounce_ticks}`
                );
            } else {
                console.log(`[bounce] Already confirmed ${symbol} @ ${level.pct}% — skipping`);
            }
        } else {
            console.log(
                `[bounce] WATCHING ${symbol} @ ${level.pct}% | ` +
                `touch_ticks: ${touch.touch_ticks} bounce_ticks: ${touch.bounce_ticks} ` +
                `(need ${process.env.MIN_TOUCH_TICKS || 2} touch, ${process.env.MIN_BOUNCE_TICKS || 2} bounce)`
            );
        }
    }

    if (confirmedLevels.length === 0) {
        return { swing: activeSwing, touchedLevels, signals: [] };
    }

    // 6. Save signals + send WhatsApp — only for confirmed bounces
    const signals = await processSignals(
        pool,
        evalSwing,              // ← use the swing whose range was measured
        { symbol, companyName, changePercent },
        confirmedLevels
    );

    return { swing: activeSwing, touchedLevels, signals };
}

async function processBatch(pool, stocks) {
    await expireOldTouches(pool);
    await expireYesterdayTouches(pool);

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

    if (summary.strongBuys.length > 0) {
        console.log(`[fib] 🟢 STRONG BUY: ${summary.strongBuys.join(', ')}`);
    }

    console.log(
        `[fib] Batch done | processed: ${summary.processed} | ` +
        `touched: ${summary.touched} | signals: ${summary.signals} | ` +
        `errors: ${summary.errors.length}`
    );

    return summary;
}

module.exports = { processBatch, processOneTick, isSessionActive };