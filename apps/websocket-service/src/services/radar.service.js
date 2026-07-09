'use strict';
/*
 * radar.service.js  (apps/websocket-service/src/services/radar.service.js)
 * ---------------------------------------------------------------------------
 * All DB access + shaping for the Intraday Radar dashboard. Self-contained:
 * reads the tables the live-engine writes and returns the exact payload the
 * front-end expects. Mirrors the engine's portfolio.allocateBudget and
 * decisions.recordDecision so behaviour stays identical.
 *
 * Tables used:
 *   READ : public.opportunity_list, public.radar_events,
 *          public.session_settings, public.market_stock_snapshots
 *   WRITE: public.session_settings (budget), public.decisions,
 *          public.opportunity_list (status), public.scanner_state (processed)
 */
const { pool } = require('@trading/shared');
// FIX: reuse the ENGINE's sizing so rejected cards can show the same numbers
// (importing rather than re-implementing avoids formula drift)
const { suggest } = require('../../../ingestion-service/src/live-engine/sizing');
const ENGINE_CFG = require('../../../ingestion-service/src/live-engine/config');

// FIX: fraction of the 09:00-13:00 Kuwait session elapsed (0.08..1).
// rvol must compare todays PARTIAL volume to the pro-rated average.
function sessionFraction(d) {
  const startMin = 6 * 60;   // 09:00 Kuwait = 06:00 UTC
  const totalMin = 240;      // 4-hour session
  const elapsed = (d.getUTCHours() * 60 + d.getUTCMinutes()) - startMin;
  const frac = elapsed / totalMin;
  if (!isFinite(frac)) return 1;
  return Math.min(1, Math.max(0.08, frac));
}

const ENGINE_VERSION = 'live-engine v1.0';
const TZ = 'Asia/Kuwait';
const RANK_BY = 'est_profit_kd';         // matches config.PORTFOLIO.rankBy
const WAKING_RVOL = 5;                    // sleeper wakes when rvol >= 5x

// ---- tiny helpers -----------------------------------------------------------
const n = (v) => (v == null || v === '' ? null : Number(v));
const i = (v) => (v == null || v === '' ? null : parseInt(v, 10));

