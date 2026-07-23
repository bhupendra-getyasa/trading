'use strict';
/*
 * engine.js — pure scan cycle (no IO). Runs once per minute over all symbols.
 *
 * For each symbol: build the signal panel + detect swings/Fib (Gate 1). If a
 * tradable setup is forming AND the symbol is not processed today, mark it for
 * History validation (Gate 2, done in orchestration). It does NOT call History,
 * size, buy, or sell. Live only SELECTS.
 *
 *   scanCycle({ windows, classifications, processedToday, now })
 *     windows        : Map symbol -> [snapshot rows] (raw, oldest->newest)
 *     classifications: Map symbol -> { profile, trend, lane } (for entry timing only)
 *     processedToday : Set of symbols already handled this trading day
 *   -> { tradingDay, panels[], radar[], toValidate[] }
 */
const U = require('./lib/util');
const CONFIG = require('./config');
const { buildPanel } = require('./signals');
const { detectSwings } = require('./swings');
const { evaluateRadar } = require('./radar');
const { buildBook } = require('./liquidity');

function scanCycle({ windows, quoteWindows = new Map(), classifications = new Map(), processedToday = new Set(), now = Date.now() } = {}) {
  const day = U.tradingDay(now, CONFIG.SESSION.tzOffsetHours);
  const get = (m, k) => (m.get ? m.get(k) : m[k]);
  const universe = windows.get ? [...windows.keys()] : Object.keys(windows);
  const panels = [], radar = [], toValidate = [];

  for (const sym of universe) {
    const raw = (get(windows, sym) || []).map(U.parseSnapshot);
    const latest = raw[raw.length - 1];
    const ageMin = latest && U.isNum(latest.ts) ? (now - latest.ts) / 60000 : Infinity;
    const fresh = ageMin <= CONFIG.ELIGIBILITY.stalenessMin;
    const panel = buildPanel(raw);
    // order-book panel from the broker feed; independent of the snapshot window, so it
    // carries its own freshness and is null-safe when the quote feed is missing.
    const book = buildBook(get(quoteWindows, sym) || [], CONFIG.LIQUIDITY, now);
    panel.book = book;
    const swing = detectSwings(raw, CONFIG.SWING);
    panels.push({ symbol: sym, snapshots: raw.length, ageMin: U.round2(ageMin), fresh, ...panel, swingCount: swing.swingCount, swing1Fils: swing.swing1Fils });

    const cls = get(classifications, sym) || {};
    let r = { inRadar: false, reasons: [], entry: null };
    // intendedShares: the depth test is relative to the size we would actually want.
    // Sizing proper happens after History qualifies, so use the same risk% the sizer
    // will use — close enough to judge depth, and it never widens the gate.
    const riskPct = (CONFIG.SIZING.riskPctByProfile || {})[cls.profile] ?? 0.05;
    const budgetKd = CONFIG.SIZING.defaultBudgetKd ?? null;
    const intendedShares = (budgetKd && U.isNum(panel.price) && panel.price > 0)
      ? Math.round((budgetKd * riskPct * 1000) / panel.price) : null;
    if (fresh) r = evaluateRadar(panel, swing, CONFIG.SWING, CONFIG.RADAR, {
      profile: cls.profile, trend: cls.trend,
      book, intendedShares, liquidityCfg: CONFIG.LIQUIDITY });

    const processed = processedToday.has ? processedToday.has(sym) : !!processedToday[sym];
    const trigger = r.inRadar && !processed;
    if (trigger) toValidate.push(sym);

    radar.push({ symbol: sym, inRadar: r.inRadar, processed, trigger, entry: r.entry, book, liquidity: r.liquidity || null,
      reasons: r.reasons, swingCount: swing.swingCount, swing1Fils: swing.swing1Fils, fib: swing.fib || null,
      pullback_pct: swing.pullback_pct ?? null, fib_level_hit: swing.fib_level_hit ?? null,
      detected_ts: swing.detected_ts ?? null, intended_fib_price: swing.intended_fib_price ?? null });
  }
  return { engine_version: CONFIG.VERSION, now, tradingDay: day, panels, radar, toValidate };
}
module.exports = { scanCycle, VERSION: CONFIG.VERSION, CONFIG };