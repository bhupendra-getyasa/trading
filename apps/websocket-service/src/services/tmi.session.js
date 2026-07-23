'use strict';
/*
 * tmi.session.js — load a stored trading day from the database in the exact shape the
 * replay harness consumes.
 *
 * Deliberately identical to what /tmi/export/:date produces, so replay-from-database and
 * replay-from-exported-file are byte-identical inputs. If those two diverge, a result
 * reproduced from a file stops matching what the server actually did, silently.
 *
 * SCHEMA-TOLERANT BY DESIGN
 * -------------------------
 * stock_quotes is written by the watchlist scraper straight from scraped text
 * (`textContent.trim()`), so depending on how the table was created its columns may be
 * `text` rather than `numeric`/`date`. That single unknown breaks a naive query in two
 * different ways:
 *
 *   `last_price > 0`      -> "operator does not exist: text > integer" if the column is text
 *   `trading_date = $1`   -> silently matches NOTHING on a type/format mismatch
 *
 * The second is the dangerous one: no error, no rows, and a caller that concludes the day
 * has no data. So everything numeric is cast explicitly, and the day is selected by
 * `created_at` — a timestamptz, unambiguous — with `trading_date` used only as a fast
 * first attempt because it is indexed.
 */
const { pool } = require('@trading/shared');

const QUOTES = process.env.QUOTES_TABLE || 'public.stock_quotes';
const CLS = process.env.CLASSIFICATION_TABLE || 'public.stock_classification';
const TZ = 3;   // Asia/Kuwait, no DST

// NULLIF(...,'')::numeric works whether the column is text or already numeric, and
// tolerates the thousands separators the scraper can leave in ('1,234').
const NUM = (c) => `NULLIF(regexp_replace(${c}::text, '[^0-9.\\-]', '', 'g'), '')::numeric AS ${c.split('.').pop()}`;

const SELECT_COLS = `symbol, created_at,
  ${NUM('last_price')}, ${NUM('bid')}, ${NUM('bid_qty')}, ${NUM('offer')},
  ${NUM('offer_qty')}, ${NUM('trades')}, ${NUM('high_price')}, ${NUM('low_price')}`;

async function fetchQuotes(date) {
  // 1) fast path — the indexed trading_date column
  const byTradingDate = await pool.query(
    `SELECT ${SELECT_COLS} FROM ${QUOTES}
      WHERE trading_date::text = $1
      ORDER BY symbol, created_at ASC;`, [date]).catch(() => ({ rows: [] }));
  if (byTradingDate.rows.length) return { rows: byTradingDate.rows, via: 'trading_date' };

  // 2) fallback — the Kuwait calendar day expressed as a UTC range on created_at.
  // Reached when trading_date is absent, differently formatted, or a type that does not
  // compare cleanly. Slower without the index, but it always tells the truth.
  const byCreatedAt = await pool.query(
    `SELECT ${SELECT_COLS} FROM ${QUOTES}
      WHERE created_at >= ($1::date - interval '${TZ} hours')
        AND created_at <  ($1::date + interval '${24 - TZ} hours')
      ORDER BY symbol, created_at ASC;`, [date]);
  return { rows: byCreatedAt.rows, via: 'created_at' };
}

async function loadSessionFromDb(date) {
  const { rows: quotes, via } = await fetchQuotes(date);
  if (!quotes.length) return null;
  if (via === 'created_at') {
    console.warn(`[tmi] ${date}: trading_date matched nothing, fell back to created_at ` +
      `(${quotes.length} rows). Worth checking the column's type/format.`);
  }

  const { rows: cls } = await pool.query(
    `SELECT symbol, profile, lane, trend, target_fils FROM ${CLS};`).catch(() => ({ rows: [] }));

  const { rows: evs } = await pool.query(
    `SELECT DISTINCT ON (symbol) symbol, run_ts, outcome, entry_price
       FROM public.radar_events
      WHERE trading_day::text = $1
      ORDER BY symbol, run_ts ASC;`, [date]).catch(() => ({ rows: [] }));

  const fm = (d) => Math.floor(new Date(d).getTime() / 60000) * 60000;
  const minutes = [...new Set(quotes.map((q) => fm(q.created_at)))].sort((a, b) => a - b);
  const mIdx = new Map(minutes.map((m, i) => [m, i]));
  const clsBy = new Map(cls.map((c) => [c.symbol, c]));

  const nomBy = new Map();
  for (const e of evs) {
    const m = fm(e.run_ts);
    const idx = mIdx.get(m) ?? mIdx.get(minutes.find((x) => x >= m));
    if (idx == null) continue;
    nomBy.set(e.symbol, { minute: idx, qualified: e.outcome === 'qualified',
      price: e.entry_price == null ? null : Number(e.entry_price) });
  }

  const symbols = {};
  for (const q of quotes) {
    const idx = mIdx.get(fm(q.created_at));
    if (idx == null) continue;
    // zero and non-numeric prices are dropped HERE rather than in SQL, so the filter
    // cannot be defeated by a column type. One zero becomes a session low of 0 and every
    // range, target and stop derived from it is nonsense (19-Jul: RASIYAT got a 159-fil
    // target from a "range" that was really 609 - 0).
    const lp = Number(q.last_price);
    if (!Number.isFinite(lp) || lp <= 0) continue;
    let s = symbols[q.symbol];
    if (!s) s = symbols[q.symbol] = { cls: clsBy.get(q.symbol) || null, nomination: nomBy.get(q.symbol) || null, rows: [], _seen: new Set() };
    if (s._seen.has(idx)) continue;                 // the scraper occasionally double-writes a minute
    s._seen.add(idx);
    const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
    s.rows.push({ minute: idx, ts: fm(q.created_at), last_price: lp,
      bid: n(q.bid), bid_qty: n(q.bid_qty), offer: n(q.offer), offer_qty: n(q.offer_qty),
      trades: n(q.trades), high_price: n(q.high_price), low_price: n(q.low_price) });
  }
  for (const s of Object.values(symbols)) delete s._seen;

  if (!Object.keys(symbols).length) return null;
  return { tradingDay: date, minutes, symbols, _via: via, _rows: quotes.length };
}

/* diagnose(date) — what the server can actually see. Powers a clearer error message
 * than "no data", and answers the question directly from the running process rather
 * than requiring someone to open psql. */
async function diagnose(date) {
  const out = { date, quotesTable: QUOTES };
  const q = async (sql, p) => (await pool.query(sql, p).catch((e) => ({ rows: [{ error: e.message }] }))).rows;
  out.columnTypes = await q(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'stock_quotes' AND column_name IN
      ('trading_date','last_price','created_at','bid_qty','trades') ORDER BY column_name;`);
  out.recentDays = await q(
    `SELECT trading_date::text AS day, count(*)::int AS rows, count(DISTINCT symbol)::int AS symbols
       FROM ${QUOTES} GROUP BY trading_date ORDER BY trading_date DESC LIMIT 10;`);
  out.byCreatedAt = await q(
    `SELECT count(*)::int AS rows FROM ${QUOTES}
      WHERE created_at >= ($1::date - interval '${TZ} hours')
        AND created_at <  ($1::date + interval '${24 - TZ} hours');`, [date]);
  return out;
}

module.exports = { loadSessionFromDb, diagnose };
