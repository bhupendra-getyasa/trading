'use strict';
/*
 * runScanner.js — one scan cycle (orchestration). Call every minute (hook into
 * the ingestion `stock-update` job, after the snapshot insert).
 *
 * load state + classifications + windows -> scanCycle (pure Gate 1) -> for each
 * triggered symbol call History (Gate 2) on demand -> if qualified, size it and
 * write the Opportunity List with FULL info -> mark processed -> log everything.
 * Never buys/sells. Budget is a SUGGESTION and never filters the radar.
 */
const { scanCycle, VERSION } = require('./engine');
const CONFIG = require('./config');
const U = require('./lib/util');
const { tradingDay } = U;
const { OUTCOMES, outcomeFor } = require('./outcome');
const { suggest } = require('./sizing');
const repo = require('./repository');

async function runScanner(pool, opts = {}) {
  try {
    const now = opts.now || Date.now();
    const runTs = new Date(now).toISOString();
    const day = tradingDay(now, CONFIG.SESSION.tzOffsetHours);
    const log = opts.logger || console;
    const history = opts.historyService;
    if (!history || typeof history.evaluate !== 'function') throw new Error('runScanner requires opts.historyService');

    const processedToday = await repo.loadProcessedToday(pool, day);
    const classifications = await repo.loadClassifications(pool);
    const budget = await repo.loadBudget(pool, day);          // may be null; sizing still works
    const symbols = await repo.loadLatestSymbols(pool);
    if (!symbols.length) { log.log('[live] no symbols; skip'); return { version: VERSION, runTs, tradingDay: day, scanned: 0 }; }
    const windows = await repo.loadWindows(pool, symbols);

    const out = scanCycle({ windows, classifications, processedToday, now });

    if (CONFIG.LOGGING.logAllSignals) {
      const radarBy = new Map(out.radar.map((r) => [r.symbol, r]));
      const rows = out.panels.map((p) => {
        const r = radarBy.get(p.symbol) || {};
        const { symbol, snapshots, ageMin, fresh, swingCount, swing1Fils, ...panel } = p;
        return { symbol, snapshots, age_min: ageMin, fresh, in_radar: r.inRadar, trigger: r.trigger,
          swing_count: swingCount, swing1_fils: swing1Fils, panel, reasons: r.reasons };
      });
      await repo.saveSignals(pool, rows, runTs, VERSION, day);
    }

    const radarBy = new Map(out.radar.map((r) => [r.symbol, r]));
    const qualified = [];
    for (const sym of out.toValidate) {
      const r = radarBy.get(sym); const panel = out.panels.find((p) => p.symbol === sym) || {};
      let v;
      try { v = await history.evaluate(sym); }
      catch (err) {
        log.log(`[live] History failed ${sym}: ${err.message}`);
        await repo.saveRadarEvent(pool, { symbol: sym, entry_type: r.entry, reasons: r.reasons, outcome: OUTCOMES.FAILED }, runTs, VERSION, day);
        continue;   // not marked processed -> retried next cycle
      }
      const outcome = v.qualifies ? OUTCOMES.QUALIFIED : OUTCOMES.REJECTED;
      const reject_reason = v.qualifies ? null
        : (!v.profile ? 'not_classified'
          : !CONFIG.HISTORY.qualifyLanes.includes(v.lane) ? `${v.profile}/Lane_${v.lane}`
          : v.trend);
      await repo.saveRadarEvent(pool, { symbol: sym, entry_type: r.entry, reasons: r.reasons,
        profile: v.profile, trend: v.trend, lane: v.lane, swing1_fils: r.swing1Fils, entry_price: panel.price,
        reject_reason, history_qualifies: v.qualifies, outcome }, runTs, VERSION, day);

      if (v.qualifies) {
        const size = suggest({ profile: v.profile, price: panel.price, volume: panel.volume,
          tradableSwings: v.tradable_swings, targetFils: v.target_fils, lane: v.lane, avgVolume: panel.avgVolume }, budget, CONFIG.SIZING, CONFIG.COMMISSION);
        const net_fils = U.round2((v.target_fils ?? 0) - size.commission_fils_per_share);      // expected fils after REAL commission
        const est_profit_kd = U.round2((size.suggested_shares * net_fils) / 1000);    // suggestion only (real result = TMI)
        // FULL detail sent with every qualified opportunity — user decides with everything in hand
        await repo.insertOpportunity(pool, {
          symbol: sym, trigger_ts: runTs, profile: v.profile, trend: v.trend, lane: v.lane, entry_type: r.entry,
          entry_price: panel.price, swing1_fils: r.swing1Fils, swings_so_far: r.swingCount, expected_fils: v.target_fils,
          net_fils, price_band: v.price_band, rvol: panel.rvol, change_pct: panel.changePct, value_traded: panel.valueTraded, volume: panel.volume, avg_volume: panel.avgVolume,
          suggested_shares: size.suggested_shares, est_roundtrips: size.est_roundtrips, kd_needed: size.kd_needed,
          opening_price: panel.dayOpen ?? null, commission_fils: size.commission_fils_per_share,
          est_profit_kd, size_tag: size.tag, warnings: v.warnings, reasons: r.reasons, fib: r.fib }, VERSION, day);
        qualified.push(sym);
      }
      await repo.markProcessed(pool, { symbol: sym, tradingDay: day, outcome, profile: v.profile, trend: v.trend, now });
    }

    const summary = { version: VERSION, runTs, tradingDay: day, scanned: symbols.length,
      inRadar: out.radar.filter((r) => r.inRadar).length, validated: out.toValidate.length, qualified };
    log.log(`[${VERSION}] ${day} · scanned ${summary.scanned} · radar ${summary.inRadar} · validated ${summary.validated} · qualified ${qualified.length}`);
    return summary;

  } catch (error) {
    console.log('error: ', error);
  }
}
module.exports = { runScanner };
