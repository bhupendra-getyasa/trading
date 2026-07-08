'use strict';
/*
 * Orchestration — the "run the history scoring" scenario, now WINDOWED.
 *
 *   load daily  +  load intraday stability (SQL-aggregated)
 *        -> for each window (all / current_week / last_week / current_month /
 *           last_month / last_7d / last_30d / yesterday / latest_day):
 *              slice daily rows to the window
 *              -> runHistoryEngine (pure, unchanged)
 *              -> assign per-window ranks, stamp window name
 *        -> ensure results table + upsert everything (single transaction)
 *
 * The pure engine stays untouched: windowing is pure data-selection upstream.
 * The stability Map is loaded ONCE and reused across windows (the engine only
 * looks up the symbol|date keys present in the slice it is handed, so extra
 * keys are harmless).
 */

const { runHistoryEngine } = require('./engine');
const { buildWindows, sliceWindow } = require('./windows');
const repo = require('./repository');

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

async function runHistoryScoring(db, opts = {}) {
  const runDate = opts.runDate || todayUtcDate();
  const log = opts.logger || console;
  const t0 = Date.now();

  // 1. Load ---------------------------------------------------------------
  log.log('[history] loading daily metrics…');
  const daily = await repo.loadDaily(db);
  if (!daily || daily.length === 0) {
    throw new Error(`No rows in ${repo.TABLES.daily}; aborting (nothing to score).`);
  }
  const symbolCount = new Set(daily.map((r) => r.symbol)).size;
  log.log(`[history] ${daily.length} daily rows across ${symbolCount} symbols`);

  log.log('[history] aggregating intraday volume stability in SQL…');
  const stability = await repo.loadVolumeStability(db); // full map, reused per window
  log.log(`[history] ${stability.size} symbol-day stability values`);

  // 2. Score each window --------------------------------------------------
  // opts.windows (optional array of names) runs a subset; default = all windows.
  const windows = buildWindows(daily, { only: opts.windows, refDate: opts.refDate });
  const allResults = [];
  const perWindow = [];

  for (const w of windows) {
    const slice = sliceWindow(daily, w);
    if (!slice.length) {
      log.log(`[history] window "${w.name}" (${w.from}..${w.to}) is empty — skipped`);
      continue;
    }

    const results = runHistoryEngine(slice, stability);
    if (!results.length) {
      log.log(`[history] window "${w.name}" produced no scores — skipped`);
      continue;
    }

    // per-window ranks + stamp the window label onto every row
    results.forEach((r, i) => { r.rank = i + 1; r.window = w.name; });
    allResults.push(...results);

    perWindow.push({
      window: w.name,
      from: w.from,
      to: w.to,
      days: new Set(slice.map((r) => r.trade_date)).size,
      scored: results.length,
      top5: results.slice(0, 5).map((r) => ({ rank: r.rank, symbol: r.symbol, final: r.final_score })),
      lowConfidence: results.filter((r) => r.confidence === 'Low').map((r) => r.symbol),
    });
    log.log(`[history]   window "${w.name}" (${w.from}..${w.to}): ${results.length} symbols over ${new Set(slice.map((r) => r.trade_date)).size} trading days`);
  }

  if (!allResults.length) {
    throw new Error('No window produced any results (all windows empty or filtered).');
  }

  // 3. Persist (transactional, idempotent on run_date+window+symbol) -------
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // await repo.ensureResultsTable(client); // run migration.sql once instead
    await repo.saveResults(client, allResults, runDate);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const summary = {
    runDate,
    symbols: symbolCount,
    scored: allResults.length,
    windows: perWindow,
    durationMs: Date.now() - t0,
  };
  log.log(`[history] wrote ${summary.scored} rows across ${perWindow.length} windows to ${repo.TABLES.results} (run_date=${runDate}) in ${summary.durationMs}ms`);
  return summary;
}

module.exports = { runHistoryScoring };