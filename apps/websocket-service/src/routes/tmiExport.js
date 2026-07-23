'use strict';
/*
 * tmiExport.js — one-button day export.
 *
 * GET /tmi/export/:date        -> gzipped JSON, the full session
 * GET /tmi/export/:date?raw=1  -> uncompressed (debugging only; it is large)
 * GET /tmi/export/days         -> which dates are available
 *
 * WHY THIS SHAPE
 * --------------
 * The output is exactly the structure the replay harness consumes, so a day can be
 * dropped straight into it with no reassembly. Every hand-assembly step between the
 * database and the harness is a chance for the two to disagree about what happened,
 * and we have already lost a week to exactly that class of mistake.
 *
 * date is the Kuwait trading_date (YYYY-MM-DD), not UTC.
 */
const express = require('express');
const zlib = require('zlib');
const { pool } = require('@trading/shared');

const router = express.Router();

const T = {
  quotes: process.env.QUOTES_TABLE || 'public.stock_quotes',
  events: 'public.radar_events',
  cls: process.env.CLASSIFICATION_TABLE || 'public.stock_classification',
  opps: 'public.opportunity_list',
  decisions: 'public.decisions',
};

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

router.get('/days', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT trading_date::text AS date, count(*)::int AS rows, count(DISTINCT symbol)::int AS symbols
         FROM ${T.quotes}
        WHERE trading_date >= CURRENT_DATE - 60
        GROUP BY trading_date ORDER BY trading_date DESC;`);
    res.json({ days: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:date', async (req, res) => {
  const date = req.params.date;
  if (!isDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    // ── quotes: the minute-by-minute tape + order book ─────────────────────
    // last_price > 0 is enforced HERE so a zero can never reach a consumer. The feed
    // emits 0 for symbols it has not populated, and one zero destroys everything
    // derived from the price path (19-Jul: RASIYAT got a 159-fil target from a
    // "range" that was really 609 - 0).
    const { rows: quotes } = await pool.query(
      `SELECT symbol, created_at, last_price, bid, bid_qty, offer, offer_qty, trades,
              high_price, low_price, volume
         FROM ${T.quotes}
        WHERE trading_date = $1 AND last_price IS NOT NULL AND last_price > 0
        ORDER BY symbol, created_at ASC;`, [date]);
    if (!quotes.length) return res.status(404).json({ error: `no quote data for ${date}` });

    // ── radar events: the nomination per symbol (first one wins) ───────────
    const { rows: events } = await pool.query(
      `SELECT symbol, run_ts, entry_type, entry_price, profile, trend, lane, swing1_fils,
              reject_reason, history_qualifies, outcome, detected_ts, triggered_ts,
              liquidity_pass, liquidity_blocked, book, liquidity_checks, reasons
         FROM ${T.events}
        WHERE trading_day = $1 ORDER BY symbol, run_ts ASC;`, [date]);

    const { rows: cls } = await pool.query(
      `SELECT symbol, profile, lane, trend, target_fils, net_fils, tradable_swings,
              win_pct, price_band
         FROM ${T.cls};`);

    const { rows: opps } = await pool.query(
      `SELECT * FROM ${T.opps} WHERE trading_day = $1 ORDER BY trigger_ts ASC;`, [date])
      .catch(() => ({ rows: [] }));

    const { rows: decisions } = await pool.query(
      `SELECT symbol, action, reason_code, reason_text, decided_at, data
         FROM ${T.decisions} WHERE trading_day = $1 ORDER BY decided_at ASC;`, [date])
      .catch(() => ({ rows: [] }));

    // ── minute index ───────────────────────────────────────────────────────
    const floorMin = (d) => Math.floor(new Date(d).getTime() / 60000) * 60000;
    const minuteSet = new Set(quotes.map((q) => floorMin(q.created_at)));
    const minutes = [...minuteSet].sort((a, b) => a - b);
    const mIdx = new Map(minutes.map((m, i) => [m, i]));

    const clsBy = new Map(cls.map((c) => [c.symbol, c]));
    const nomBy = new Map();
    for (const e of events) {
      if (nomBy.has(e.symbol)) continue;                 // first event of the day only
      const m = floorMin(e.run_ts);
      let idx = mIdx.get(m);
      if (idx == null) {                                  // snap forward to the next known minute
        const later = minutes.find((x) => x >= m);
        idx = later != null ? mIdx.get(later) : null;
      }
      if (idx == null) continue;
      nomBy.set(e.symbol, {
        minute: idx, outcome: e.outcome, qualified: e.outcome === 'qualified',
        entry_type: e.entry_type, entry_price: e.entry_price == null ? null : Number(e.entry_price),
        profile: e.profile, trend: e.trend, lane: e.lane,
        swing1_fils: e.swing1_fils == null ? null : Number(e.swing1_fils),
        reject_reason: e.reject_reason, detected_ts: e.detected_ts, triggered_ts: e.triggered_ts,
        liquidity_pass: e.liquidity_pass, book: e.book, liquidity_checks: e.liquidity_checks,
        reasons: e.reasons,
      });
    }

    // ── per-symbol rows, deduped to one per minute ─────────────────────────
    const symbols = {};
    for (const q of quotes) {
      const m = floorMin(q.created_at);
      const idx = mIdx.get(m);
      if (idx == null) continue;
      // Defence in depth: the SQL already excludes last_price <= 0, but this is the last
      // point before the data leaves the system and a zero here is silently catastrophic
      // downstream (it becomes a session low of 0, and every range/target derived from it
      // is nonsense). Cheap check, unbounded downside if it is missing.
      const lp = Number(q.last_price);
      if (!Number.isFinite(lp) || lp <= 0) continue;
      let s = symbols[q.symbol];
      if (!s) {
        s = symbols[q.symbol] = { cls: clsBy.get(q.symbol) || null, nomination: nomBy.get(q.symbol) || null, rows: [], _seen: new Set() };
      }
      if (s._seen.has(idx)) continue;                     // the scraper occasionally double-writes a minute
      s._seen.add(idx);
      const n = (v) => (v == null ? null : Number(v));
      s.rows.push({ minute: idx, ts: m,
        last_price: n(q.last_price), bid: n(q.bid), bid_qty: n(q.bid_qty),
        offer: n(q.offer), offer_qty: n(q.offer_qty), trades: n(q.trades),
        high_price: n(q.high_price), low_price: n(q.low_price), volume: n(q.volume) });
    }
    for (const s of Object.values(symbols)) delete s._seen;

    const LIVE = require('@trading/shared/src/live-engine/config');
    const payload = {
      tradingDay: date,
      exportedAt: new Date().toISOString(),
      engineVersion: LIVE.VERSION,
      config: { liquidity: LIVE.LIQUIDITY, sizing: LIVE.SIZING, commission: LIVE.COMMISSION, swing: LIVE.SWING },
      minutes,
      symbols,
      opportunities: opps,
      decisions,
      counts: {
        symbols: Object.keys(symbols).length,
        minutes: minutes.length,
        quoteRows: quotes.length,
        nominations: nomBy.size,
        qualified: [...nomBy.values()].filter((n) => n.qualified).length,
      },
    };

    const json = JSON.stringify(payload);
    const name = `intraday-${date}.json`;
    if (req.query.raw) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      return res.send(json);
    }
    // gzip: ~32k rows/day is 20-50 MB raw, a few MB compressed
    zlib.gzip(json, (err, buf) => {
      if (err) return res.status(500).json({ error: err.message });
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.gz"`);
      res.setHeader('X-Export-Counts', JSON.stringify(payload.counts));
      res.send(buf);
    });
  } catch (e) {
    console.error('[tmi-export]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