// parse a price/number that may arrive as text ("323", "1,045", unicode minus)
function parsePrice(v) {
  if (v == null || v === '') return null;
  const f = parseFloat(String(v).replace(/\u2212/g, '-').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(f) ? f : null;
}

function parseVol(v) {
  if (v == null || v === '') return null;
  let s = String(v).trim().replace(/,/g, '');
  const last = s.slice(-1).toLowerCase();
  let mult = 1;
  if (last === 'k') { mult = 1e3; s = s.slice(0, -1); }
  else if (last === 'm') { mult = 1e6; s = s.slice(0, -1); }
  else if (last === 'b') { mult = 1e9; s = s.slice(0, -1); }
  const f = parseFloat(s);
  return Number.isFinite(f) ? f * mult : null;
}

// engine size_tag -> the UI's tag set (ILLIQUID-CAP / ILLIQUID-TINY -> ILLIQUID)
function normTag(t) {
  if (!t) return null;            // FIX: no tag != TRADABLE (rejected cards were showing a green TRADABLE badge)
  const u = String(t).toUpperCase();
  return u.startsWith('ILLIQUID') ? 'ILLIQUID' : u;
}

// ---- allocation: mirrors live-engine/portfolio.js (pure) --------------------
function allocateBudget(opps, budgetKd, rankBy = RANK_BY) {
  const tradable = opps.filter((o) => o.size_tag === 'TRADABLE');
  const others = opps.filter((o) => o.size_tag !== 'TRADABLE');
  const ranked = [...tradable].sort((a, b) => (b[rankBy] ?? 0) - (a[rankBy] ?? 0));
  let spent = 0;
  const list = ranked.map((o) => {
    const fits = budgetKd == null || spent + (o.kd_needed ?? 0) <= budgetKd;
    if (fits) spent += o.kd_needed ?? 0;
    return { ...o, allocation: fits ? 'TAKE' : 'OVER-BUDGET' };
  });
  for (const o of others) list.push({ ...o, allocation: 'SKIP' });
  return { deployed: Math.round(spent), list };
}

// ---- row mappers ------------------------------------------------------------
function mapOpportunity(r) {
  const expected = n(r.expected_fils);
  const net = n(r.net_fils);
  // commission = expected - net (net is already after commission). Fallback only when null.
  let commission = n(r.commission_fils);
  if (commission == null && expected != null && net != null) {
    commission = Math.round((expected - net) * 100) / 100;
  }
  return {
    id: r.id,
    symbol: r.symbol,
    trigger_ts: r.trigger_ts,               // already HH:MM (Kuwait) from SQL
    profile: r.profile || 'WATCH',
    trend: r.trend || 'STABLE',
    lane: r.lane,
    entry_type: r.entry_type,
    // opening_price if the engine stored it, else the day's first snapshot price
    open: n(r.opening_price) ?? parsePrice(r.snapshot_open),
    entry: n(r.entry_price),
    swing1_fils: n(r.swing1_fils),
    expected_fils: expected,
    commission_fils: commission,
    net_fils: net,
    suggested_shares: i(r.suggested_shares),
    est_roundtrips: i(r.est_roundtrips) ?? 1,   // floor of 1 round-trip when not stored
    kd_needed: n(r.kd_needed),
    est_profit_kd: n(r.est_profit_kd),
    volume: n(r.volume),
    avg_volume: n(r.avg_volume),
    rvol: n(r.rvol),
    size_tag: normTag(r.size_tag),
    warnings: Array.isArray(r.warnings) ? r.warnings : (r.warnings ? [r.warnings] : []),
    status: r.status || 'OPEN',
  };
}

// ---- reads ------------------------------------------------------------------
async function getBudget(date) {
  const { rows } = await pool.query(
    `SELECT budget_kd FROM public.session_settings WHERE trading_day = $1;`, [date]);
  return rows[0] ? Number(rows[0].budget_kd) : null;
}

async function getOpportunities(date) {
  // latest opportunity row per symbol for the day (a symbol can re-trigger).
  // snapshot_open = the day's first snapshot price, used when opening_price is null.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (ol.symbol)
        ol.id, ol.symbol,
        to_char(ol.trigger_ts AT TIME ZONE $2, 'HH24:MI') AS trigger_ts,
        ol.profile, ol.trend, ol.lane, ol.entry_type,
        ol.opening_price, op.last_price AS snapshot_open,
        ol.entry_price, ol.swing1_fils, ol.expected_fils, ol.commission_fils, ol.net_fils,
        ol.suggested_shares, ol.contracts AS est_roundtrips, ol.kd_needed, ol.est_profit_kd,
        ol.volume, ol.avg_volume, ol.rvol, ol.size_tag, ol.warnings, ol.status
     FROM public.opportunity_list ol
     LEFT JOIN LATERAL (
        SELECT ms.last_price
        FROM public.market_stock_snapshots ms
        WHERE ms.symbol = ol.symbol
          AND (ms.created_at AT TIME ZONE $2)::date = ol.trading_day
        ORDER BY ms.created_at ASC
        LIMIT 1
     ) op ON true
     WHERE ol.trading_day = $1
     ORDER BY ol.symbol, ol.trigger_ts DESC;`, [date, TZ]);
  return rows.map(mapOpportunity);
}

async function getRejected(date, budgetKd) {
  // radar hit but History said no. We now enrich each row with the SAME fields a
  // tradable card shows (open, exp, comm, net/sh, shares, ~trips, budget, /trip, day)
  // so the trader can see exactly what is being passed up. BUY stays disabled.
  const { rows } = await pool.query(
    `SELECT symbol, profile, trend, lane,
            swing1_fils, entry_price, reject_reason, last_hit, hits_today
     FROM (
       SELECT DISTINCT ON (symbol) symbol, profile, trend, lane,
              swing1_fils, entry_price, reject_reason,
              run_ts AS last_hit,
              count(*) OVER (PARTITION BY symbol)::int AS hits_today
       FROM public.radar_events
       WHERE trading_day = $1 AND history_qualifies = false
       ORDER BY symbol, run_ts DESC
     ) t
     ORDER BY swing1_fils DESC NULLS LAST;`, [date]);
  if (!rows.length) return [];

  const symbols = rows.map((r) => r.symbol);

  // latest snapshot per symbol -> volume / avg_volume
  const { rows: snaps } = await pool.query(
    `SELECT DISTINCT ON (symbol) symbol, volume, avg_volume
     FROM public.market_stock_snapshots
     WHERE symbol = ANY($1)
     ORDER BY symbol, created_at DESC;`, [symbols]);
  const snapMap = new Map(snaps.map((s) => [s.symbol, s]));

  // FIRST snapshot of the trading day -> OPEN price
  const { rows: opens } = await pool.query(
    `SELECT DISTINCT ON (symbol) symbol, last_price
     FROM public.market_stock_snapshots
     WHERE symbol = ANY($1) AND created_at::date = $2
     ORDER BY symbol, created_at ASC;`, [symbols, date]);
  const openMap = new Map(opens.map((o) => [o.symbol, parsePrice(o.last_price)]));

  // history classification -> expected fils + tradable swings
  const { rows: cls } = await pool.query(
    `SELECT symbol, target_fils, tradable_swings
     FROM public.stock_classification
     WHERE symbol = ANY($1);`, [symbols]);
  const clsMap = new Map(cls.map((c) => [c.symbol, c]));

  const budget = Number(budgetKd) || ENGINE_CFG.SIZING.defaultBudgetKd || 2000;

  return rows.map((r) => {
    const s = snapMap.get(r.symbol) || {};
    const vol = parseVol(s.volume);
    const avg = parseVol(s.avg_volume);
    const frac = sessionFraction(new Date());
    const rvol = avg && avg > 0 && vol != null ? vol / (avg * frac) : null;
    const waking = rvol != null && rvol >= WAKING_RVOL;

    const c = clsMap.get(r.symbol) || {};
    const expected = c.target_fils != null ? Number(c.target_fils) : null;
    const price = n(r.entry_price);

    // size it exactly as the engine would (WILD / Lane B get the tiny cap)
    let size = null, net_fils = null, est_profit_kd = null, per_trip_kd = null, day_kd = null;
    if (price && avg && expected != null) {
      size = suggest({
        profile: r.profile, price, volume: vol ?? avg, avgVolume: avg,
        tradableSwings: Number(c.tradable_swings) || 1,
        targetFils: expected, lane: r.lane,
      }, budget, ENGINE_CFG.SIZING, ENGINE_CFG.COMMISSION);
      net_fils = Math.round((expected - size.commission_fils_per_share) * 100) / 100;
      per_trip_kd = Math.round((net_fils * size.suggested_shares) / 1000 * 100) / 100;
      est_profit_kd = per_trip_kd;
      day_kd = Math.round(per_trip_kd * size.est_roundtrips * 10) / 10;
    }

    return {
      id: `rej-${r.symbol}`,
      symbol: r.symbol,
      profile: r.profile || 'WATCH',
      trend: r.trend || 'STABLE',
      lane: r.lane,
      swing1_fils: n(r.swing1_fils),
      entry: price,
      open: openMap.get(r.symbol) ?? null,
      expected_fils: expected,
      commission_fils: size ? size.commission_fils_per_share : null,
      net_fils,
      suggested_shares: size ? size.suggested_shares : null,
      est_roundtrips: size ? size.est_roundtrips : null,
      kd_needed: size ? size.kd_needed : null,
      est_profit_kd,
      day_kd,
      would_be_tag: size ? size.tag : null,   // what the size WOULD be, if history allowed it
      reject_reason: r.reject_reason || 'history rejected',
      volume: vol, avg_volume: avg, rvol,
      warnings: waking ? ['WAKING'] : [],
      waking,
      hits_today: r.hits_today,
      size_tag: 'REJECTED',   // badge stays red; BUY stays disabled
      status: 'SKIPPED',
    };
  });
}


function buildConsole(list, budget, deployed) {
  const take = list.filter((o) => o.allocation === 'TAKE');
  const kdFrom = (o, perShare) => (perShare || 0) * (o.suggested_shares || 0) * (o.est_roundtrips || 0) / 1000;
  const total_commission_kd = take.reduce((s, o) => s + kdFrom(o, o.commission_fils), 0);
  const total_net_profit_kd = take.reduce((s, o) => s + kdFrom(o, o.net_fils), 0);
  return {
    budget,
    deployed,
    total_commission_kd: Math.round(total_commission_kd * 10) / 10,
    total_net_profit_kd: Math.round(total_net_profit_kd * 10) / 10,
    counts: {
      tradable: list.filter((o) => o.size_tag === 'TRADABLE').length,
      active_buy: take.length,
      watch: list.filter((o) => o.profile === 'WATCH').length,
    },
  };
}

/** Full snapshot the front-end renders. If budget is undefined, use the day's saved budget. */
async function getRadarSnapshot(date, budget) {
  const b = budget === undefined || budget === null ? await getBudget(date) : Number(budget);
  const [opps, rejected] = await Promise.all([getOpportunities(date), getRejected(date, b)]);
  const { deployed, list } = allocateBudget(opps, b);
  return { date, opportunities: list, rejected, console: buildConsole(list, b, deployed) };
}

// ---- writes -----------------------------------------------------------------
async function setBudget(date, ceilingKd) {
  await pool.query(
    `INSERT INTO public.session_settings (trading_day, budget_kd, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (trading_day) DO UPDATE SET budget_kd = EXCLUDED.budget_kd, updated_at = now();`,
    [date, ceilingKd]);
}

async function markProcessed(symbol, day, outcome) {
  await pool.query(
    `INSERT INTO public.scanner_state (symbol, processed_day, outcome, processed_ts, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (symbol) DO UPDATE SET processed_day = EXCLUDED.processed_day,
       outcome = EXCLUDED.outcome, processed_ts = EXCLUDED.processed_ts, updated_at = now();`,
    [symbol, day, outcome]);
}

/**
 * Record a BUY / PAUSE / SKIP. Mirrors live-engine/decisions.recordDecision:
 *   BUY  -> status BOUGHT,  processed today (won't re-alert)
 *   SKIP -> status SKIPPED, processed today (won't re-alert)
 *   PAUSE-> status PAUSED,  NOT processed (may re-alert later)
 * `action` is BUY | PAUSE | SKIP. (UI "IGNORE" button sends SKIP.)
 */
async function recordDecision({ id, symbol, action, reason = null, date }) {
  const day = date || new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  const opportunityId = typeof id === 'number' ? id : null; // rejected ids are 'rej-*'

  await pool.query(
    `INSERT INTO public.decisions
       (symbol, opportunity_id, trading_day, action, reason_code, reason_text, engine_version, decided_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, now());`,
    [symbol, opportunityId, day, action, reason, ENGINE_VERSION]);

  if (action === 'BUY') {
    if (opportunityId) await pool.query(`UPDATE public.opportunity_list SET status='BOUGHT' WHERE id=$1;`, [opportunityId]);
    await markProcessed(symbol, day, 'bought');
  } else if (action === 'SKIP') {
    if (opportunityId) await pool.query(`UPDATE public.opportunity_list SET status='SKIPPED' WHERE id=$1;`, [opportunityId]);
    await markProcessed(symbol, day, 'user_skipped');
  } else if (action === 'PAUSE') {
    if (opportunityId) await pool.query(`UPDATE public.opportunity_list SET status='PAUSED' WHERE id=$1;`, [opportunityId]);
  }
  return { symbol, action, trading_day: day };
}

module.exports = {
  getRadarSnapshot, getBudget, setBudget, recordDecision,
  // exported for testing / reuse
  allocateBudget, getOpportunities, getRejected, buildConsole,
};
