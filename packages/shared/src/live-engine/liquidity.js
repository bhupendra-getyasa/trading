'use strict';
/*
 * liquidity.js — the ORDER-BOOK layer. Reads public.stock_quotes (broker feed),
 * which is the ONLY source in this platform with bid/offer/depth/trade-count.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now the engine judged a stock from price+volume alone (market_stock_snapshots).
 * That cannot distinguish a stock you can actually trade from one that only LOOKS
 * tradable on a chart. Two real cases from July data:
 *   ASC 14-Jul      — clean 700<->708 oscillation on the chart, but median bid depth
 *                     726 shares and ~1 trade/min, with 30-minute frozen quotes.
 *                     Untradable in size; the chart said otherwise.
 *   EMIRATES 14-Jul — 16,300-share bid (deep!) but a 4-fil day range and ~1 trade/min.
 *                     Deep book, no movement, no trades = mirage.
 *   EMIRATES 20-Jul — SAME symbol, 25-fil range, 4 trades/min, 75% active minutes.
 *                     Genuinely the best stock of that day.
 * The verdict is per-DAY, not per-symbol. So this must be evaluated live, every cycle,
 * never baked into classification.
 *
 * DESIGN RULES
 * ------------
 * 1. MEASURE ALWAYS, BLOCK OPTIONALLY. Metrics are computed and recorded on every
 *    symbol every cycle regardless of mode, so we accumulate the data needed to
 *    validate the thresholds before we ever let them hide a stock.
 * 2. FAIL OPEN. If the quote feed is missing, stale, or thin on samples, this returns
 *    pass=true with stale/insufficient flagged. A scraper hiccup must never silently
 *    mute the whole radar — that failure mode is worse than a bad fill.
 * 3. SESSION-TO-DATE ONLY. rangeFils uses the broker's high_price/low_price, which are
 *    the day's high/low SO FAR. Nothing here reads a value that is unknowable at the
 *    moment of the decision.
 *
 * All thresholds come from CONFIG.LIQUIDITY. Nothing is hardcoded.
 */
const U = require('./lib/util');

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\u2212/g, '-').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

