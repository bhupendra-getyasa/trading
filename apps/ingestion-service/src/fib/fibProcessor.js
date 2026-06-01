// apps/ingestion-service/src/fib/fibProcessor.js
// ─────────────────────────────────────────────────────────────────────────────
// FIB PROCESSOR — orchestrates one symbol's full fib pipeline per tick
// ─────────────────────────────────────────────────────────────────────────────
//
// Called from ingestion-service/src/worker.js after stocks are inserted to DB.
//
// Per stock per tick:
//   1. Parse current price from scraped string (e.g. "3,078KWF" → 3078)
//   2. processSwing()      → update or create fibonacci_swings row
//   3. computeAllLevels()  → compute absolute price for each user fib%
//   4. findTouchedLevels() → which levels is current price near?
//   5. processSignals()    → save, broadcast, WhatsApp for each touch
//
// GUARD: Only runs when the market session is active (09:00–13:00 KWT)

'use strict';

const { parsePrice }         = require('@trading/shared/src/normalization/parsePrice');
const { processSwing }       = require('./swingDetector');
const { computeAllLevels, findTouchedLevels } = require('./fibCalculator');
const { processSignals }     = require('./signalGenerator');

// Kuwait session in UTC: 09:00 KWT = 06:00 UTC, 13:00 KWT = 10:00 UTC
const SESSION_OPEN_UTC  = 6;
const SESSION_CLOSE_UTC = 10;

function isSessionActive() {
    const h = new Date().getUTCHours();
    const d = new Date().getUTCDay(); // 0=Sun … 4=Thu
    return d <= 4 && h >= SESSION_OPEN_UTC && h < SESSION_CLOSE_UTC;
}

// ─────────────────────────────────────────────────────────────────────────────
// processOneTick — full pipeline for a single stock on a single tick
//
// @param {Pool}   pool
// @param {object} stock  — one row from market_stock_snapshots (snake_case from DB)
//                          OR camelCase from scraper (handled by normalising below)
// @returns {object|null}  { swing, touchedLevels, signals } or null if skipped
// ─────────────────────────────────────────────────────────────────────────────
async function processOneTick(pool, stock) {
    // Support both snake_case (DB row) and camelCase (scraper output)
    const symbol      = stock.symbol;
    const lastPriceRaw = stock.last_price ?? stock.lastPrice ?? '0';
    const companyName  = stock.company_name ?? stock.companyName ?? '';

    // 1. Parse current price
    const currentPrice = parsePrice(lastPriceRaw);
    if (!currentPrice || currentPrice <= 0) {
        console.warn(`[fib] Skipping ${symbol} — unparseable price: "${lastPriceRaw}"`);
        return null;
    }

    // 2. Update / create swing
    const swing = await processSwing(pool, symbol, currentPrice);

    const swingLow  = parseFloat(swing.swing_low);
    const swingHigh = parseFloat(swing.swing_high);

    // Need at least a minimal range before evaluating levels
    if (swingHigh <= swingLow) {
        return { swing, touchedLevels: [], signals: [] };
    }

    // 3. Compute user's fib levels → absolute prices for this swing
    const levels = await computeAllLevels(
        pool,
        symbol,
        swingLow,
        swingHigh,
        swing.trend_direction
    );

    if (levels.length === 0) {
        // User hasn't defined fib levels for this symbol yet
        return { swing, touchedLevels: [], signals: [] };
    }

    // 4. Find which levels the current price is touching
    const touchedLevels = findTouchedLevels(currentPrice, levels);

    if (touchedLevels.length === 0) {
        return { swing, touchedLevels: [], signals: [] };
    }

    console.log(
        `[fib] ${symbol} @ ${currentPrice} | ` +
        `swing [${swingLow}–${swingHigh}] ${swing.trend_direction} | ` +
        `touched: ${touchedLevels.map(l => `${l.pct}%`).join(', ')}`
    );

    // 5. Save signals + notify
    const signals = await processSignals(pool, swing, { symbol, companyName }, touchedLevels);

    return { swing, touchedLevels, signals };
}

// ─────────────────────────────────────────────────────────────────────────────
// processBatch — runs processOneTick for all 140 stocks concurrently
//
// Uses Promise.allSettled so one failing stock never blocks the other 139.
//
// @param {Pool}     pool
// @param {object[]} stocks   — array of stock rows (DB or scraper format)
// @returns {object}           summary stats
// ─────────────────────────────────────────────────────────────────────────────
async function processBatch(pool, stocks) {
    // if (!isSessionActive()) {
    //     console.log('[fib] Outside session window (09:00–13:00 KWT) — skipping batch');
    //     return { skipped: true };
    // }

    console.log(`[fib] Processing batch of ${stocks.length} stocks`);

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
            summary.errors.push({
                symbol: stocks[i]?.symbol,
                error:  r.reason?.message,
            });
            continue;
        }
        if (!r.value) continue;

        summary.processed++;

        const { touchedLevels, signals } = r.value;
        if (touchedLevels.length > 0) summary.touched++;
        summary.signals += (signals?.length ?? 0);

        const sb = (signals || []).filter(s => s.signal_type === 'STRONG_BUY');
        for (const s of sb) {
            summary.strongBuys.push(s.symbol);
        }
    }

    if (summary.strongBuys.length > 0) {
        console.log(`[fib] 🟢 STRONG BUY: ${summary.strongBuys.join(', ')}`);
    }

    console.log(
        `[fib] Batch done | ` +
        `processed: ${summary.processed} | ` +
        `touched: ${summary.touched} | ` +
        `signals: ${summary.signals} | ` +
        `errors: ${summary.errors.length}`
    );

    return summary;
}

module.exports = { processBatch, processOneTick, isSessionActive };