'use strict';
/*
 * tmi.service.js — drives the TMI engine on live data.
 *
 * The frame it builds is DELIBERATELY the same shape the replay harness builds, and it
 * calls the same tick(). If the live path and the replay path ever compute a frame
 * differently, every number the harness produces becomes a lie about what live would
 * have done — and it would be a convincing lie, because it would still look reasonable.
 * That is the failure this whole architecture exists to prevent.
 *
 * The service never places an order. It emits signals; a human fills them and reports
 * back. In paper mode the fill is simulated at the signalled price so the two modes
 * produce comparable records and the gap between them measures real slippage.
 */
const { pool } = require('@trading/shared');
const TMI = require('@trading/shared/src/tmi/engine');
const S = require('@trading/shared/src/tmi/state');
const R = require('@trading/shared/src/tmi/rules');
const DEFAULT_CFG = require('@trading/shared/src/tmi/config');
const LIVE = require('@trading/shared/src/live-engine/config');
const { buildBook } = require('@trading/shared/src/live-engine/liquidity');
const { detectSwings } = require('@trading/shared/src/live-engine/swings');
const repo = require('./tmi.repository');
const { run: replayRun } = require('@trading/shared/src/replay/harness');
const { loadSessionFromDb } = require('./tmi.session');

const QUOTES = process.env.QUOTES_TABLE || 'public.stock_quotes';
const CLS = process.env.CLASSIFICATION_TABLE || 'public.stock_classification';
const EVENTS = 'public.radar_events';

// in-memory state per trading day; the DB is the durable record, this is the working copy
const days = new Map();

function kuwaitDay(now = Date.now()) {
  return new Date(now + LIVE.SESSION.tzOffsetHours * 3600000).toISOString().slice(0, 10);
}

async function getConfig() {
  const row = await repo.activeConfig();
  return row ? { version: row.version, cfg: row.config } : { version: null, cfg: DEFAULT_CFG };
}

/*
 * buildLiveFrame — the last N minutes for every symbol, assembled into the frame shape.
 * One query for the window, one for classification, one for today's nominations.
 */
async function buildLiveFrame(tradingDay, minuteIdx, cfg) {
  const win = Math.max(LIVE.WINDOW.snapshots, (LIVE.LIQUIDITY && LIVE.LIQUIDITY.window) || 20);
  const { rows } = await pool.query(
    `SELECT q.symbol, q.last_price, q.bid, q.bid_qty, q.offer, q.offer_qty, q.trades,
            q.high_price, q.low_price, q.created_at
       FROM (SELECT DISTINCT symbol FROM ${QUOTES} WHERE trading_date = $1) s
       CROSS JOIN LATERAL (
         SELECT * FROM ${QUOTES} t
          WHERE t.symbol = s.symbol AND t.trading_date = $1
            AND t.last_price IS NOT NULL AND t.last_price > 0
          ORDER BY t.created_at DESC LIMIT $2
       ) q
      ORDER BY q.symbol, q.created_at ASC;`, [tradingDay, win]);

  const { rows: cls } = await pool.query(
    `SELECT symbol, profile, lane, trend, target_fils FROM ${CLS};`);
  const clsBy = new Map(cls.map((c) => [c.symbol, c]));

  const { rows: noms } = await pool.query(
    `SELECT DISTINCT ON (symbol) symbol, outcome, entry_price, run_ts
       FROM ${EVENTS} WHERE trading_day = $1 ORDER BY symbol, run_ts ASC;`, [tradingDay]);
  const nomBy = new Map(noms.map((n) => [n.symbol, n]));

  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push(r);
  }

  const symbols = {};
  for (const [sym, list] of bySym) {
    if (list.length < 5) continue;
    const prices = list.map((r) => Number(r.last_price)).filter((p) => p > 0);
    if (!prices.length) continue;
    const c = clsBy.get(sym);
    const nom = nomBy.get(sym);
    const book = buildBook(list, LIVE.LIQUIDITY, Date.now());
    const last = list[list.length - 1];
    const hi = Number(last.high_price) || Math.max(...prices);
    const lo = Number(last.low_price) || Math.min(...prices);

    const f = {
      price: prices[prices.length - 1],
      book,
      sessionPrices: prices,
      sessionRangeFils: hi - lo,
      radarQualified: !!(c && LIVE.HISTORY.qualifyLanes.includes(c.lane)),
      liquidityPass: book && !book.stale && !book.insufficient ? undefined : undefined,
      entrySignal: false, entryPrice: null, entryReason: null,
      nominated: !!nom && nom.outcome === 'qualified',
      classification: c || null,
    };

    // entry signal — same two models the harness A/B tests, same swing detector
    if (f.radarQualified) {
      const sw = detectSwings(list.map((r) => ({ price: Number(r.last_price), ts: new Date(r.created_at).getTime() })), LIVE.SWING);
      if (sw.fib) {
        const s1 = sw.swing1Fils ?? 0;
        const bandOk = (!cfg.ENTRY.minSwing1Fils || s1 >= cfg.ENTRY.minSwing1Fils)
                    && (!cfg.ENTRY.maxSwing1Fils || s1 <= cfg.ENTRY.maxSwing1Fils);
        const windowOk = !cfg.SELECTION.noTradeBeforeMinute || minuteIdx >= cfg.SELECTION.noTradeBeforeMinute;
        if (bandOk && windowOk) {
          if (cfg.ENTRY.model === 'zone') {
            if (sw.pullbackHeldFib && f.price >= sw.fib.zoneLow && f.price <= sw.fib.zoneHigh) {
              f.entrySignal = true; f.entryPrice = f.price;
              f.entryReason = `zone ${Math.round(sw.fib.zoneLow)}-${Math.round(sw.fib.zoneHigh)} (swing1 ${s1}f)`;
            }
          } else if (sw.secondSwingStarting && f.price <= sw.fib.zoneHigh + (LIVE.SWING.entryTolFils ?? 2)) {
            f.entrySignal = true; f.entryPrice = f.price;
            f.entryReason = `2nd swing (swing1 ${s1}f)`;
          }
        }
        f.swing = { swing1Fils: s1, fib: sw.fib, pullbackHeldFib: sw.pullbackHeldFib, secondSwingStarting: sw.secondSwingStarting };
      }
    }
    symbols[sym] = f;
  }
  return { minute: minuteIdx, ts: new Date().toISOString(), symbols };
}

