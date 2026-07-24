'use strict';
/*
 * decision.js — the standard strategy. Two questions, always asked in this order:
 *
 *   1. MARKET TONE   Is today worth trading at all?      -> GREEN | AMBER | RED
 *   2. STOCK SCORE   Which of today's candidates, if any? -> 0-100 per stock
 *
 * WHY THIS REPLACES THE OLD GATING
 * --------------------------------
 * The previous logic obeyed the radar's HISTORY verdict as a veto: a stock marked
 * MARGINAL or Lane_- could never be traded no matter what it was doing today. That is
 * backwards. History describes what a stock USUALLY does; TMI exists to judge what it is
 * doing NOW. Two measured cases:
 *
 *   SPEC     21-Jul  history_rejected, and the only tradeable up-mover of the day (+9f)
 *   EMIRATES 22-Jul  history_rejected, yet the widest range (11f), most active (63%)
 *                    and most signals (41) of every stock examined that day
 *
 * So history becomes ONE WEIGHTED INPUT, never a veto. Every radar candidate is scored:
 * qualified, history_rejected and over_budget alike. What today's tape says outweighs
 * what last quarter said.
 *
 * "SIT OUT" IS A REAL ANSWER. On a day where breadth is bad and nothing clears the cost
 * of trading, the correct output is "do not trade" — not the least-bad stock. Most of
 * the losses measured across July came from trading days that had nothing to offer.
 */
const LIVE = require('../live-engine/config');

/* commission cost of a round trip, expressed in FILS PER SHARE so it can be compared
 * directly against an expected move. This is the number every edge must clear. */
function roundTripFils(price, shares, commissionCfg = LIVE.COMMISSION) {
  if (!price || !shares) return Infinity;
  const perSide = Math.max(commissionCfg.minKdPerSide ?? 0.5,
    (commissionCfg.pctPerSide ?? 0.0015) * (price * shares) / 1000);
  return (2 * perSide * 1000) / shares;
}

/*
 * marketTone(symbols, cfg) — the day-level verdict, from the tape only.
 *
 *   breadthPct  % of active stocks currently up on the day
 *   medRange    median session range in fils
 *   liquidCount how many stocks could actually be traded right now
 *
 * RED means sit out. That is the output the system was missing: on 21-Jul every
 * configuration tested lost money because it kept trading a day with nothing in it.
 */
function marketTone(symbols, cfg) {
  const list = Object.values(symbols).filter((s) => s.book && !s.book.stale && s.sessionPrices?.length > 20);
  if (list.length < 10) return { tone: 'AMBER', reason: 'not enough data yet', maxStocks: 1, breadthPct: null };

  const up = list.filter((s) => s.sessionPrices[s.sessionPrices.length - 1] > s.sessionPrices[0]).length;
  const breadthPct = Math.round((up / list.length) * 100);

  // The tradeable subset — stocks that actually trade and actually move. Everything
  // below is measured over THIS, not over all ~130 symbols.
  //
  // Measuring the median range across every symbol reads ~2f on every single day,
  // because most of the exchange is always dead. That is a fact about Boursa Kuwait,
  // not about today, and using it as a day-quality signal forced SIT OUT on good days
  // and bad ones alike. What matters is whether the stocks we would actually trade are
  // moving — so the median is taken over the liquid subset.
  const liquid = list.filter((s) =>
    (s.book.tradesPerMin ?? 0) >= cfg.TONE.minTradesPerMin &&
    (s.sessionRangeFils ?? 0) >= cfg.TONE.minRangeFils);
  const liquidCount = liquid.length;
  const ranges = (liquid.length ? liquid : list).map((s) => s.sessionRangeFils ?? 0).sort((a, b) => a - b);
  const medRange = Math.round((ranges[Math.floor(ranges.length / 2)] || 0) * 10) / 10;

  // breadth among the tradeable subset matters more than exchange-wide breadth: a day
  // can be broadly red while the handful of movers are climbing (20-Jul: 60% of the
  // market down, and EMIRATES was the best stock of the week).
  const liqUp = liquid.filter((s) => s.sessionPrices[s.sessionPrices.length - 1] > s.sessionPrices[0]).length;
  const liqBreadthPct = liquid.length ? Math.round((liqUp / liquid.length) * 100) : 0;

  const reasons = [];
  let score = 0;
  // judged on the movers, with exchange-wide breadth reported for context only.
  // When there are NO movers the percentage is a division by zero, and reporting it as
  // "0% up" reads as "every mover is falling" when the truth is "there is nothing to
  // measure". Different situations, and the log has to say which one it is.
  if (!liquid.length) reasons.push('no stocks both trading and moving');
  else if (liqBreadthPct >= cfg.TONE.goodBreadthPct) { score += 2; reasons.push(`movers ${liqBreadthPct}% up`); }
  else if (liqBreadthPct >= cfg.TONE.weakBreadthPct) { score += 1; reasons.push(`movers ${liqBreadthPct}% up (weak)`); }
  else reasons.push(`movers ${liqBreadthPct}% up (poor)`);

  if (medRange >= cfg.TONE.goodMedRangeFils) { score += 2; reasons.push(`median range ${medRange}f`); }
  else if (medRange >= cfg.TONE.minRangeFils) { score += 1; reasons.push(`median range ${medRange}f (thin)`); }
  else reasons.push(`median range ${medRange}f (dead)`);

  if (liquidCount >= cfg.TONE.goodLiquidCount) { score += 2; reasons.push(`${liquidCount} tradeable`); }
  else if (liquidCount >= 1) { score += 1; reasons.push(`only ${liquidCount} tradeable`); }
  else reasons.push('nothing tradeable');

  const tone = score >= cfg.TONE.greenScore ? 'GREEN' : score >= cfg.TONE.amberScore ? 'AMBER' : 'RED';
  const maxStocks = tone === 'GREEN' ? cfg.SELECTION.maxConcurrentStocks : tone === 'AMBER' ? 1 : 0;
  return { tone, score, breadthPct, liqBreadthPct, medRange, liquidCount, maxStocks,
    reason: reasons.join(' · ') + ` (market ${breadthPct}% up)` };
}

