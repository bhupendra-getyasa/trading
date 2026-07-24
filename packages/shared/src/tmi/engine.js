'use strict';
/*
 * engine.js — TMI's per-minute tick. PURE: same input, same output, no IO, no clock.
 *
 * THIS IS THE FUNCTION THE HARNESS AND THE LIVE SERVICE BOTH CALL. That is not a
 * convenience — it is the whole point. Every earlier "result" in this project came
 * from a throwaway script that re-implemented the strategy, so we were validating
 * code that would never ship. Same tick(), or the validation means nothing.
 *
 *   tick(state, frame, config) -> { state, actions }
 *
 *   frame = {
 *     minute,                        // integer index into the session
 *     ts,                            // ISO string, for the audit log only
 *     symbols: {
 *       SYM: {
 *         price,                     // fils, now
 *         book,                      // from live-engine/liquidity.buildBook (may be null)
 *         sessionPrices: [...],      // session-so-far, oldest -> newest
 *         sessionRangeFils,          // broker high-low SO FAR (knowable live)
 *         radarQualified,            // Gate 2 said yes
 *         liquidityPass,             // Gate 1b verdict
 *         entrySignal,               // the radar fired an entry this minute
 *         entryPrice, entryReason,
 *       }
 *     }
 *   }
 *
 * Order within a tick is deliberate: EXITS BEFORE ENTRIES. Freeing capital and
 * closing risk always precedes taking more of it, and it means a stock can exit and
 * a different one enter in the same minute without the second seeing stale cash.
 */
const S = require('./state');
const R = require('./rules');
const D = require('./decision');

function commissionKd(price, shares, cfg) {
  const tradeKd = (price * shares) / 1000;
  return Math.max(cfg.minKdPerSide ?? 0.5, (cfg.pctPerSide ?? 0.0015) * tradeKd);
}