/* Minutes since the open, in Kuwait time. Negative before the open, and larger than
 * SESSION_MINUTES after the close — both are meaningful and callers check for them. */
function sessionMinute(now = Date.now()) {
  const k = new Date(now + LIVE.SESSION.tzOffsetHours * 3600000);
  return (k.getUTCHours() - LIVE.SESSION.openHour) * 60 + k.getUTCMinutes();
}

const SESSION_MINUTES = (LIVE.SESSION.closeHour - LIVE.SESSION.openHour) * 60;

/* Is `day` a session that is currently in progress? Only then does ticking make sense —
 * a live tick accumulates state one minute at a time, so running it once against a
 * finished day produces an empty view rather than that day's actual trading. */
function isLiveSession(day, now = Date.now()) {
  if (day !== kuwaitDay(now)) return false;
  const m = sessionMinute(now);
  return m >= 0 && m <= SESSION_MINUTES;
}

/*
 * loadRecordedDay — what ACTUALLY happened, from tmi_contracts.
 *
 * This is the one that must answer "show me yesterday". A recorded contract is a fact:
 * it has a fill price, a real commission, a real P&L. Re-simulating the day instead
 * silently rewrites history every time the config changes - subscribe to a past date
 * after tightening a rule and your own trading record disappears, because the new rules
 * would not have taken those trades.
 *
 * Replay is a separate question ("what WOULD these rules have done?") and belongs behind
 * its own explicit action, which is the Replay screen.
 */
