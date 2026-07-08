// TRANSFORMATION SERVICE
// Reads from:  public.stock_prices       (1-min raw OHLCV)
// Writes to:   public.stock_prices_daily (35 computed metrics)
//
// How it works:
//   1. Fetch all distinct symbols from stock_prices
//   2. For each symbol, fetch its 1-min rows grouped by date
//   3. For each date, compute all 35 metrics via compute.js
//   4. Batch upsert results into stock_prices_daily via writer.js
//
// Called via runTransform() from the ingestion service's 2 PM cron.
// =============================================================================

'use strict';

require('dotenv').config();
const { pool } = require('@trading/shared');
const { loadConfig }          = require('./config');
const { computeDailyMetrics } = require('./compute');
const {
  fetchSymbols,
  fetchRawRows,
  fetchComputedDates,
  resolveDateRange,
}                             = require('./loader');
const { upsertBatch }         = require('./writer');

// ---------------------------------------------------------------------------
// Progress tracker — used by API and BullMQ to report status
// ---------------------------------------------------------------------------
class TransformProgress {
  constructor(totalSymbols) {
    this.totalSymbols    = totalSymbols;
    this.doneSymbols     = 0;
    this.totalDays       = 0;
    this.failedSymbols   = [];
    this.skippedSymbols  = [];
    this.startedAt       = new Date();
    this.currentSymbol   = null;
    this.status          = 'running';  // 'running' | 'done' | 'failed'
    this.log             = [];
  }

  addLog(msg) {
    this.log.push({ ts: new Date().toISOString(), msg });
    console.log(`[transform] ${msg}`);
  }

  toJSON() {
    const elapsed = Math.round((Date.now() - this.startedAt) / 1000);
    return {
      status:         this.status,
      totalSymbols:   this.totalSymbols,
      doneSymbols:    this.doneSymbols,
      totalDays:      this.totalDays,
      failedSymbols:  this.failedSymbols,
      skippedSymbols: this.skippedSymbols,
      currentSymbol:  this.currentSymbol,
      elapsedSec:     elapsed,
      pct:            this.totalSymbols
        ? Math.round(this.doneSymbols / this.totalSymbols * 100)
        : 0,
      log:            this.log.slice(-20),   // last 20 lines for API response
    };
  }
}

// ---------------------------------------------------------------------------
// Transform one symbol for a given date range
// ---------------------------------------------------------------------------
/**
 * @param {string}             symbol
 * @param {string}             dateFrom   'YYYY-MM-DD'
 * @param {string}             dateTo     'YYYY-MM-DD'
 * @param {object}             cfg        from loadConfig()
 * @param {boolean}            force      re-process even if date exists
 * @param {TransformProgress}  progress   progress tracker (optional)
 * @returns {Promise<number>}  days written
 */
async function transformSymbol(symbol, dateFrom, dateTo, cfg, force, progress) {
  const log = (msg) => progress
    ? progress.addLog(msg)
    : console.log(`[transform] ${msg}`);

  log(`── ${symbol}  ${dateFrom} → ${dateTo}`);

  // Step 1: which dates are already done? (skip unless --force)
  const skipDates = force
    ? new Set()
    : await fetchComputedDates(pool, symbol);

  if (skipDates.size > 0) {
    log(`   ${skipDates.size} dates already in stock_prices_daily — skipping`);
  }

  // Step 2: load 1-min raw rows from stock_prices, grouped by date
  const rawByDate = await fetchRawRows(pool, symbol, dateFrom, dateTo);

  if (!rawByDate.size) {
    log(`   No data found for ${symbol} in range`);
    return 0;
  }

  log(`   ${rawByDate.size} trading days found in stock_prices`);

  // Step 3: compute 35 metrics per day
  const records = [];
  let   skipped = 0;

  for (const [dateStr, rows] of rawByDate) {

    // Skip already-computed dates
    if (skipDates.has(dateStr)) {
      skipped++;
      continue;
    }

    try {
      const result = computeDailyMetrics(symbol, dateStr, rows, cfg);

      if (result) {
        records.push(result);
        log(
          `   ${dateStr} ✓  ` +
          `rows=${rows.length}  swings=${result.totalSwings}  ` +
          `tradable_bull=${result.tradableBullSwings}  ` +
          `fib_win=${result.fibWinPct}%  ` +
          `auto_target=${result.autoTargetFils} fils  ` +
          `buyer=${result.buyerPct}%`
        );
      } else {
        log(`   ${dateStr} ⚠  skipped (< 5 rows)`);
        skipped++;
      }

    } catch (err) {
      log(`   ${dateStr} ✗  ERROR: ${err.message}`);
      // Don't throw — continue processing other dates
    }
  }

  // Step 4: batch upsert to stock_prices_daily
  if (!records.length) {
    log(`   ${symbol} — nothing new to write (${skipped} skipped)`);
    return 0;
  }

  const written = await upsertBatch(pool, records);
  log(`   ✅ ${symbol} — ${written} days written, ${skipped} skipped`);
  return written;
}