function tick(state, frame, config, commissionCfg = { pctPerSide: 0.0015, minKdPerSide: 0.5 }) {
  const actions = [];
  let st = state;
  const paper = config.MODE === 'paper';
  const slip = config.FILLS.slippageFils || 0;

  // ── 1. manage open contracts ───────────────────────────────────────────────
  for (const c of st.contracts.filter((x) => x.status === S.CONTRACT.HOLDING)) {
    const sym = frame.symbols[c.symbol];
    if (!sym || sym.price == null) continue;

    const tpm = sym.book ? sym.book.tradesPerMin : null;
    const quietRun = tpm != null && tpm <= config.EXIT.quietMaxTradesPerMin ? c.quietRun + 1 : 0;
    const peak = Math.max(c.peak ?? c.buyPrice, sym.price);
    st = S.updateContract(st, c.id, { quietRun, peak });

    const decision = R.shouldExit({ contract: { ...c, quietRun, peak }, sym, cfg: config, minute: frame.minute });
    if (!decision) continue;

    st = S.updateContract(st, c.id, { status: S.CONTRACT.PENDING_SELL, exitReason: decision.reason });
    actions.push({ type: 'SELL_SIGNAL', symbol: c.symbol, contractId: c.id, seq: c.seq,
      price: decision.sell, shares: c.shares, reason: decision.reason, minute: frame.minute });
    st = S.appendLog(st, { minute: frame.minute, ts: frame.ts, symbol: c.symbol, contractId: c.id,
      event: 'SELL_SIGNAL', price: decision.sell, reason: decision.reason });

    // paper mode fills its own signals so replay is deterministic; live waits for
    // the user's confirmed fill via applySellFill().
    if (paper) st = applySellFill(st, { contractId: c.id, price: decision.sell - slip, minute: frame.minute, ts: frame.ts }, config, commissionCfg);
  }

  // ── 2. paper mode: fill any pending buys ───────────────────────────────────
  if (paper) {
    for (const c of st.contracts.filter((x) => x.status === S.CONTRACT.PENDING_BUY)) {
      st = applyBuyFill(st, { contractId: c.id, price: c.signalPrice + slip, shares: c.shares, minute: frame.minute, ts: frame.ts }, config, commissionCfg);
    }
  }

  // ── 3. look for new entries ────────────────────────────────────────────────
  const openStocks = new Set(st.contracts.filter((c) => c.status !== S.CONTRACT.CLOSED).map((c) => c.symbol));

  // THE STANDARD STRATEGY. Two questions: is today worth trading, and if so what.
  // "Sit out" is a real answer — most of July's losses came from trading days that had
  // nothing in them. Candidates are ranked on TODAY's evidence (liquidity, movement,
  // direction, edge-after-cost) with history as a modifier rather than a veto, because
  // the classifier rejected the best stock of the day twice in one week.
  let toneMaxStocks = config.SELECTION.maxConcurrentStocks;
  let scoreBy = null;
  if (config.SELECTION.useDecisionFramework) {
    const dec = D.decide(frame, config, st.budgetKd);
    st = S.appendLog(st, { minute: frame.minute, ts: frame.ts, event: 'TONE',
      reason: `${dec.tone.tone} — ${dec.tone.reason}`, detail: { tone: dec.tone, verdict: dec.verdict } });
    toneMaxStocks = dec.tone.maxStocks;
    scoreBy = new Map(dec.candidates.map((c) => [c.symbol, c]));
    if (toneMaxStocks === 0) {
      actions.push({ type: 'SIT_OUT', reason: dec.tone.reason, minute: frame.minute });
      return { state: st, actions };                       // no entries today, at this minute
    }
  }

  const candidates = Object.entries(frame.symbols)
    .filter(([symbol, sym]) => sym.entrySignal && !openStocks.has(symbol))
    .filter(([symbol]) => !scoreBy || (scoreBy.get(symbol) && scoreBy.get(symbol).tradeable))
    .sort((a, b) => scoreBy
      ? (scoreBy.get(b[0])?.score ?? 0) - (scoreBy.get(a[0])?.score ?? 0)
      : (b[1].sessionRangeFils ?? 0) - (a[1].sessionRangeFils ?? 0));  // most movement first

  // Slot budget for THIS minute. During the opening window we deliberately hold slots
  // back rather than let the first-firing nominations take them all.
  const inOpening = (config.SELECTION.openingWindowMinutes || 0) > 0
    && frame.minute < config.SELECTION.openingWindowMinutes;
  const slotCap = Math.min(
    toneMaxStocks,                                          // the day's verdict caps everything
    inOpening ? Math.min(config.SELECTION.maxConcurrentStocks, config.SELECTION.maxStocksInOpeningWindow)
              : config.SELECTION.maxConcurrentStocks);

  for (const [symbol, sym] of candidates) {
    if (openStocks.size >= slotCap) break;
    st = S.ensureStock(st, symbol);
    const stock = st.stocks[symbol];

    const gate = R.canEnter({ stock, sym, minute: frame.minute, openCount: openStocks.size, cfg: config, slotCap });
    if (!gate.ok) {
      // A refusal is recorded, not discarded. "Why didn't it buy X?" must be
      // answerable from the log alone, weeks later.
      st = S.appendLog(st, { minute: frame.minute, ts: frame.ts, symbol, event: 'SKIP', reason: gate.reason });
      actions.push({ type: 'SKIP', symbol, reason: gate.reason, minute: frame.minute });
      continue;
    }

    const sliceKd = st.deployableKd / config.SELECTION.maxConcurrentStocks;
    const affordable = Math.min(sliceKd, st.cashKd);
    const sizing = R.computeShares({ price: sym.price, sliceKd: affordable, book: sym.book }, config);
    if (sizing.shares <= 0) {
      st = S.appendLog(st, { minute: frame.minute, ts: frame.ts, symbol, event: 'SKIP', reason: `size:${sizing.reason}` });
      actions.push({ type: 'SKIP', symbol, reason: `size:${sizing.reason}`, minute: frame.minute });
      continue;
    }

    const { target, reason: targetReason } = R.computeTarget(sym.sessionPrices || [], config);
    // sanity guard: a target far beyond anything the stock has actually done means the
    // price path is corrupt (zeros, a split, a bad tick). Refuse rather than trade it.
    if (sym.sessionRangeFils != null && target > sym.sessionRangeFils * 1.5) {
      st = S.appendLog(st, { minute: frame.minute, ts: frame.ts, symbol, event: 'SKIP', reason: `bad_target ${target}f vs ${Math.round(sym.sessionRangeFils)}f range` });
      actions.push({ type: 'SKIP', symbol, reason: `bad_target ${target}f`, minute: frame.minute });
      continue;
    }
    const { stop, reason: stopReason } = R.computeStop(sym.sessionRangeFils, config, sym.price);

    st = S.openContract(st, { symbol, minute: frame.minute, price: sym.price, shares: sizing.shares,
      target, stop, reason: gate.reason, book: sym.book });
    const contract = st.contracts[st.contracts.length - 1];
    openStocks.add(symbol);

    actions.push({ type: 'BUY_SIGNAL', symbol, contractId: contract.id, seq: contract.seq,
      price: sym.price, shares: sizing.shares, target, stop, minute: frame.minute,
      reason: gate.reason, sizing: sizing.reason, targetReason, stopReason });
    st = S.appendLog(st, { minute: frame.minute, ts: frame.ts, symbol, contractId: contract.id,
      event: 'BUY_SIGNAL', price: sym.price, shares: sizing.shares,
      reason: gate.reason, target, stop, targetReason, stopReason, sizing: sizing.reason });

    if (paper) st = applyBuyFill(st, { contractId: contract.id, price: sym.price + slip, shares: sizing.shares, minute: frame.minute, ts: frame.ts }, config, commissionCfg);
  }

  return { state: st, actions };
}