async function loadRecordedDay(tradingDay) {
  const rows = await repo.loadContracts(tradingDay);
  const savedCandidates = await repo.loadCandidates(tradingDay).catch(() => ({}));
  // A day with a watchlist but no trades is still a day worth reviewing — arguably the
  // most interesting kind, since it shows what qualified and was never acted on. So the
  // early return must consider both, not just contracts.
  if (!rows.length && !Object.keys(savedCandidates).length) return null;
  const { version, cfg } = await getConfig();

  const contracts = rows.map((r) => ({
    id: r.id, symbol: r.symbol, seq: r.seq, status: r.status,
    signalMinute: r.signal_minute, signalPrice: num(r.signal_price),
    shares: r.shares, target: num(r.target_fils), stop: num(r.stop_fils),
    entryReason: r.entry_reason, entryBook: r.entry_book,
    buyPrice: num(r.buy_price), buyMinute: r.buy_minute,
    sellPrice: num(r.sell_price), sellMinute: r.sell_minute,
    peak: num(r.peak), exitReason: r.exit_reason,
    grossKd: num(r.gross_kd), commissionKd: num(r.commission_kd), netKd: num(r.net_kd),
    quietRun: 0,
  }));

  const stocks = {};
  for (const c of contracts) {
    const st = stocks[c.symbol] || { symbol: c.symbol, status: 'WATCH', contractSeq: 0,
      failedSetups: 0, realisedKd: 0, lastSell: null, banUntilMinute: null, blockedReason: null };
    st.contractSeq = Math.max(st.contractSeq, c.seq);
    if (c.netKd != null) {
      st.realisedKd = S.round2(st.realisedKd + c.netKd);
      if (c.netKd < 0) st.failedSetups += 1;
    }
    if (st.realisedKd <= cfg.RISK.perStockMaxLossKd) { st.status = 'BLOCKED'; st.blockedReason = `loss_limit ${st.realisedKd} KD`; }
    else if (st.failedSetups >= cfg.RISK.maxFailedSetups) { st.status = 'BLOCKED'; st.blockedReason = `${st.failedSetups} failed setups`; }
    stocks[c.symbol] = st;
  }

  const spent = contracts.filter((c) => c.status === 'HOLDING' || c.status === 'PENDING_SELL')
    .reduce((a, c) => a + ((c.buyPrice || 0) * (c.shares || 0)) / 1000, 0);
  const realised = contracts.reduce((a, c) => a + (c.netKd || 0), 0);
  const budgetKd = cfg.BUDGET.defaultKd;
  const reserveKd = S.round2(budgetKd * cfg.BUDGET.reservePct);

  const state = { tradingDay, budgetKd, reserveKd,
    deployableKd: S.round2(budgetKd - reserveKd),
    cashKd: S.round2(budgetKd - reserveKd - spent),
    stocks, contracts, nextContractId: contracts.length + 1,
    realisedKd: S.round2(realised),
    commissionKd: S.round2(contracts.reduce((a, c) => a + (c.commissionKd || 0), 0)),
    log: [],
    // The recorded watchlist, so a past day shows what was being watched — not just
    // what was traded. On most days those are very different lists.
    candidates: savedCandidates };

  const view = buildView({ state, cfg, version, lastFrame: { symbols: {} } });
  view.recorded = true;                 // these are real fills, not a simulation
  view.mode = (rows[0] && rows[0].mode) || cfg.MODE;
  view.tradingDay = tradingDay;
  return view;
}

const num = (v) => (v == null ? null : Number(v));

/*
 * replayDay — reconstruct a FINISHED day by running the whole session through the same
 * engine, minute by minute.
 *
 * This is what a past date needs. runTick() is built for live use: it ticks once at the
 * current minute and builds state as the session unfolds. Calling it against a closed
 * day gives an empty view, because there is no accumulated state and no "current minute"
 * that means anything.
 *
 * Uses the same tick() and the same config as live, so what you see here is what the
 * engine would have done — not a separate reimplementation that could quietly disagree.
 */
async function replayDay(tradingDay) {
  const { version, cfg } = await getConfig();
  const session = await loadSessionFromDb(tradingDay);
  if (!session) return null;
  const r = replayRun(session, cfg, LIVE.LIQUIDITY, LIVE.COMMISSION);

  // shape the finished state into the same view the live path emits
  const d = { state: r.state, cfg, version, lastFrame: { symbols: {} }, _logged: r.state.log.length };
  const view = buildView(d);
  view.replayed = true;                       // the UI shows this is a reconstruction
  view.tradingDay = tradingDay;
  return view;
}

async function stateFor(tradingDay) {
  let d = days.get(tradingDay);
  if (d) return d;
  const { version, cfg } = await getConfig();
  d = { state: S.createState({ tradingDay, budgetKd: cfg.BUDGET.defaultKd, config: cfg }), cfg, version };

  // Rebuild the day's watchlist from the database. Without this a restart mid-session
  // silently emptied the watching zone, and yesterday's list could never be opened at
  // all — the two cases a watchlist most needs to survive.
  try {
    const saved = await repo.loadCandidates(tradingDay);
    if (saved && Object.keys(saved).length) d.state = { ...d.state, candidates: saved };
  } catch (e) { console.warn('[tmi] candidate restore', e.message); }

  days.set(tradingDay, d);
  return d;
}