// ---------------------------------------------------------------------------
// Main transform function — all symbols, called by API or cron
// ---------------------------------------------------------------------------
/**
 * @param {object} opts
 * @param {string}  [opts.symbol]      single symbol override
 * @param {string}  [opts.dateFrom]    'YYYY-MM-DD'
 * @param {string}  [opts.dateTo]      'YYYY-MM-DD'
 * @param {number}  [opts.lookback]    days back if no dateFrom (default 90)
 * @param {boolean} [opts.force]       re-process existing dates
 * @param {function} [opts.onProgress] callback(progress) for streaming updates
 * @returns {Promise<TransformProgress>}
 */
async function runTransform(opts = {}) {
  const {
    symbol:     singleSymbol = null,
    lookback:   lookbackDays = 90,
    force:      forceReprocess = false,
    onProgress: progressCallback = null,
  } = opts;

  // Resolve date range
  const { dateFrom, dateTo } = resolveDateRange(
    opts.dateFrom || null,
    opts.dateTo   || null,
    lookbackDays,
  );

  // Load strategy config from DB
  const cfg = await loadConfig(pool);

  // Get symbols to process
  let symbols;
  if (singleSymbol) {
    symbols = [singleSymbol.toUpperCase()];
  } else {
    symbols = await fetchSymbols(pool, cfg.priceMaxFils);
  }

  if (!symbols.length) {
    throw new Error('No eligible symbols found in stock_prices');
  }

  // Init progress tracker
  const progress = new TransformProgress(symbols.length);
  progress.addLog(
    `Transform started — ${symbols.length} symbols | ` +
    `${dateFrom} → ${dateTo} | force=${forceReprocess}`
  );
  progress.addLog(
    `Config: target=${cfg.targetProfitFils} fils | ` +
    `min_swing=${cfg.minSwingFils} fils | ` +
    `swings_wait=${cfg.swingsToWait} | ` +
    `price_max=${cfg.priceMaxFils} fils`
  );

  // Process each symbol
  for (const sym of symbols) {
    progress.currentSymbol = sym;

    try {
      const days = await transformSymbol(
        sym, dateFrom, dateTo, cfg, forceReprocess, progress
      );
      progress.totalDays += days;
      progress.doneSymbols++;
    } catch (err) {
      progress.addLog(`❌ FAILED ${sym}: ${err.message}`);
      progress.failedSymbols.push({ symbol: sym, error: err.message });
      progress.doneSymbols++;   // still count as done so pct advances
    }

    // Fire progress callback (used by BullMQ worker)
    if (progressCallback) {
      await progressCallback(progress.toJSON());
    }
  }

  // Final summary
  progress.currentSymbol = null;
  progress.status = progress.failedSymbols.length > 0 ? 'done_with_errors' : 'done';
  progress.addLog(
    `Transform complete — ${progress.doneSymbols} symbols | ` +
    `${progress.totalDays} days written | ` +
    `${progress.failedSymbols.length} failed`
  );

  return progress;
}

module.exports = { runTransform, transformSymbol };