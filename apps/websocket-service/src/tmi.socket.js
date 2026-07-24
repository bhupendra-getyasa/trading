'use strict';
/*
 * tmi.socket.js — the TMI events on the EXISTING radar socket.
 *
 * client -> server
 *   tmi:subscribe   { date }
 *   tmi:budget      { date, budget_kd }
 *   tmi:fill        { date, contractId, side:'BUY'|'SELL', price, shares }
 *   tmi:config:get  {}
 *   tmi:config:save { config, note, activate }      -- validated by replay first
 *   tmi:replay      { date, config }                -- runs the harness, changes nothing
 *   tmi:audit       { date, symbol }
 *
 * server -> client
 *   tmi:update  { view }        the five zones + summary
 *   tmi:signal  { action }      a BUY/SELL fired this minute (for sound + highlight)
 *   tmi:error   { message }
 *
 * tmi:replay is read-only on purpose: it answers "what would this ruleset have done?"
 * without touching live state. Nothing should reach production without passing through
 * it first, including changes I propose.
 */
const svc = require('./services/tmi.service');
const repo = require('./services/tmi.repository');
const { run: replayRun, runWakeup } = require('@trading/shared/src/replay/harness');
const DEFAULT_CFG = require('@trading/shared/src/tmi/config');
const LIVE = require('@trading/shared/src/live-engine/config');
const { pool } = require('@trading/shared');
const session = require('./services/tmi.session');
const { loadSessionFromDb } = session;

const room = (date) => `tmi:${date}`;

