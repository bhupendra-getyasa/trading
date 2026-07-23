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
const { suggest } = require('@trading/shared/src/live-engine/sizing');
const ENGINE_CFG = require('@trading/shared/src/live-engine/config');

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
  const userAction = r.user_action ? String(r.user_action).toUpperCase() : null;
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
    user_action: userAction,                                    // 'BUY' | 'SKIP' | null
    action_at: r.action_at || null,
    // user action drives the DISPLAY state so the card reflects it after refresh, even if the
    // decision row had a null opportunity_id and opportunity_list.status was never updated.
    status: userAction === 'BUY' ? 'BOUGHT' : userAction === 'SKIP' ? 'SKIPPED' : (r.status || 'OPEN'),
  };
}

// ---- reads ------------------------------------------------------------------
async function getBudget(date) {
  const { rows } = await pool.query(
    `SELECT budget_kd FROM public.session_settings WHERE trading_day = $1;`, [date]);
  return rows[0] ? Number(rows[0].budget_kd) : null;
}

// A missing/invalid budget must mean ONE thing everywhere. sizing.js already falls
// back to defaultBudgetKd, but allocateBudget used to read null as "everything fits" —
// so a day with no budget row sized against 2000 KD yet allocated against infinity.
function effectiveBudget(budgetKd) {
  const b = Number(budgetKd);
  return Number.isFinite(b) && b > 0 ? b : (ENGINE_CFG.SIZING.defaultBudgetKd ?? null);
}

async function getOpportunities(date) {
  await ensureDecisionData();   // guarantees public.decisions (+ data column) exists for the join below
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
        ol.volume, ol.avg_volume, ol.rvol, ol.size_tag, ol.warnings, ol.status,
        dec.action AS user_action, dec.decided_at AS action_at
     FROM public.opportunity_list ol
     LEFT JOIN LATERAL (
        SELECT d.action, d.decided_at
        FROM public.decisions d
        WHERE d.symbol = ol.symbol AND d.trading_day = ol.trading_day
        ORDER BY d.decided_at DESC LIMIT 1
     ) dec ON true
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
  const saved = budget === undefined || budget === null ? await getBudget(date) : budget;
  const b = effectiveBudget(saved);
  const [opps, rejected] = await Promise.all([getOpportunities(date), getRejected(date, b)]);
  // user decisions split the board: BOUGHT leaves the radar, SKIPPED moves to the skip list.
  // split by the USER ACTION (from the decisions join), not opportunity_list.status — the
  // decision is matched on symbol+trading_day, so this is correct even when opportunity_id was null.
  const bought  = opps.filter((o) => o.user_action === 'BUY');
  const skipped = opps.filter((o) => o.user_action === 'SKIP');
  const active  = opps.filter((o) => o.user_action !== 'BUY' && o.user_action !== 'SKIP');
  const { deployed, list } = allocateBudget(active, b);
  return { date, opportunities: list, bought, skipped, rejected, console: buildConsole(list, b, deployed) };
}

/**
 * Only the opportunities that just entered the radar this cycle (filtered by symbol),
 * shaped and allocated EXACTLY like getRadarSnapshot's board, plus refreshed console
 * totals so the header stays correct. Lets us push a small incremental pop-up payload
 * instead of resending the whole list every minute.
 */
async function getRadarNew(date, symbols) {
  const want = Array.isArray(symbols) ? symbols.filter(Boolean) : [];
  if (!want.length) return { date, new: [], console: null };
  const snap = await getRadarSnapshot(date);            // full board -> correct allocation + console
  const set = new Set(want);
  const fresh = snap.opportunities.filter((o) => set.has(o.symbol));
  return { date, new: fresh, console: snap.console };
}

// ---- writes -----------------------------------------------------------------

/*
 * Re-size one stored opportunity against a budget, mirroring runScanner.js:74-84
 * exactly (same suggest() call, same net_fils / est_profit_kd formulas) so a
 * re-sized row is indistinguishable from a freshly-scanned one.
 * Returns null when the row lacks the inputs to size — leave such a row untouched.
 */
