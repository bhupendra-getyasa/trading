'use strict';
/*
 * historyService.js — Gate 2. On-demand single-stock validation.
 *
 * Reads public.stock_classification (written daily by History's classification
 * step) and caches it for the trading day, so validating one symbol is an instant
 * in-memory lookup — no full rescan per call. Returns a QUALITY verdict only.
 *
 *   evaluate(symbol) -> { symbol, profile, trend, lane, target_fils, net_fils,
 *                         tradable_swings, price_band, qualifies, source }
 *   qualifies = lane ∈ HISTORY.qualifyLanes  AND  trend ∉ HISTORY.blockTrends
 */
const CONFIG = require('./config');
const { tradingDay } = require('./lib/util');
const repo = require('./repository');

function create({ pool, historyCfg = CONFIG.HISTORY, tzOffsetHours = CONFIG.SESSION.tzOffsetHours } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('historyService.create requires { pool }');
  let cache = new Map(); let builtDay = null;
  async function refresh() { cache = await repo.loadClassifications(pool); builtDay = tradingDay(Date.now(), tzOffsetHours); return cache.size; }
  return {
    async evaluate(symbol) {
      const today = tradingDay(Date.now(), tzOffsetHours);
      if (cache.size === 0 || builtDay !== today) await refresh();
      const c = cache.get(symbol);
      if (!c) return { symbol, profile: null, trend: null, lane: null, qualifies: false, warnings: [], source: 'stock_classification' };
      const qualifies = historyCfg.qualifyLanes.includes(c.lane) && !historyCfg.blockTrends.includes(c.trend);
      // warnings travel WITH the opportunity so the user decides with full context
      const warnings = [];
      if ((historyCfg.warnTrends || []).includes(c.trend)) warnings.push('COOLING: character fading recently — you decide');
      if (c.profile === 'WATCH') warnings.push('WATCH: normally small swings — this is a bigger breakout');
      if (c.profile === 'WILD' || c.lane === 'B') warnings.push('ILLIQUID: thin volume, exit risk — tiny size only');
      return { symbol, profile: c.profile, trend: c.trend, lane: c.lane, target_fils: c.target_fils == null ? null : Number(c.target_fils),
        net_fils: c.net_fils == null ? null : Number(c.net_fils), tradable_swings: c.tradable_swings == null ? null : Number(c.tradable_swings),
        price_band: c.price_band, qualifies, warnings, source: 'stock_classification' };
    },
    refresh, _cache: () => cache,
  };
}
module.exports = { create };