function registerTmiHandlers(io, socket) {
  socket.on('tmi:subscribe', async ({ date } = {}) => {
    try {
      const day = date || svc.kuwaitDay();
      for (const r of [...socket.rooms]) if (String(r).startsWith('tmi:')) socket.leave(r);
      socket.join(room(day));
      let view = svc.currentView(day);
      if (!view) {
        if (svc.isLiveSession(day)) {
          view = (await svc.runTick(day))?.view;
        } else {
          // A FINISHED day: show what actually happened, from tmi_contracts.
          // Recorded fills are facts. Re-simulating instead makes your own history
          // change every time a rule changes - tighten a filter and yesterday's real
          // trades vanish, because the new rules would not have taken them.
          view = await svc.loadRecordedDay(day);
          // Only if nothing was ever recorded do we fall back to a simulation, and we
          // label it so the screen cannot pass a hypothetical off as history.
          if (!view) {
            view = await svc.replayDay(day);
            if (view) view.simulated = true;
          }
        }
      }
      if (!view) {
        // Say WHAT the server can see, not just that it saw nothing. "No data" sent
        // someone to check a database that turned out to be full.
        const diag = await session.diagnose(day).catch(() => null);
        const usable = ((diag && diag.recentDays) || []).filter((d) => d.pct_of_session >= 50);
        socket.emit('tmi:error', {
          message: diag && diag.verdict ? `${day}: ${diag.verdict}` : `no usable quote data for ${day}`,
          diagnostic: diag,
          hint: usable.length
            ? `days with enough coverage to replay: ${usable.map((d) => d.day + ' (' + d.pct_of_session + '%)').join(', ')}`
            : 'no stored day has enough coverage to replay - check that the watchlist scraper is running',
        });
        return;
      }
      socket.emit('tmi:update', { view });
    } catch (e) { socket.emit('tmi:error', { message: e.message }); }
  });

  socket.on('tmi:budget', async ({ date, budget_kd } = {}) => {
    try {
      const day = date || svc.kuwaitDay();
      const view = await svc.setBudget(day, Number(budget_kd));
      io.to(room(day)).emit('tmi:update', { view });
    } catch (e) { socket.emit('tmi:error', { message: e.message }); }
  });

  socket.on('tmi:fill', async ({ date, contractId, side, price, shares } = {}) => {
    try {
      const day = date || svc.kuwaitDay();
      if (!contractId || !side || price == null) throw new Error('contractId, side and price are required');
      const view = await svc.confirmFill(day, { contractId: Number(contractId), side,
        price: Number(price), shares: shares != null ? Number(shares) : undefined });
      io.to(room(day)).emit('tmi:update', { view });
    } catch (e) { socket.emit('tmi:error', { message: e.message }); }
  });

  socket.on('tmi:config:get', async () => {
    try {
      const active = await repo.activeConfig();
      const history = await repo.configHistory(30);
      socket.emit('tmi:config', { active: active || { version: null, config: DEFAULT_CFG }, history });
    } catch (e) { socket.emit('tmi:error', { message: e.message }); }
  });

  socket.on('tmi:config:save', async ({ config, note, activate, createdBy } = {}) => {
    try {
      if (!config) throw new Error('config required');
      const version = await repo.saveConfig(config, { note, createdBy, activate: !!activate });
      const active = await repo.activeConfig();
      socket.emit('tmi:config', { active: active || null, saved: version });
    } catch (e) { socket.emit('tmi:error', { message: e.message }); }
  });

  /*
   * tmi:replay — read-only. Runs a stored day through the real engine.
   *   mode: 'wakeup' (default) | 'signal'
   *
   * Always returns `ranked`: every candidate the detector measured, passed or refused,
   * each with the reason it failed. A day with no picks is a legitimate answer, but
   * "nothing" on its own is not an explanation - the near-misses are what tell you
   * whether a threshold is slightly too tight or the market was genuinely empty.
   */
  socket.on('tmi:replay', async ({ date, config, mode } = {}) => {
    try {
      if (!date) throw new Error('date required');
      const session = await loadSessionFromDb(date);
      if (!session) throw new Error(`no data for ${date}`);
      const cfg = config || (await svc.getConfig()).cfg;
      const useWakeup = (mode || 'wakeup') === 'wakeup' && cfg.WAKEUP && cfg.WAKEUP.enabled;

      if (useWakeup) {
        const r = runWakeup(session, cfg, LIVE.COMMISSION);
        socket.emit('tmi:replay:result', {
          date, mode: 'wakeup', summary: r.summary,
          contracts: r.trades.map((t) => ({ ...t, id: t.symbol + '-' + t.buyMinute, seq: 1 })),
          ranked: r.ranked,
          decideAtMinute: cfg.WAKEUP.decideAtMinute,
          note: r.trades.length ? null
            : `no stock passed the filter at minute ${cfg.WAKEUP.decideAtMinute}`,
        });
      } else {
        const r = replayRun(session, cfg, LIVE.LIQUIDITY, LIVE.COMMISSION);
        socket.emit('tmi:replay:result', {
          date, mode: 'signal', summary: r.summary, contracts: r.contracts, ranked: null,
        });
      }
    } catch (e) { socket.emit('tmi:error', { message: e.message }); }
  });

  // ask the server what it can actually see, without opening psql
  socket.on('tmi:diagnose', async ({ date } = {}) => {
    try {
      const day = date || svc.kuwaitDay();
      const [quotes, contracts] = await Promise.all([
        session.diagnose(day),
        repo.diagnoseContracts(day),
      ]);
      socket.emit('tmi:diagnose:result', { quotes, contracts });
    } catch (e) { socket.emit('tmi:error', { message: e.message }); }
  });

  socket.on('tmi:audit', async ({ date, symbol } = {}) => {
    try {
      const day = date || svc.kuwaitDay();
      const actions = await repo.loadActions(day, { symbol });
      const { rows: events } = await pool.query(
        `SELECT symbol, run_ts, outcome, entry_type, entry_price, profile, trend, lane,
                swing1_fils, reject_reason, reasons, liquidity_pass, liquidity_checks, book,
                detected_ts, triggered_ts
           FROM public.radar_events
          WHERE trading_day = $1 ${symbol ? 'AND symbol = $2' : ''}
          ORDER BY run_ts ASC;`, symbol ? [day, symbol] : [day]);
      socket.emit('tmi:audit:result', { date: day, symbol: symbol || null, actions, events });
    } catch (e) { socket.emit('tmi:error', { message: e.message }); }
  });
}


/* broadcastTmi — called by the worker each minute after the live scan. */
async function broadcastTmi(io, date) {
  const day = date || svc.kuwaitDay();
  const out = await svc.runTick(day);
  if (!out) return;
  io.to(room(day)).emit('tmi:update', { view: out.view });
  for (const a of out.actions) {
    if (a.type === 'BUY_SIGNAL' || a.type === 'SELL_SIGNAL') io.to(room(day)).emit('tmi:signal', { action: a });
  }
}

module.exports = { registerTmiHandlers, broadcastTmi };