function sizeRow(r, budgetKd) {
  const price = n(r.entry_price);
  const expected = n(r.expected_fils);
  if (!price || price <= 0 || expected == null) return null;

  const size = suggest({
    profile: r.profile, price, volume: n(r.volume), avgVolume: n(r.avg_volume),
    tradableSwings: i(r.contracts) ?? 1, targetFils: expected, lane: r.lane,
  }, budgetKd, ENGINE_CFG.SIZING, ENGINE_CFG.COMMISSION);

  const net_fils = Math.round((expected - size.commission_fils_per_share) * 100) / 100;
  const est_profit_kd = Math.round((size.suggested_shares * net_fils) / 1000 * 100) / 100;
  return { id: r.id, suggested_shares: size.suggested_shares, contracts: size.est_roundtrips,
    kd_needed: size.kd_needed, commission_fils: size.commission_fils_per_share,
    net_fils, est_profit_kd, size_tag: size.tag };
}

/*
 * The scanner sizes an opportunity ONCE, at trigger time, against whatever budget
 * was set then — and never re-sizes it (insertOpportunities is ON CONFLICT DO NOTHING,
 * and scanner_state stops the symbol re-triggering). So changing the budget used to
 * move only the TAKE/OVER-BUDGET labels while suggested_shares stayed frozen.
 * This rewrites the sizing columns for the day whenever the budget moves.
 *
 * Only OPEN and PAUSED rows are re-sized. A BOUGHT/SKIPPED row records a decision the
 * trader already made at a given size; rewriting its share count would falsify history.
 *
 * commission_fils must be rewritten too: it is per-share and depends on the share count
 * (see sizing.commissionFilsPerShare), and mapOpportunity prefers the stored value over
 * its expected-minus-net fallback — so leaving it behind would pair a stale commission
 * with a fresh net_fils.
 */
// Binding-constraint diagnosis: WHY a card's share count is what it is. Mirrors
// the caps inside sizing.suggest() so the resize log can NAME the reason a budget
// change did or did not move the shares. 'BUDGET' = budget binds (shares scale);
// 'VOLUME-CAP(n)' = exit-safety volume cap binds; 'WILD-CAP(n)' = WILD/Lane-B cap.
function bindingReason(r, budgetKd) {
  const S = ENGINE_CFG.SIZING;
  if (r.profile === 'WILD' || r.lane === 'B') return `WILD-CAP(${S.wildMaxShares})`;
  const risk = S.riskPctByProfile[r.profile] ?? 0.05;
  const price = n(r.entry_price);
  const avg = n(r.avg_volume);
  const vol = n(r.volume);
  const sharesByBudget = price > 0 ? (budgetKd * risk * 1000) / price : Infinity;
  const volForCap = (avg && avg > 0) ? avg : vol;
  const sharesByVolume = volForCap != null ? S.volumeCapPct * volForCap : Infinity;
  return sharesByVolume <= sharesByBudget ? `VOLUME-CAP(${Math.floor(sharesByVolume)})` : 'BUDGET';
}

async function resizeOpportunities(date, budgetKd) {
  const { rows } = await pool.query(
    `SELECT id, symbol, profile, lane, entry_price, expected_fils, volume, avg_volume,
            contracts, suggested_shares
       FROM public.opportunity_list
      WHERE trading_day = $1 AND status IN ('OPEN', 'PAUSED');`, [date]);

  const sized = [];      // rows we can size (have price + expected)
  const details = [];    // per-symbol report so a budget change is never a silent no-op
  let skipped = 0;
  for (const r of rows) {
    const s = sizeRow(r, budgetKd);
    if (!s) { skipped += 1; details.push({ symbol: r.symbol, reason: 'SKIP(no price/expected)' }); continue; }
    const oldShares = i(r.suggested_shares);
    sized.push(s);
    details.push({ symbol: r.symbol, old: oldShares, now: s.suggested_shares,
      changed: oldShares !== s.suggested_shares, reason: bindingReason(r, budgetKd) });
  }

  if (sized.length) {
    // one round-trip: zip the recomputed values in as arrays and join on id
    await pool.query(
      `UPDATE public.opportunity_list AS ol
          SET suggested_shares = v.suggested_shares,
              contracts        = v.contracts,
              kd_needed        = v.kd_needed,
              commission_fils  = v.commission_fils,
              net_fils         = v.net_fils,
              est_profit_kd    = v.est_profit_kd,
              size_tag         = v.size_tag
         FROM unnest($1::bigint[], $2::int[], $3::int[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::text[])
           AS v(id, suggested_shares, contracts, kd_needed, commission_fils, net_fils, est_profit_kd, size_tag)
        WHERE ol.id = v.id;`,
      [sized.map((s) => s.id), sized.map((s) => s.suggested_shares), sized.map((s) => s.contracts),
       sized.map((s) => s.kd_needed), sized.map((s) => s.commission_fils), sized.map((s) => s.net_fils),
       sized.map((s) => s.est_profit_kd), sized.map((s) => s.size_tag)]);
  }

  const changed = details.filter((d) => d.changed).length;
  const capped = details.filter((d) => /CAP\(/.test(d.reason || '')).length;
  return { matched: rows.length, sized: sized.length, changed, capped, skipped, details };
}

async function setBudget(date, ceilingKd) {
  const budget = Number(ceilingKd);
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(`invalid budget: ${JSON.stringify(ceilingKd)} (expected a positive number)`);
  }
  await pool.query(
    `INSERT INTO public.session_settings (trading_day, budget_kd, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (trading_day) DO UPDATE SET budget_kd = EXCLUDED.budget_kd, updated_at = now();`,
    [date, budget]);

  const report = await resizeOpportunities(date, budget);
  // `resized` stays numeric for back-compat, but now means "cards whose shares
  // actually changed" (not just "rows touched"); `report` carries the full detail.
  return { date, budget, resized: report.changed, report };
}

