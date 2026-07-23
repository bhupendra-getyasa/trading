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
    const quoteWindows = await repo.loadQuoteWindows(pool, symbols);   // order book (broker feed)

    const out = scanCycle({ windows, quoteWindows, classifications, processedToday, now });

    if (CONFIG.LOGGING.logAllSignals) {
      const radarBy = new Map(out.radar.map((r) => [r.symbol, r]));
      const rows = out.panels.map((p) => {
        const r = radarBy.get(p.symbol) || {};
        const { symbol, snapshots, ageMin, fresh, swingCount, swing1Fils, ...panel } = p;
        // panel.book rides inside `panel` (jsonb) — every symbol, every cycle, which is
        // the raw material for validating the LIQUIDITY thresholds off-line.
        return { symbol, snapshots, age_min: ageMin, fresh, in_radar: r.inRadar, trigger: r.trigger,
          swing_count: swingCount, swing1_fils: swing1Fils, panel, reasons: r.reasons };
      });
      await repo.saveSignals(pool, rows, runTs, VERSION, day);
    }

    const radarBy = new Map(out.radar.map((r) => [r.symbol, r]));
    const panelBy = new Map(out.panels.map((p) => [p.symbol, p]));
    const qualified = [];
    const radarEvents = [];      // collected, then written in ONE bulk insert
    const opportunities = [];    // collected, then written in ONE bulk insert
    const processed = [];        // collected, then written in ONE bulk upsert

    for (const sym of out.toValidate) {
      const r = radarBy.get(sym); const panel = panelBy.get(sym) || {};
      // CONFIRMATION-LAG: detected_ts = when the setup completed (pullback-low snapshot,
      // from swings), triggered_ts = runTs (this scan, when the turn-up confirmed & we write).
      // Both stored as timestamptz; the gap triggered_ts - detected_ts is the confirmation lag.
      const detectedIso = r?.detected_ts != null ? new Date(r.detected_ts).toISOString() : null;
      let v;
      try { v = await history.evaluate(sym); }   // in-memory cache lookup, no DB hit
      catch (err) {
        log.log(`[live] History failed ${sym}: ${err.message}`);
        radarEvents.push({ symbol: sym, entry_type: r.entry, reasons: r.reasons, outcome: OUTCOMES.FAILED,
          detected_ts: detectedIso, triggered_ts: runTs });
        continue;   // not marked processed -> retried next cycle
      }
      const outcome = v.qualifies ? OUTCOMES.QUALIFIED : OUTCOMES.REJECTED;
      const reject_reason = v.qualifies ? null
        : (!v.profile ? 'not_classified'
          : !CONFIG.HISTORY.qualifyLanes.includes(v.lane) ? `${v.profile}/Lane_${v.lane}`
          : v.trend);
      radarEvents.push({ symbol: sym, entry_type: r.entry, reasons: r.reasons,
        profile: v.profile, trend: v.trend, lane: v.lane, swing1_fils: r.swing1Fils, entry_price: panel.price,
        reject_reason, history_qualifies: v.qualifies, outcome,
        detected_ts: detectedIso, triggered_ts: runTs,
        liquidity_pass: r.liquidity ? r.liquidity.pass : null,
        liquidity_blocked: r.liquidity ? r.liquidity.blocked : null,
        book: r.book || null, liquidity_checks: r.liquidity ? r.liquidity.checks : null });

      if (v.qualifies) {
        const size = suggest({ profile: v.profile, price: panel.price, volume: panel.volume,
          tradableSwings: v.tradable_swings, targetFils: v.target_fils, lane: v.lane, avgVolume: panel.avgVolume,
          book: r.book }, budget, CONFIG.SIZING, CONFIG.COMMISSION);
        const net_fils = U.round2((v.target_fils ?? 0) - size.commission_fils_per_share);      // expected fils after REAL commission
        const est_profit_kd = U.round2((size.suggested_shares * net_fils) / 1000);    // suggestion only (real result = TMI)
        opportunities.push({
          symbol: sym, trigger_ts: runTs, profile: v.profile, trend: v.trend, lane: v.lane, entry_type: r.entry,
          entry_price: panel.price, swing1_fils: r.swing1Fils, swings_so_far: r.swingCount, expected_fils: v.target_fils,
          net_fils, price_band: v.price_band, rvol: panel.rvol, change_pct: panel.changePct, value_traded: panel.valueTraded, volume: panel.volume, avg_volume: panel.avgVolume,
          suggested_shares: size.suggested_shares, est_roundtrips: size.est_roundtrips, contracts: size.est_roundtrips, kd_needed: size.kd_needed,
          opening_price: panel.dayOpen ?? null, commission_fils: size.commission_fils_per_share,
          est_profit_kd, size_tag: size.tag, warnings: v.warnings, reasons: r.reasons, fib: r.fib,
          pullback_pct: r.pullback_pct ?? null, fib_level_hit: r.fib_level_hit ?? null,
          detected_ts: detectedIso, triggered_ts: runTs,
          intended_fib_price: r.intended_fib_price ?? null,     // entry_price above = ACTUAL fill price
          // order-book snapshot at the moment of the signal + which cap bound the size.
          // Stored so a fill can later be judged against the book that was actually there.
          book: r.book || null,
          liquidity_pass: r.liquidity ? r.liquidity.pass : null,
          liquidity_checks: r.liquidity ? r.liquidity.checks : null,
          shares_by_volume_cap: size.shares_by_volume_cap ?? null,
          shares_by_book_cap: size.shares_by_book_cap ?? null,
          cap_source: size.cap_source ?? null });
        qualified.push(sym);
      }
      processed.push({ symbol: sym, tradingDay: day, outcome, profile: v.profile, trend: v.trend, now });
    }

    // Three bulk writes instead of ~3×N sequential round-trips to RDS.
    await repo.saveRadarEvents(pool, radarEvents, runTs, VERSION, day);
    await repo.insertOpportunities(pool, opportunities, VERSION, day);
    await repo.markProcessedBatch(pool, processed);

    const liqFail = out.radar.filter((r) => r.liquidity && r.liquidity.pass === false).length;
    const noBook = out.radar.filter((r) => r.book && (r.book.stale || r.book.insufficient)).length;
    const summary = { version: VERSION, runTs, tradingDay: day, scanned: symbols.length,
      inRadar: out.radar.filter((r) => r.inRadar).length, validated: out.toValidate.length, qualified,
      liquidityMode: CONFIG.LIQUIDITY.mode, liquidityFail: liqFail, noBook };
    log.log(`[${VERSION}] ${day} · scanned ${summary.scanned} · radar ${summary.inRadar} · validated ${summary.validated} · qualified ${qualified.length} · liq(${CONFIG.LIQUIDITY.mode}) fail ${liqFail} · noBook ${noBook}`);
    return summary;

  } catch (error) {
    console.log('error: ', error);
  }
}
module.exports = { runScanner };