function median(arr) {
  const a = arr.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/*
 * buildBook(quoteRows, cfg, now)
 *   quoteRows : rows from public.stock_quotes for ONE symbol, oldest -> newest.
 *   -> a book panel. Every field may be null; callers must not assume presence.
 *
 * `trades` in the feed is CUMULATIVE for the session, so per-minute activity is its
 * first difference. Negative diffs (session reset / scraper re-read) are discarded
 * rather than clamped to 0, so they don't count as a "quiet" minute and trip the
 * quiet-tape logic downstream.
 */
function buildBook(quoteRows, cfg, now = Date.now()) {
  const out = {
    samples: 0, ageMin: null, stale: true, insufficient: true,
    bid: null, offer: null, spreadFils: null, medSpreadFils: null,
    bidQty: null, offerQty: null, medBidQty: null, medOfferQty: null,
    tradesTotal: null, tradesPerMin: null, tradesPerActiveMin: null, activePct: null,
    rangeFils: null, lastPrice: null, imbalance: null,
  };
  if (!Array.isArray(quoteRows) || !quoteRows.length) return out;

  const rows = quoteRows
    .map((r) => ({
      ts: r.created_at ? new Date(r.created_at).getTime() : null,
      last: num(r.last_price), bid: num(r.bid), offer: num(r.offer),
      bidQty: num(r.bid_qty), offerQty: num(r.offer_qty), trades: num(r.trades),
      high: num(r.high_price), low: num(r.low_price),
    }))
    .filter((r) => r.ts != null);
  if (!rows.length) return out;

  const latest = rows[rows.length - 1];
  out.samples = rows.length;
  out.ageMin = U.round2((now - latest.ts) / 60000);
  out.stale = out.ageMin > (cfg.quoteStalenessMin ?? 5);
  out.insufficient = rows.length < (cfg.minSamples ?? 5);

  out.lastPrice = latest.last;
  out.bid = latest.bid;
  out.offer = latest.offer;
  out.bidQty = latest.bidQty;
  out.offerQty = latest.offerQty;
  out.tradesTotal = latest.trades;
  if (latest.bid != null && latest.offer != null) out.spreadFils = U.round1(latest.offer - latest.bid);
  if (latest.bidQty != null && latest.offerQty != null && latest.offerQty > 0) {
    out.imbalance = U.round2(latest.bidQty / latest.offerQty);
  }

  // per-minute trade activity from the cumulative counter
  const deltas = [];
  for (let i = 1; i < rows.length; i++) {
    const d = (rows[i].trades ?? null) != null && (rows[i - 1].trades ?? null) != null
      ? rows[i].trades - rows[i - 1].trades : null;
    if (d != null && d >= 0) deltas.push(d);
  }
  if (deltas.length) {
    const active = deltas.filter((d) => d > 0);
    // tradesPerMin is the MEAN across every minute in the window — the plain reading of
    // "how often does this trade". It must NOT be a median: a stock active in 40% of
    // minutes has a median of 0, so a median-based threshold rejects everything that
    // trades in bursts, which is most of this market. (Caught in testing against ASC /
    // CLEANING 14-Jul, where act% was 37-74% but the median delta was 0-1.)
    out.tradesPerMin = U.round2(deltas.reduce((s, d) => s + d, 0) / deltas.length);
    // ...and this is the burst intensity WHEN it trades, kept separate so the two
    // questions ("how often" vs "how hard") never get conflated again.
    out.tradesPerActiveMin = active.length ? U.round2(median(active)) : 0;
    out.activePct = U.round1((active.length / deltas.length) * 100);
  }

  // depth medians taken over ACTIVE minutes only: a frozen quote repeats the same
  // resting size for 30 minutes and would otherwise dominate the median (ASC 14-Jul).
  const activeRows = [];
  for (let i = 1; i < rows.length; i++) {
    const d = (rows[i].trades ?? null) != null && (rows[i - 1].trades ?? null) != null
      ? rows[i].trades - rows[i - 1].trades : null;
    if (d != null && d > 0) activeRows.push(rows[i]);
  }
  const depthRows = activeRows.length ? activeRows : rows;
  out.medBidQty = median(depthRows.map((r) => r.bidQty));
  out.medOfferQty = median(depthRows.map((r) => r.offerQty));
  const spreads = depthRows
    .filter((r) => r.bid != null && r.offer != null)
    .map((r) => r.offer - r.bid);
  out.medSpreadFils = spreads.length ? U.round1(median(spreads)) : null;

  // session-to-date range: prefer the broker's own H/L (authoritative for the day),
  // fall back to the observed window if the feed omits them.
  const hi = latest.high ?? Math.max(...rows.map((r) => r.last).filter((x) => x != null));
  const lo = latest.low ?? Math.min(...rows.map((r) => r.last).filter((x) => x != null));
  if (Number.isFinite(hi) && Number.isFinite(lo)) out.rangeFils = U.round1(hi - lo);

  return out;
}

/*
 * evaluateLiquidity(book, { shares }, cfg)
 *   shares : the size we would actually want to trade. The depth test is RELATIVE to
 *            it — 726 shares of depth is fine for 300 shares and useless for 2,000.
 *   -> { pass, blocked, checks[], reasons[] }
 *
 * `pass` is the verdict; `blocked` is whether that verdict should actually stop the
 * trade, which depends on cfg.mode. In 'warn' mode blocked is always false and the
 * verdict is recorded only — that is how we collect evidence before enforcing.
 */
function evaluateLiquidity(book, { shares } = {}, cfg = {}) {
  const checks = [];
  const add = (name, ok, actual, need) => checks.push({ check: name, ok, actual, need });

  if (!cfg.enabled) return { pass: true, blocked: false, checks, reasons: [], skipped: 'disabled' };
  // FAIL OPEN — see design rule 2.
  if (!book || book.stale || book.insufficient) {
    return { pass: true, blocked: false, checks,
      reasons: [{ signal: 'liquidity_unknown', stale: book?.stale ?? true, samples: book?.samples ?? 0 }],
      skipped: 'no_book' };
  }

  const needShares = shares != null && shares > 0 ? shares : null;
  const depthNeeded = needShares != null ? needShares * (cfg.depthVsSizePct ?? 0.5) : null;
  const depthOk = depthNeeded == null || (book.medBidQty ?? 0) >= depthNeeded;
  add('depth', depthOk, book.medBidQty, depthNeeded);

  const tpmOk = (book.tradesPerMin ?? 0) >= (cfg.minTradesPerMin ?? 0);
  add('tradesPerMin', tpmOk, book.tradesPerMin, cfg.minTradesPerMin);

  const activeOk = (book.activePct ?? 0) >= (cfg.minActivePct ?? 0);
  add('activePct', activeOk, book.activePct, cfg.minActivePct);

  const rangeOk = (book.rangeFils ?? 0) >= (cfg.minRangeFils ?? 0);
  add('rangeFils', rangeOk, book.rangeFils, cfg.minRangeFils);

  const spreadOk = cfg.maxSpreadFils == null || book.medSpreadFils == null
    || book.medSpreadFils <= cfg.maxSpreadFils;
  add('spread', spreadOk, book.medSpreadFils, cfg.maxSpreadFils);

  const failed = checks.filter((c) => !c.ok);
  const pass = failed.length === 0;
  const reasons = failed.map((c) => ({ signal: `liq_fail_${c.check}`, actual: c.actual, need: c.need }));

  return { pass, blocked: cfg.mode === 'gate' ? !pass : false, checks, reasons };
}

module.exports = { buildBook, evaluateLiquidity };