/* runTick — called once a minute after the live scan writes its snapshot. */
async function runTick(tradingDay = kuwaitDay()) {
  const d = await stateFor(tradingDay);
  const minute = sessionMinute();
  if (minute < 0) return null;                       // before the open
  const frame = await buildLiveFrame(tradingDay, minute, d.cfg);
  const out = TMI.tick(d.state, frame, d.cfg, LIVE.COMMISSION);
  d.state = out.state;
  d.lastFrame = frame;

  // Record THIS tick's qualified symbols into the day's candidate list. The list is
  // append-only: a symbol that qualified at 09:15 stays on the watching zone for the
  // rest of the session even if it never qualifies again. Before this, the zone was
  // rebuilt from the current frame alone, so candidates disappeared during any quiet
  // minute and the zone was empty after the close on a day with ten qualified stocks.
  {
    const seen = new Set();
    for (const [sym, snap] of Object.entries(frame.symbols || {})) {
      if (!snap.radarQualified) continue;
      if (!snap.nominated && !snap.entrySignal) continue;
      seen.add(sym);
      d.state = S.noteCandidate(d.state, sym, snap, minute);
    }
    d.state = S.ageCandidates(d.state, seen, minute);
    // Persist every tick. The watchlist is the record of what the engine showed you
    // that day, so it has to outlive the process, not just the session.
    try { await repo.upsertCandidates(d.state.candidates, tradingDay); }
    catch (e) { console.warn('[tmi] candidate persist', e.message); }
  }

  for (const c of d.state.contracts) {
    try { await repo.upsertContract(c, tradingDay, d.cfg.MODE, d.version); } catch (e) { console.warn('[tmi] contract persist', e.message); }
  }
  const newLogs = d.state.log.slice(d._logged || 0);
  d._logged = d.state.log.length;
  try { await repo.logActions(newLogs.map((l) => ({ ...l, detail: l })), tradingDay); } catch (e) { console.warn('[tmi] action log', e.message); }

  return { actions: out.actions, view: buildView(d) };
}

/*
 * buildView — the UI projection. Zones are DERIVED from contract status, never stored,
 * so the screen and the engine can never disagree about what state something is in.
 */
