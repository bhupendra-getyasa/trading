'use strict';
const COMMISSION = require('../live-engine/commission');
/*
 * detector.js — the WAKE-UP DETECTOR.
 *
 * Answers one question at a fixed point in the morning: "which stocks are today
 * offering a move large enough to be worth its own cost?"
 *
 * ─── THE METRIC ────────────────────────────────────────────────────────────
 *
 *   rangeOverCost = (session range so far, as % of price)
 *                   ------------------------------------
 *                   (spread as % of price) + (commission %)
 *
 * "How many times over does today's movement cover what it costs me to trade it?"
 *
 * WHERE IT CAME FROM — worked out by hand from two stocks on 23-Jul, then confirmed
 * across 735 stock-days. It is a mechanism first and a statistic second, which is the
 * opposite of how the failed rules in this project were built.
 *
 *   DIGITUS  1628f  spread 23f (1.41%)  range 6.1%   -> 3.6x   NOT tradeable
 *   KHOT      188f  spread  6f (3.19%)  range 20.6%  -> 5.9x   tradeable
 *
 * Note KHOT's spread is WORSE in percentage terms and it is still the better stock.
 * That is the whole point: a wide spread is fine if the move is big enough, and a
 * tight spread is useless if the stock does not move. Neither number means anything
 * alone — only the ratio does.
 *
 * ─── WHY NOT THE OBVIOUS SIGNALS ───────────────────────────────────────────
 * Correlation with the best trade actually available afterwards (735 stock-days,
 * measured at minute 45):
 *
 *   rangeOverCost   +0.455   <- this
 *   range %         +0.303
 *   trades          +0.255
 *   move %          +0.115   <- DIRECTION BARELY MATTERS
 *   spread          -0.083
 *   depth (KD)      -0.035   <- DEPTH PREDICTS NOTHING ON ITS OWN
 *
 * Depth is a CONSTRAINT (can I get out?) not a SIGNAL (is this worth trading?).
 * Ranking on depth picks the biggest, sleepiest stocks on the exchange.
 *
 * ─── RESULTS ───────────────────────────────────────────────────────────────
 * Average stock-day offers 6.7 KD. Stocks passing this filter offered 63.7 KD, with
 * 75% offering more than 20 KD — roughly 9x better than picking at random.
 *
 * ─── HONEST STATUS ─────────────────────────────────────────────────────────
 * The METRIC is grounded in mechanism and holds across 735 stock-days.
 * The THRESHOLDS below were chosen on those same 7 days and are NOT yet evidence.
 * This has never been run on a day it was not derived from. Treat Sunday as the
 * first real test.
 */

const round2 = (n) => Math.round(n * 100) / 100;

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/*
 * measure(rows, cfg, commissionCfg)
 *   rows : this symbol's quote rows for the session SO FAR, oldest -> newest.
 *          Each needs { price, raw:{ bid, offer, bid_qty, trades } }.
 *   -> the metrics, or null if there is not enough to judge.
 *
 * Reads nothing beyond the rows it is given, so the caller controls the as-of time
 * and no future data can leak in.
 */
function measure(rows, cfg, commissionCfg, opts = {}) {
  const w = rows.filter((r) => r.price > 0 && r.raw && r.raw.bid > 0 && r.raw.offer > 0);
  if (w.length < (cfg.minSamples ?? 15)) return null;

  const px = w.map((r) => r.price);
  const open = px[0], now = px[px.length - 1];
  const rangeFils = Math.round((Math.max(...px) - Math.min(...px)) * 10) / 10;

  // Spread floored at half a fil: the tick is 1 fil, so a "0-spread" reading is a
  // measurement artefact, and dividing by it produces an infinite score on a stock
  // that has not moved. That bug put EKTTITAB — a 1.2-fil range — near the top of
  // the first ranking I built.
  const spreads = w.map((r) => Math.round((r.raw.offer - r.raw.bid) * 10) / 10);
  const spreadFils = Math.max(median(spreads) ?? 99, 0.5);

  const bids = w.filter((r) => r.raw.bid_qty > 0);
  const sellableKd = bids.length
    ? median(bids.map((r) => (r.raw.bid * r.raw.bid_qty) / 1000)) : 0;

  const tr = w.map((r) => r.raw.trades).filter((x) => x != null);
  const trades = tr.length ? Math.max(...tr) - Math.min(...tr) : 0;

  // 27-Jul: commission as a % of notional, from commission.js rather than a hard
  // 0.15%. This matters more than it looks: at small sizes the KD minimum and the
  // 0.500 KD settlement fee dominate, so a flat percentage understates cost on
  // exactly the cheap stocks rangeOverCost is meant to rank. Costed at a reference
  // notional because no share count exists yet at measure time — pass
  // opts.notionalKd (the real slot size) whenever the caller knows it.
  const notionalKd = opts.notionalKd
    ?? commissionCfg.referenceNotionalKd
    ?? 500;
  const rtKd = COMMISSION.roundTripKd(notionalKd, {
    cfg: commissionCfg, market: opts.market, day: opts.day,
  });
  const commPct = 100 * (rtKd / notionalKd);
  const costPct = (100 * spreadFils / now) + commPct;
  const rangePct = 100 * rangeFils / open;

  return {
    price: now, rangeFils, rangePct: round2(rangePct),
    spreadFils, spreadPct: round2(100 * spreadFils / now),
    costPct: round2(costPct),
    rangeOverCost: round2(rangePct / costPct),
    sellableKd: Math.round(sellableKd),
    trades,
    movePct: round2(100 * (now - open) / open),
  };
}

/*
 * verdict(m, cfg) — does it pass, and if not, why not.
 * The reason is always returned: a refusal we cannot explain is one we cannot audit.
 */
function verdict(m, cfg) {
  if (!m) return { pass: false, reason: 'not enough data' };
  const fails = [];
  if (m.rangeOverCost < cfg.minRangeOverCost) fails.push(`roc ${m.rangeOverCost} < ${cfg.minRangeOverCost}`);
  // absolute floor as well as the ratio: a 1.2-fil range on a tight spread scores
  // beautifully and is untradeable. The ratio alone is not enough.
  if (m.rangeFils < cfg.minRangeFils) fails.push(`range ${m.rangeFils}f < ${cfg.minRangeFils}f`);
  if (m.sellableKd < cfg.minSellableKd) fails.push(`sellable ${m.sellableKd} KD < ${cfg.minSellableKd}`);
  if (m.trades < cfg.minTrades) fails.push(`${m.trades} trades < ${cfg.minTrades}`);
  return { pass: fails.length === 0, reason: fails.join(' · ') || 'pass' };
}

/*
 * scan(symbols, cfg, commissionCfg)
 *   symbols : { SYM: rows[] }  — session so far, per symbol
 *   -> every symbol measured, ranked by rangeOverCost, each with its verdict.
 *
 * Returns ALL of them, not just the winners. The ones it refused are the population
 * the thresholds have to be validated against, and "why didn't it pick X?" is only
 * answerable if X was recorded.
 */
function scan(symbols, cfg, commissionCfg, opts = {}) {
  const out = [];
  for (const [sym, rows] of Object.entries(symbols)) {
    const m = measure(rows, cfg, commissionCfg, opts);
    const v = verdict(m, cfg);
    out.push({ symbol: sym, ...(m || {}), pass: v.pass, reason: v.reason });
  }
  out.sort((a, b) => (b.rangeOverCost ?? -1) - (a.rangeOverCost ?? -1));
  return out;
}

module.exports = { scan, measure, verdict };
