// packages/shared/src/rankings/mostActive.js
// ─────────────────────────────────────────────────────────────────────────────
// MOST ACTIVE — Top Gainers / Top Losers / Top Value
//
// Computed directly from the raw market_stock_snapshots snapshot so no
// scoring pipeline is needed. Fast enough to run on every scrape tick.
//
// TOP GAINERS  — highest positive change_percent, minimum volume filter
// TOP LOSERS   — most negative change_percent, minimum volume filter
// TOP VALUE    — highest (price × volume) in KWD, any direction
//
// All three lists are returned in one call and cached in Redis under
// 'most_active' so every WebSocket connection gets the value instantly.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { parsePrice }   = require('../normalization/parsePrice.js');
const { parseVolume }  = require('../normalization/parseVolume.js');
const { parsePercent } = require('../normalization/parsePercent.js');

// Minimum volume (shares) to appear in gainers/losers.
// Filters out illiquid stocks that moved on a handful of shares.
const MIN_VOLUME_FOR_MOVERS = parseInt(process.env.MIN_VOLUME_FOR_MOVERS || '10000', 10);

// How many rows to return per list
const LIST_SIZE = parseInt(process.env.MOST_ACTIVE_LIST_SIZE || '5', 10);

/**
 * Shape one raw snapshot row into the display object needed by the frontend.
 * Keeps the payload small — only fields the UI actually renders.
 */
function formatRow(raw) {
  const price  = parsePrice(raw.last_price);
  const change = parsePrice(raw.change);
  const chgPct = parsePercent(raw.change_percent);
  const volume = parseVolume(raw.volume);
  const value  = price * volume;   // KWD value traded

  return {
    symbol:      raw.symbol,
    companyName: raw.company_name ?? raw.symbol,
    last:        price,
    change:      change,
    changePct:   chgPct,
    volume,
    value,           // used by Top Value sort; also shown in that column
    direction:   chgPct > 0 ? 'up' : chgPct < 0 ? 'down' : 'flat',
  };
}

/**
 * computeMostActive
 *
 * @param {object[]} rawStocks — rows from market_stock_snapshots (latest batch)
 * @returns {{ gainers: object[], losers: object[], topValue: object[] }}
 */
function computeMostActive(rawStocks) {
  if (!rawStocks || rawStocks.length === 0) {
    return { gainers: [], losers: [], topValue: [] };
  }

  const rows = rawStocks.map(formatRow);

  // ── Top Gainers: positive move, above minimum volume, sorted desc ─────────
  const gainers = rows
    .filter(r => r.changePct > 0 && r.volume >= MIN_VOLUME_FOR_MOVERS)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, LIST_SIZE);

  // ── Top Losers: negative move, above minimum volume, sorted asc ──────────
  const losers = rows
    .filter(r => r.changePct < 0 && r.volume >= MIN_VOLUME_FOR_MOVERS)
    .sort((a, b) => a.changePct - b.changePct)
    .slice(0, LIST_SIZE);

  // ── Top Value: largest KWD value traded, any direction ────────────────────
  const topValue = rows
    .filter(r => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, LIST_SIZE);

  return { gainers, losers, topValue };
}

module.exports = { computeMostActive, LIST_SIZE };
