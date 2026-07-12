'use strict';
/*
 * index.js — wire the Live scanner into the ingestion `stock-update` job.
 * Call runLiveScan(pool) right after the market_stock_snapshots insert.
 *
 * In apps/ingestion-service/src/worker.js:
 *   const { runLiveScan } = require('./live-engine');
 *   ... after the insert, at the end of the stock-update try block:
 *   try { await runLiveScan(pool); } catch (e) { console.error('[live]', e.message); }
 */
const { runScanner } = require('./runScanner');
const historyServiceFactory = require('./historyService');

let _svc = null;
function runLiveScan(pool, opts = {}) {
  if (!_svc) _svc = historyServiceFactory.create({ pool });   // cached across cycles, refreshes daily
  return runScanner(pool, { historyService: _svc, ...opts });
}
module.exports = { runLiveScan, runScanner, recordDecision: require('./decisions').recordDecision };
