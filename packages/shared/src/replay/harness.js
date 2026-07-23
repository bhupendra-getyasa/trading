'use strict';
/*
 * harness.js — walk-forward replay. Feeds a stored session through the REAL TMI
 * tick(), one minute at a time, with no access to anything after the current minute.
 *
 * WHY THIS EXISTS
 * ---------------
 * Backtesting this strategy lies, and not by a little. The same 20-July tape:
 *     backtest (whole day visible)   +212.0 KD
 *     walk-forward (minute by minute)  −2.3 KD
 * A 214 KD gap on one day, entirely from knowing the future. Every promising
 * number this project produced before walk-forward was hindsight wearing a table.
 *
 * THE ONE RULE OF THIS FILE: buildFrame() may only ever read rows at index <= i.
 * If that invariant breaks anywhere, every number this harness prints is worthless
 * and — worse — it will look plausible.
 */
const TMI = require('../tmi/engine');
const SIG = require('./signals');
const S = require('../tmi/state');
const R = require('../tmi/rules');
const { buildBook } = require('../live-engine/liquidity');

/*
 * buildFrame(session, i, cfg, liqCfg)
 *   session.symbols[sym].rows = full-day rows, oldest -> newest
 *   i = current minute index. NOTHING past it is read.
 */
function buildFrame(session, i, cfg, liqCfg) {
  const symbols = {};
  const ts = session.minutes[i];
  for (const [sym, s] of Object.entries(session.symbols)) {
    // <-- the invariant: nothing past minute i is ever read.
    // Zero/negative prices are DISCARDED, not treated as data. The broker feed emits
    // 0 for symbols it has not populated yet, and a single 0 destroys everything
    // derived from the price path: session range, swings, stop, target. On 19-Jul it
    // gave RASIYAT a 159-fil target from a 609-fil "range" that was really 609-0.
    const rows = s.rows.filter((r) => r.minute <= i && r.price != null && r.price > 0);
    if (rows.length < 3) continue;
    const last = rows[rows.length - 1];

    const book = buildBook(rows.slice(-liqCfg.window).map((r) => r.raw), liqCfg, last.ts);
    const sessionPrices = rows.map((r) => r.price).filter((p) => p != null && p > 0);
    const hi = Math.max(...sessionPrices), lo = Math.min(...sessionPrices);

    // The radar nomination: only visible from the minute it actually fired.
    const nom = s.nomination && s.nomination.minute <= i ? s.nomination : null;
    const isNominationMinute = nom && nom.minute === i;

    symbols[sym] = {
      price: last.price,
      book,
      sessionPrices,
      sessionRangeFils: hi - lo,
      radarQualified: !!(nom && nom.qualified),
      liquidityPass: book && !book.stale && !book.insufficient ? undefined : undefined,
      entrySignal: false, entryPrice: null, entryReason: null,
      _nominated: !!nom,
    };
  }
  return { minute: i, ts, symbols };
}

/*
 * attachSignals — decides, per symbol, whether an entry fires THIS minute.
 * First contract: the radar's nomination minute. After that: TMI's own dip
 * detector, because the radar never fires twice on one symbol in a day.
 */
function attachSignals(frame, session, state, cfg) {
  for (const [sym, f] of Object.entries(frame.symbols)) {
    const s = session.symbols[sym];
    const nom = s.nomination;
    const traded = state.stocks[sym] && state.stocks[sym].contractSeq > 0;

    if (f.entrySignal) continue;                 // signals.js already decided
    if (nom && nom.minute === frame.minute && nom.qualified) {
      f.entrySignal = true; f.entryPrice = nom.price ?? f.price; f.entryReason = 'radar_nomination';
      continue;
    }
    if (traded && f._nominated) {
      const re = R.detectReentry(f.sessionPrices, cfg);
      if (re) { f.entrySignal = true; f.entryPrice = re.price; f.entryReason = re.reason; }
    }
  }
  return frame;
}

/*
 * run(session, config, liqCfg) — replay one day.
 * Returns the final state plus a flat summary. Nothing is printed here; the caller
 * decides how to present it.
 */
