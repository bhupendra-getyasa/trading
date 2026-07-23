'use strict';
/*
 * state.js — the TMI state shape and its transitions. Pure: no IO, no clock, no
 * randomness. Every mutation returns a new object so the replay harness can hold
 * a whole session's states in memory and diff them.
 *
 * TWO STATE MACHINES, deliberately separate:
 *
 *   STOCK    WATCH ──► ACTIVE ──► BLOCKED
 *            (nominated)  (tradable now)  (done for the day, never revived)
 *
 *   CONTRACT PENDING_BUY ──► HOLDING ──► PENDING_SELL ──► CLOSED
 *
 * The distinction matters because it is what the UI zones are built on, and
 * because WATCH is revivable while BLOCKED is not. A stock that is merely quiet
 * drops back to WATCH and can wake up later (RASIYAT was flat until 10:36 and
 * then trended all day). A stock that lost money twice is BLOCKED and stays out.
 *
 * ONE OPEN CONTRACT PER STOCK. Contracts are sequenced C1, C2, C3... and each is
 * its own row for its whole life — never merged, never reused.
 */

const STOCK = { WATCH: 'WATCH', ACTIVE: 'ACTIVE', BLOCKED: 'BLOCKED' };
const CONTRACT = { PENDING_BUY: 'PENDING_BUY', HOLDING: 'HOLDING', PENDING_SELL: 'PENDING_SELL', CLOSED: 'CLOSED' };

// UI zones, derived — never stored. The screen is a projection of state, so the
// two can never drift apart.
const ZONE = {
  WATCHING: 1,      // active, no signal yet
  READY_BUY: 2,
  HOLDING: 3,       // bought, hold
  READY_SELL: 4,
  EXITED: 5,
};

function createState({ tradingDay, budgetKd, config }) {
  const reserveKd = round2(budgetKd * config.BUDGET.reservePct);
  return {
    tradingDay,
    budgetKd,
    reserveKd,
    deployableKd: round2(budgetKd - reserveKd),
    cashKd: round2(budgetKd - reserveKd),   // reserve is not spendable by the normal path
    stocks: {},        // symbol -> stock record
    contracts: [],     // every contract ever opened today, in order
    nextContractId: 1,
    realisedKd: 0,
    commissionKd: 0,
    log: [],           // append-only, timestamped; this is the audit trail
  };
}

function ensureStock(state, symbol) {
  if (state.stocks[symbol]) return state;
  return {
    ...state,
    stocks: {
      ...state.stocks,
      [symbol]: {
        symbol,
        status: STOCK.WATCH,
        contractSeq: 0,
        failedSetups: 0,
        realisedKd: 0,
        lastSell: null,        // { price, minute }
        banUntilMinute: null,
        blockedReason: null,
      },
    },
  };
}

function openContract(state, { symbol, minute, price, shares, target, stop, reason, book }) {
  const stock = state.stocks[symbol];
  const seq = stock.contractSeq + 1;
  const contract = {
    id: state.nextContractId,
    symbol,
    seq,                                  // C1, C2, C3...
    status: CONTRACT.PENDING_BUY,
    signalMinute: minute,
    signalPrice: price,
    shares,
    target,                               // fils
    stop,                                 // fils
    entryReason: reason,
    entryBook: book || null,              // the book AT SIGNAL — so a fill can later be
                                          // judged against what was actually there
    buyPrice: null, buyMinute: null,
    sellPrice: null, sellMinute: null,
    peak: null,
    quietRun: 0,
    exitReason: null,
    grossKd: null, commissionKd: null, netKd: null,
  };
  return {
    ...state,
    nextContractId: state.nextContractId + 1,
    contracts: [...state.contracts, contract],
    stocks: { ...state.stocks, [symbol]: { ...stock, contractSeq: seq, status: STOCK.ACTIVE } },
  };
}

function updateContract(state, id, patch) {
  return { ...state, contracts: state.contracts.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

function openContractFor(state, symbol) {
  return state.contracts.find((c) => c.symbol === symbol && c.status !== CONTRACT.CLOSED) || null;
}

function blockStock(state, symbol, reason) {
  const s = state.stocks[symbol];
  if (!s) return state;
  return { ...state, stocks: { ...state.stocks, [symbol]: { ...s, status: STOCK.BLOCKED, blockedReason: reason } } };
}

function appendLog(state, entry) {
  return { ...state, log: [...state.log, entry] };
}

/*
 * zoneOf(contract) — the UI zone a row belongs in. Contracts move DOWN through the
 * zones as their state changes; a closed contract retires to EXITED and the next
 * one appears as a fresh row above.
 */
function zoneOf(contract) {
  switch (contract.status) {
    case CONTRACT.PENDING_BUY: return ZONE.READY_BUY;
    case CONTRACT.HOLDING: return ZONE.HOLDING;
    case CONTRACT.PENDING_SELL: return ZONE.READY_SELL;
    case CONTRACT.CLOSED: return ZONE.EXITED;
    default: return ZONE.WATCHING;
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { STOCK, CONTRACT, ZONE, createState, ensureStock, openContract,
  updateContract, openContractFor, blockStock, appendLog, zoneOf, round2 };