/*
 * scoreStock — every radar candidate, judged on TODAY.
 *
 * Four components, each capped, then history applied as a modifier rather than a gate:
 *   LIQUIDITY  can we get in and out at the size we want
 *   MOVEMENT   is there enough range to be worth the cost
 *   DIRECTION  is it going up right now
 *   EDGE       does the expected move clear commission, with margin
 *
 * `tradeable` is false when EDGE fails, whatever the total score. A stock that cannot
 * pay for its own commission is not a trade at any score — SANAM on 22-Jul moved the
 * right way, won its trade, and still lost money on the round trip.
 */
function scoreStock(sym, s, cfg, budgetKd) {
  const out = { symbol: sym, score: 0, tradeable: false, parts: {}, notes: [] };
  const book = s.book;
  const price = s.price;
  if (!book || book.stale || !price) { out.notes.push('no book'); return out; }

  const shares = Math.floor(Math.min(
    (budgetKd * 1000) / price,
    (book.medBidQty ?? 0) * cfg.SIZING.bookDepthPct) / cfg.SIZING.lotSize) * cfg.SIZING.lotSize;
  out.shares = shares;
  if (shares < cfg.SIZING.minLot) { out.notes.push('cannot size'); return out; }

  // LIQUIDITY (0-30)
  const depthRatio = (book.medBidQty ?? 0) / Math.max(shares, 1);
  const liq = Math.min(30,
    Math.min(15, depthRatio * 5) +
    Math.min(10, (book.tradesPerMin ?? 0) * 2.5) +
    Math.min(5, (book.activePct ?? 0) / 12));
  out.parts.liquidity = Math.round(liq);

  // MOVEMENT (0-25)
  const range = s.sessionRangeFils ?? 0;
  const mv = Math.min(25, (range / 20) * 25);
  out.parts.movement = Math.round(mv);

  // DIRECTION (0-25) — where price sits in today's range, plus recent slope
  const px = s.sessionPrices || [];
  const lo = Math.min(...px), hi = Math.max(...px);
  const pos = hi > lo ? (price - lo) / (hi - lo) : 0.5;
  const recent = px.slice(-10);
  const rising = recent.length > 2 && recent[recent.length - 1] > recent[0];
  const dir = Math.min(25, pos * 15 + (rising ? 10 : 0));
  out.parts.direction = Math.round(dir);

  // EDGE (0-20) — expected move against the cost of the round trip
  // swingScale: the size of the last completed up-swing, used to rank how much room
  // this stock is currently offering. NOT a forecast — measured across 1,709 signals it
  // overstates the actual best case by 2.17x (avg 4.85f claimed vs 2.24f realised).
  // What it IS good at is ranking: signals in the 10-15f band reached +5f 64% of the
  // time against 9% in the 3-5f band. So it works as a VOLATILITY FILTER, not a target.
  const swingScale = s.swing1Fils ?? Math.max(2, range * 0.35);
  const cost = roundTripFils(price, shares);
  const spread = book.medSpreadFils ?? 1;
  const netEdge = swingScale - cost - spread;

  // AND THE FLOOR MUST BE IN KD, NOT FILS.
  // Profit is fils x SHARES, and share count is set by price and book depth. On 22-Jul:
  //   ASC       708f, 1,200 shares affordable, +12f move -> +14.4 KD gross
  //   EMIRATES  152f, 23,000 shares affordable, +5f move -> +115 KD gross
  // A 5-fil move on the cheap stock was worth EIGHT TIMES a 12-fil move on the expensive
  // one. A floor denominated in fils rejects exactly the cheap, deep-book names where the
  // size does the work — it refused that EMIRATES trade outright.
  const realisedFils = netEdge / 2.17;                      // de-bias, see swingScale above
  const expectedNetKd = (realisedFils * shares) / 1000;
  out.parts.edge = Math.max(0, Math.min(20, Math.round((expectedNetKd / 20) * 20)));
  out.swingScaleFils = Math.round(swingScale * 10) / 10;
  out.costFils = Math.round(cost * 100) / 100;
  out.netEdgeFils = Math.round(netEdge * 10) / 10;
  out.expectedNetKd = Math.round(expectedNetKd * 10) / 10;

  let score = liq + mv + dir + out.parts.edge;

  // HISTORY as a MODIFIER, never a veto. A stock the classifier dislikes has to be
  // clearly better on today's tape to make up the difference — but it CAN.
  const lane = s.classification?.lane;
  const profile = s.classification?.profile;
  if (lane && LIVE.HISTORY.qualifyLanes.includes(lane)) { score += cfg.SCORE.historyBonus; out.notes.push('history ok'); }
  else if (profile === 'DEAD') { score += cfg.SCORE.deadPenalty; out.notes.push('history DEAD'); }
  else { score += cfg.SCORE.rejectedPenalty; out.notes.push('history weak — judged on today'); }

  out.score = Math.max(0, Math.round(score));
  // hard requirement: the move must clear its own cost with margin
  // The EDGE FLOOR is the gate. minScore defaults to 0 because it was measured to change
  // nothing (see config). The score still ranks candidates when more than one clears the
  // floor, and is shown on screen to explain the call.
  const floorKd = cfg.SCORE.minNetEdgeKd;
  const passKd = floorKd == null || expectedNetKd >= floorKd;
  const passFils = !cfg.SCORE.minNetEdgeFils || netEdge >= cfg.SCORE.minNetEdgeFils;
  out.tradeable = passKd && passFils && out.score >= (cfg.SCORE.minScore || 0);
  if (!out.tradeable) {
    if (!passKd) out.notes.push(`edge ${out.expectedNetKd} KD < ${floorKd} KD needed`);
    else if (!passFils) out.notes.push(`edge ${out.netEdgeFils}f < ${cfg.SCORE.minNetEdgeFils}f needed`);
    else out.notes.push(`score ${out.score} < ${cfg.SCORE.minScore}`);
  }
  return out;
}