function buildView(d) {
  const st = d.state, f = d.lastFrame || { symbols: {} };
  const zones = { watching: [], readyBuy: [], holding: [], readySell: [], exited: [] };
  const openSyms = new Set();

  for (const c of st.contracts) {
    const sym = f.symbols[c.symbol] || {};
    const row = {
      contractId: c.id, symbol: c.symbol, seq: c.seq, status: c.status,
      signalPrice: c.signalPrice, shares: c.shares, target: c.target, stop: c.stop,
      buyPrice: c.buyPrice, sellPrice: c.sellPrice, peak: c.peak,
      price: sym.price ?? null, exitReason: c.exitReason,
      netKd: c.netKd, grossKd: c.grossKd, commissionKd: c.commissionKd,
      entryReason: c.entryReason,
      openPnlKd: c.buyPrice != null && sym.price != null && c.status !== 'CLOSED'
        ? S.round2(((sym.price - c.buyPrice) * c.shares) / 1000) : null,
      book: sym.book || c.entryBook || null,
    };
    if (c.status !== 'CLOSED') openSyms.add(c.symbol);
    if (c.status === 'PENDING_BUY') zones.readyBuy.push(row);
    else if (c.status === 'HOLDING') zones.holding.push(row);
    else if (c.status === 'PENDING_SELL') zones.readySell.push(row);
    else zones.exited.push(row);
  }

  // WATCHING = everything that qualified at any point TODAY and has no open contract.
  //
  // Built from st.candidates (the day's accumulated list), NOT from the current frame.
  // A candidate found in the morning stays visible all session — that is the whole
  // point of a watchlist. Live quote fields are overlaid from the current frame when
  // the symbol is still ticking; when it is not, the last known values are shown and
  // `live: false` lets the UI grey the row rather than drop it.
  //
  // Ordering: still-qualifying rows first, then most recently seen, so the top of the
  // zone is always what is actionable now without losing the rest of the day.
  const cands = Object.values(st.candidates || {});
  cands.sort((a, b) => (b.live === a.live ? (b.lastMinute - a.lastMinute) : (b.live ? 1 : -1)));
  for (const c of cands) {
    if (openSyms.has(c.symbol)) continue;
    const stock = st.stocks[c.symbol];
    if (stock && stock.status === 'BLOCKED') continue;
    const now = f.symbols[c.symbol] || {};
    zones.watching.push({
      symbol: c.symbol,
      price: now.price ?? c.price,
      book: now.book ?? c.book,
      swing: now.swing ?? c.swing ?? null,
      reason: c.live ? (now.entryReason || c.reason) : (c.reason || 'watched earlier today'),
      classification: now.classification ?? c.classification,
      blocked: false,
      live: !!c.live,               // still qualifying on this tick
      firstMinute: c.firstMinute,   // when it first appeared today
      lastMinute: c.lastMinute,     // when it last qualified
      seenCount: c.seenCount,       // how many ticks it has qualified on
    });
  }

  const closed = st.contracts.filter((c) => c.status === 'CLOSED' && c.netKd != null);
  return {
    tradingDay: st.tradingDay, mode: d.cfg.MODE, configVersion: d.version,
    budgetKd: st.budgetKd, reserveKd: st.reserveKd, cashKd: st.cashKd,
    // capital in OPEN positions. Derived from the positions themselves, not from
    // budget-minus-cash: once a day closes green, cash exceeds the starting deployable
    // and that subtraction goes negative, which reads as nonsense on screen.
    deployedKd: S.round2(st.contracts
      .filter((c) => c.status === S.CONTRACT.HOLDING || c.status === S.CONTRACT.PENDING_SELL)
      .reduce((a, c) => a + ((c.buyPrice || 0) * (c.shares || 0)) / 1000, 0)),
    grossKd: S.round2(closed.reduce((a, c) => a + (c.grossKd || 0), 0)),
    commissionKd: S.round2(closed.reduce((a, c) => a + (c.commissionKd || 0), 0)),
    netKd: S.round2(closed.reduce((a, c) => a + (c.netKd || 0), 0)),
    trips: closed.length, wins: closed.filter((c) => c.netKd > 0).length,
    blocked: Object.values(st.stocks).filter((s) => s.status === 'BLOCKED')
      .map((s) => ({ symbol: s.symbol, reason: s.blockedReason, netKd: s.realisedKd })),
    zones,
  };
}

/* confirmFill — the user reports a real fill (live) or accepts the simulated one (paper). */
async function confirmFill(tradingDay, { contractId, side, price, shares }) {
  const d = await stateFor(tradingDay);
  const minute = sessionMinute();
  const ts = new Date().toISOString();
  d.state = side === 'BUY'
    ? TMI.applyBuyFill(d.state, { contractId, price, shares, minute, ts }, d.cfg, LIVE.COMMISSION)
    : TMI.applySellFill(d.state, { contractId, price, minute, ts }, d.cfg, LIVE.COMMISSION);
  for (const c of d.state.contracts) {
    if (c.id === contractId) await repo.upsertContract(c, tradingDay, d.cfg.MODE, d.version);
  }
  const newLogs = d.state.log.slice(d._logged || 0);
  d._logged = d.state.log.length;
  await repo.logActions(newLogs.map((l) => ({ ...l, detail: l })), tradingDay);
  return buildView(d);
}

async function setBudget(tradingDay, budgetKd) {
  const d = await stateFor(tradingDay);
  const reserve = S.round2(budgetKd * d.cfg.BUDGET.reservePct);
  const spent = S.round2(d.state.budgetKd - d.state.reserveKd - d.state.cashKd);
  d.state = { ...d.state, budgetKd, reserveKd: reserve,
    deployableKd: S.round2(budgetKd - reserve), cashKd: S.round2(budgetKd - reserve - spent) };
  return buildView(d);
}

function currentView(tradingDay = kuwaitDay()) {
  const d = days.get(tradingDay);
  return d ? buildView(d) : null;
}

module.exports = { runTick, confirmFill, setBudget, currentView, buildLiveFrame,
  kuwaitDay, sessionMinute, getConfig, stateFor,
  replayDay, loadRecordedDay, isLiveSession, SESSION_MINUTES };