/*
 * normalizeSession — accept the /tmi/export payload directly.
 *
 * The export writes flat quote rows ({minute, ts, last_price, bid, bid_qty, ...});
 * buildFrame wants {minute, ts, price, raw}. Doing that conversion HERE, once, means
 * there is no separate adapter to drift out of step with the exporter — the file the
 * server produces is the file the harness eats.
 */
function normalizeSession(session) {
  const first = Object.values(session.symbols)[0];
  if (!first || !first.rows || !first.rows.length || first.rows[0].raw !== undefined) return session;
  const symbols = {};
  for (const [sym, s] of Object.entries(session.symbols)) {
    symbols[sym] = {
      cls: s.cls || null,
      nomination: s.nomination || null,
      rows: s.rows
        .filter((r) => r.last_price != null && r.last_price > 0)
        .map((r) => ({ minute: r.minute, ts: r.ts, price: r.last_price, raw: {
          created_at: new Date(r.ts).toISOString(), last_price: r.last_price,
          bid: r.bid, bid_qty: r.bid_qty, offer: r.offer, offer_qty: r.offer_qty,
          trades: r.trades, high_price: r.high_price, low_price: r.low_price } })),
    };
  }
  return { ...session, symbols };
}

function run(rawSession, config, liqCfg, commissionCfg) {
  const session = normalizeSession(rawSession);
  let state = S.createState({ tradingDay: session.tradingDay, budgetKd: config.BUDGET.defaultKd, config });
  const allActions = [];

  for (let i = 0; i < session.minutes.length; i++) {
    let frame = buildFrame(session, i, config, liqCfg);
    // signal generation lives in signals.js so the entry MODEL is swappable without
    // touching the harness or the engine — the A/B must differ in one place only.
    frame = SIG.attach(frame, session, state, config);
    frame = attachSignals(frame, session, state, config);
    const out = TMI.tick(state, frame, config, commissionCfg);
    state = out.state;
    allActions.push(...out.actions);
  }

  // close anything still open at the bell, at the last seen price
  const lastIdx = session.minutes.length - 1;
  for (const c of state.contracts.filter((x) => x.status !== S.CONTRACT.CLOSED)) {
    const rows = session.symbols[c.symbol].rows.filter((r) => r.price != null);
    const px = rows.length ? rows[rows.length - 1].price : c.buyPrice;
    if (c.status === S.CONTRACT.PENDING_BUY) {
      state = S.updateContract(state, c.id, { status: S.CONTRACT.CLOSED, exitReason: 'EOD_UNFILLED', netKd: 0, grossKd: 0, commissionKd: 0 });
    } else {
      state = S.updateContract(state, c.id, { exitReason: c.exitReason || 'EOD' });
      state = TMI.applySellFill(state, { contractId: c.id, price: px, minute: lastIdx, ts: session.minutes[lastIdx] }, config, commissionCfg);
    }
  }

  const closed = state.contracts.filter((c) => c.status === S.CONTRACT.CLOSED && c.netKd != null && c.buyPrice != null);
  const wins = closed.filter((c) => c.netKd > 0);
  const summary = {
    tradingDay: session.tradingDay,
    budgetKd: config.BUDGET.defaultKd,
    trips: closed.length,
    wins: wins.length,
    losses: closed.length - wins.length,
    grossKd: S.round2(closed.reduce((a, c) => a + (c.grossKd || 0), 0)),
    commissionKd: S.round2(closed.reduce((a, c) => a + (c.commissionKd || 0), 0)),
    netKd: S.round2(closed.reduce((a, c) => a + (c.netKd || 0), 0)),
    roiPct: S.round2((closed.reduce((a, c) => a + (c.netKd || 0), 0) / config.BUDGET.defaultKd) * 100),
    byExit: closed.reduce((m, c) => { m[c.exitReason] = (m[c.exitReason] || 0) + 1; return m; }, {}),
    blocked: Object.values(state.stocks).filter((s) => s.status === 'BLOCKED').map((s) => `${s.symbol}:${s.blockedReason}`),
  };
  return { state, summary, actions: allActions, contracts: closed };
}

module.exports = { run, buildFrame, attachSignals, normalizeSession };