/*
 * decide(frame, cfg, budgetKd) — the whole answer, in one call.
 * Returns the market verdict plus every candidate ranked, so the UI can show WHY a
 * stock was passed over as easily as why one was taken.
 */
function decide(frame, cfg, budgetKd) {
  const tone = marketTone(frame.symbols, cfg);
  const perStock = budgetKd * (1 - cfg.BUDGET.reservePct) / Math.max(1, cfg.SELECTION.maxConcurrentStocks);
  const candidates = Object.entries(frame.symbols)
    .filter(([, s]) => s.nominated || s.radarQualified || s.entrySignal)   // EVERY radar candidate
    .map(([sym, s]) => scoreStock(sym, s, cfg, perStock))
    .sort((a, b) => b.score - a.score);

  const picks = tone.maxStocks === 0 ? [] : candidates.filter((c) => c.tradeable).slice(0, tone.maxStocks);
  return { tone, candidates, picks,
    verdict: tone.maxStocks === 0 ? `SIT OUT — ${tone.reason}`
      : picks.length === 0 ? `NO TRADE — ${candidates.length} candidates, none clear the cost of trading`
      : `TRADE ${picks.map((p) => p.symbol).join(', ')}` };
}

module.exports = { marketTone, scoreStock, decide, roundTripFils };