async function markProcessed(symbol, day, outcome) {
  await pool.query(
    `INSERT INTO public.scanner_state (symbol, processed_day, outcome, processed_ts, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (symbol) DO UPDATE SET processed_day = EXCLUDED.processed_day,
       outcome = EXCLUDED.outcome, processed_ts = EXCLUDED.processed_ts, updated_at = now();`,
    [symbol, day, outcome]);
}

// ─── User actions: BUY / IGNORE ──────────────────────────────────────────────
// Kuwait "today" (UTC+3) — used when the socket didn't pass a date.
function kuwaitToday() { return new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10); }

// Coerce a card id to a real opportunity_list id. The frontend commonly sends it as a
// STRING ("123"), and rejected cards use 'rej-<symbol>'. Both must resolve to null, not a
// broken UPDATE — this string case is why buy/ignore previously did nothing in the DB.
function toOppId(id) {
  if (id == null) return null;
  const str = String(id);
  if (str.startsWith('rej-')) return null;
  const n = Number(str);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Resolve the opportunity id even when only a symbol was sent (latest trigger that day).
async function resolveOppId(id, symbol, day) {
  const direct = toOppId(id);
  if (direct != null) return direct;
  if (!symbol) return null;
  const { rows } = await pool.query(
    `SELECT id FROM public.opportunity_list
      WHERE symbol = $1 AND trading_day = $2 ORDER BY trigger_ts DESC LIMIT 1;`, [symbol, day]);
  return rows[0]?.id ?? null;
}

// Single table for user actions: public.decisions. A `data` jsonb column holds the FULL
// stock snapshot on BUY. Ensured lazily (create-if-missing + add-column) so the websocket
// service is self-sufficient. bought_stocks has been retired — everything lives here now.
let _decReady = false;
async function ensureDecisionData() {
  if (_decReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.decisions (
      id bigserial PRIMARY KEY, symbol text NOT NULL, opportunity_id bigint, trading_day date,
      action text NOT NULL, reason_code text, reason_text text, engine_version text,
      decided_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE public.decisions ADD COLUMN IF NOT EXISTS data jsonb;
    CREATE INDEX IF NOT EXISTS decisions_day_idx ON public.decisions (trading_day, decided_at DESC);
    CREATE INDEX IF NOT EXISTS decisions_sym_day_idx ON public.decisions (symbol, trading_day, decided_at DESC);`);
  _decReady = true;
}

// One audit/action row in public.decisions. `data` = full opportunity snapshot (BUY only; null on SKIP).
async function recordDecisionRow({ symbol, opportunityId, day, action, reason = null, data = null }) {
  console.log('opportunityId: ', opportunityId);
  await pool.query(
    `INSERT INTO public.decisions
       (symbol, opportunity_id, trading_day, action, reason_code, reason_text, engine_version, data, decided_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, now());`,
    [symbol, opportunityId, day, action, reason, ENGINE_VERSION, data ? JSON.stringify(data) : null]);
}

/**
 * BUY — record a BUY in public.decisions WITH the full stock-data snapshot, mark the
 * opportunity BOUGHT, and stop it re-alerting today. Single table; no bought_stocks.
 */
async function buyStock({ id, symbol, date }) {
  await ensureDecisionData();
  const day = date || kuwaitToday();
  const oppId = await resolveOppId(id, symbol, day);

  let row = null;
  if (oppId != null) {
    ({ rows: [row] } = await pool.query(`SELECT * FROM public.opportunity_list WHERE id = $1;`, [oppId]));
  }
  if (!row && symbol) {
    ({ rows: [row] } = await pool.query(
      `SELECT * FROM public.opportunity_list
        WHERE symbol = $1 AND trading_day = $2 ORDER BY trigger_ts DESC LIMIT 1;`, [symbol, day]));
  }
  if (!row) throw new Error(`buyStock: no opportunity found (id=${id}, symbol=${symbol}, day=${day})`);

  console.log(`[radar] BUY ${row.symbol} id=${JSON.stringify(id)} -> opportunity_id ${row.id}`);
  await pool.query(`UPDATE public.opportunity_list SET status = 'BOUGHT' WHERE id = $1;`, [row.id]);
  await recordDecisionRow({ symbol: row.symbol, opportunityId: row.id, day, action: 'BUY', data: row });
  await markProcessed(row.symbol, day, 'bought');
  return { action: 'BUY', trading_day: day, symbol: row.symbol, opportunity_id: row.id };
}

/**
 * IGNORE — record a SKIP in public.decisions, mark the opportunity SKIPPED (drops off the
 * active board, shows in the skip list via getSkipList / snapshot.skipped), stop re-alerting.
 */
async function ignoreStock({ id, symbol, date }) {
  await ensureDecisionData();
  const day = date || kuwaitToday();
  const oppId = await resolveOppId(id, symbol, day);
  console.log(`[radar] IGNORE ${symbol} id=${JSON.stringify(id)} -> opportunity_id ${oppId}`);
  if (oppId != null) await pool.query(`UPDATE public.opportunity_list SET status = 'SKIPPED' WHERE id = $1;`, [oppId]);
  await recordDecisionRow({ symbol, opportunityId: oppId, day, action: 'SKIP' });
  if (symbol) await markProcessed(symbol, day, 'user_skipped');
  return { action: 'SKIP', trading_day: day, opportunity_id: oppId, symbol };
}

// The SKIP list the frontend renders: user-skipped cards for the day (latest per symbol).
async function getSkipList(date) {
  const opps = await getOpportunities(date);
  return opps.filter((o) => o.status === 'SKIPPED');
}

// Bought records for the day, read from the single decisions table (action='BUY').
// The full card is in `data`; flatten it so the shape matches an opportunity card.
async function getBoughtList(date) {
  await ensureDecisionData();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (symbol) symbol, opportunity_id, trading_day, decided_at, data
       FROM public.decisions
      WHERE trading_day = $1 AND action = 'BUY'
      ORDER BY symbol, decided_at DESC;`, [date]);
  return rows.map((r) => ({
    ...(r.data || {}),
    symbol: r.symbol, opportunity_id: r.opportunity_id, trading_day: r.trading_day, bought_at: r.decided_at,
  }));
}

/**
 * Back-compat router for the generic `decision` event: BUY -> buyStock, SKIP/IGNORE ->
 * ignoreStock. PAUSE has been removed from the product; unknown actions are only logged.
 * Prefer the dedicated buyStock / ignoreStock (the `buy` / `ignore` socket events).
 */
async function recordDecision({ id, symbol, action, reason = null, date }) {
  const a = String(action || '').toUpperCase();
  if (a === 'BUY') return buyStock({ id, symbol, date });
  if (a === 'SKIP' || a === 'IGNORE') return ignoreStock({ id, symbol, date });
  const day = date || kuwaitToday();
  await recordDecisionRow({ symbol, opportunityId: id, day, action: a || 'UNKNOWN', reason });
  return { symbol, action: a, trading_day: day };
}

module.exports = {
  getRadarSnapshot, getRadarNew, getBudget, setBudget, recordDecision, resizeOpportunities,
  buyStock, ignoreStock, getSkipList, getBoughtList,
  // exported for testing / reuse
  allocateBudget, getOpportunities, getRejected, buildConsole, sizeRow, effectiveBudget,
};