/* applyBuyFill — live: the user's real fill. paper: the simulated one. */
function applyBuyFill(state, { contractId, price, shares, minute, ts }, config, commissionCfg) {
  const c = state.contracts.find((x) => x.id === contractId);
  if (!c || c.status !== S.CONTRACT.PENDING_BUY) return state;
  const sh = shares ?? c.shares;
  const comm = commissionKd(price, sh, commissionCfg);
  let st = S.updateContract(state, contractId, {
    status: S.CONTRACT.HOLDING, buyPrice: price, buyMinute: minute, shares: sh, peak: price, commissionKd: comm });
  st = { ...st, cashKd: S.round2(st.cashKd - (price * sh) / 1000), commissionKd: S.round2(st.commissionKd + comm) };
  return S.appendLog(st, { minute, ts, symbol: c.symbol, contractId, event: 'BUY_FILL', price, shares: sh, commissionKd: S.round2(comm) });
}

/* applySellFill — closes the contract, books the P&L, and applies the risk limits. */
function applySellFill(state, { contractId, price, minute, ts }, config, commissionCfg) {
  const c = state.contracts.find((x) => x.id === contractId);
  if (!c || (c.status !== S.CONTRACT.PENDING_SELL && c.status !== S.CONTRACT.HOLDING)) return state;

  const comm = commissionKd(price, c.shares, commissionCfg);
  const gross = ((price - c.buyPrice) * c.shares) / 1000;
  const totalComm = (c.commissionKd || 0) + comm;
  const net = gross - totalComm;

  let st = S.updateContract(state, contractId, {
    status: S.CONTRACT.CLOSED, sellPrice: price, sellMinute: minute,
    grossKd: S.round2(gross), commissionKd: S.round2(totalComm), netKd: S.round2(net),
    exitReason: c.exitReason || 'MANUAL' });

  st = { ...st,
    cashKd: S.round2(st.cashKd + (price * c.shares) / 1000),
    realisedKd: S.round2(st.realisedKd + net),
    commissionKd: S.round2(st.commissionKd + comm) };

  const stock = st.stocks[c.symbol];
  const stockNet = S.round2(stock.realisedKd + net);
  const failedSetups = net < 0 ? stock.failedSetups + 1 : stock.failedSetups;
  st = { ...st, stocks: { ...st.stocks, [c.symbol]: { ...stock,
    realisedKd: stockNet,
    failedSetups,
    status: S.STOCK.WATCH,                       // back to WATCH; may re-arm if the gate reopens
    lastSell: { price, minute },                 // feeds the anti-chase rule
    banUntilMinute: net < 0 ? minute + config.REENTRY.failBanMinutes : stock.banUntilMinute,
  } } };

  st = S.appendLog(st, { minute, ts, symbol: c.symbol, contractId, event: 'SELL_FILL',
    price, netKd: S.round2(net), exitReason: c.exitReason });

  // risk limits, checked only on realised P&L — never on unrealised marks
  if (stockNet <= config.RISK.perStockMaxLossKd) {
    st = S.blockStock(st, c.symbol, `loss_limit ${stockNet} KD`);
    st = S.appendLog(st, { minute, ts, symbol: c.symbol, event: 'BLOCK', reason: `loss_limit ${stockNet} KD` });
  } else if (failedSetups >= config.RISK.maxFailedSetups) {
    st = S.blockStock(st, c.symbol, `${failedSetups} failed setups`);
    st = S.appendLog(st, { minute, ts, symbol: c.symbol, event: 'BLOCK', reason: `${failedSetups} failed setups` });
  }
  return st;
}

module.exports = { tick, applyBuyFill, applySellFill, commissionKd };
