'use strict';
/*
 * repository.js — all PostgreSQL access for the Live engine.
 * READS : public.market_stock_snapshots (windows), public.stock_classification
 *         (History's output), public.session_settings (today's budget)
 * WRITES: opportunity_list, decisions, scanner_signals, radar_events, scanner_state
 */
const CONFIG = require('./config');
const T = {
  snapshots: process.env.SNAPSHOTS_TABLE || 'public.market_stock_snapshots',
  classification: process.env.CLASSIFICATION_TABLE || 'public.stock_classification',
  session: process.env.SESSION_TABLE || 'public.session_settings',
  quotes: process.env.QUOTES_TABLE || 'public.stock_quotes',
  opps: 'public.opportunity_list', decisions: 'public.decisions',
  signals: 'public.scanner_signals', events: 'public.radar_events', state: 'public.scanner_state',
};

const DDL = `
CREATE TABLE IF NOT EXISTS ${T.opps} (
  id bigserial PRIMARY KEY, symbol text NOT NULL, trigger_ts timestamptz NOT NULL, trading_day date,
  engine_version text, profile text, trend text, lane text, entry_type text,
  entry_price numeric, swing1_fils numeric, swings_so_far int, expected_fils numeric,
  net_fils numeric, price_band text, rvol numeric, change_pct numeric, value_traded numeric, volume numeric, avg_volume numeric,
  suggested_shares int, contracts int, kd_needed numeric, est_profit_kd numeric, size_tag text,
  warnings jsonb, reasons jsonb, fib jsonb, pullback_pct numeric, fib_level_hit text, detected_ts timestamptz, triggered_ts timestamptz, intended_fib_price numeric, status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT opportunity_list_uq UNIQUE (symbol, trigger_ts));
CREATE INDEX IF NOT EXISTS opportunity_list_status_idx ON ${T.opps} (status, trigger_ts DESC);
-- fib-entry MEASUREMENT columns (idempotent; existing deployments pick them up in place)
ALTER TABLE ${T.opps} ADD COLUMN IF NOT EXISTS pullback_pct numeric;
ALTER TABLE ${T.opps} ADD COLUMN IF NOT EXISTS fib_level_hit text;
-- confirmation-lag timestamps (idempotent): detected_ts = setup ready, triggered_ts = turn-up fired
ALTER TABLE ${T.opps} ADD COLUMN IF NOT EXISTS detected_ts timestamptz;
ALTER TABLE ${T.opps} ADD COLUMN IF NOT EXISTS triggered_ts timestamptz;
-- intended (f500, clamped) vs actual entry_price, to measure the confirmation-lag price gap
ALTER TABLE ${T.opps} ADD COLUMN IF NOT EXISTS intended_fib_price numeric;
-- ORDER BOOK (broker feed) at signal time + which cap bound the size. Recorded on every
-- opportunity so a later fill can be judged against the book that was actually there.
ALTER TABLE ${T.opps} ADD COLUMN IF NOT EXISTS book jsonb;
ALTER TABLE ${T.opps} ADD COLUMN IF NOT EXISTS liquidity_pass boolean;
ALTER TABLE ${T.opps} ADD COLUMN IF NOT EXISTS liquidity_checks jsonb;
ALTER TABLE ${T.opps} ADD COLUMN IF NOT EXISTS shares_by_volume_cap int;
ALTER TABLE ${T.opps} ADD COLUMN IF NOT EXISTS shares_by_book_cap int;
ALTER TABLE ${T.opps} ADD COLUMN IF NOT EXISTS cap_source text;

CREATE TABLE IF NOT EXISTS ${T.decisions} (
  id bigserial PRIMARY KEY, symbol text NOT NULL, opportunity_id bigint, trading_day date,
  action text NOT NULL, reason_code text, reason_text text, engine_version text,
  data jsonb,                                     -- full stock snapshot on BUY (null on SKIP)
  decided_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS decisions_day_idx ON ${T.decisions} (trading_day, decided_at DESC);
CREATE INDEX IF NOT EXISTS decisions_sym_day_idx ON ${T.decisions} (symbol, trading_day, decided_at DESC);
-- single user-action table: data column added idempotently for existing deployments
ALTER TABLE ${T.decisions} ADD COLUMN IF NOT EXISTS data jsonb;

CREATE TABLE IF NOT EXISTS ${T.signals} (
  id bigserial PRIMARY KEY, run_ts timestamptz NOT NULL, symbol text NOT NULL, trading_day date,
  engine_version text, snapshots int, age_min numeric(6,2), fresh boolean, in_radar boolean,
  trigger boolean, swing_count int, swing1_fils numeric, panel jsonb, reasons jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT scanner_signals_uq UNIQUE (run_ts, symbol));
CREATE INDEX IF NOT EXISTS scanner_signals_run_idx ON ${T.signals} (run_ts DESC);
CREATE INDEX IF NOT EXISTS scanner_signals_sym_idx ON ${T.signals} (symbol, run_ts DESC);

CREATE TABLE IF NOT EXISTS ${T.events} (
  id bigserial PRIMARY KEY, run_ts timestamptz NOT NULL, symbol text NOT NULL, trading_day date,
  engine_version text, entry_type text, reasons jsonb, profile text, trend text, lane text,
  swing1_fils numeric, entry_price numeric, reject_reason text,
  history_qualifies boolean, outcome text, detected_ts timestamptz, triggered_ts timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT radar_events_uq UNIQUE (run_ts, symbol));
CREATE INDEX IF NOT EXISTS radar_events_sym_idx ON ${T.events} (symbol, run_ts DESC);
-- confirmation-lag timestamps on the event stream too (idempotent)
ALTER TABLE ${T.events} ADD COLUMN IF NOT EXISTS detected_ts timestamptz;
ALTER TABLE ${T.events} ADD COLUMN IF NOT EXISTS triggered_ts timestamptz;
-- liquidity verdict on EVERY radar hit, including ones it would have blocked in gate
-- mode. This is the population the thresholds must be validated against.
ALTER TABLE ${T.events} ADD COLUMN IF NOT EXISTS liquidity_pass boolean;
ALTER TABLE ${T.events} ADD COLUMN IF NOT EXISTS liquidity_blocked boolean;
ALTER TABLE ${T.events} ADD COLUMN IF NOT EXISTS book jsonb;
ALTER TABLE ${T.events} ADD COLUMN IF NOT EXISTS liquidity_checks jsonb;

CREATE TABLE IF NOT EXISTS ${T.state} (
  symbol text PRIMARY KEY, processed_day date, outcome text, profile text, trend text,
  processed_ts timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS scanner_state_day_idx ON ${T.state} (processed_day);

CREATE TABLE IF NOT EXISTS ${T.session} (
  trading_day date PRIMARY KEY, budget_kd numeric, updated_at timestamptz NOT NULL DEFAULT now());

-- Indexes on the (ever-growing) snapshots table — without these the per-minute
-- live scan does full-table scans + sorts and takes minutes.
CREATE INDEX IF NOT EXISTS market_stock_snapshots_symbol_created_idx
  ON ${T.snapshots} (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS market_stock_snapshots_created_idx
  ON ${T.snapshots} (created_at DESC);`;

// Run the DDL only ONCE per process, not on every scan cycle.
let _tablesReady = false;
async function ensureTables(db) {
  if (_tablesReady) return;
  await db.query(DDL);
  _tablesReady = true;
}

async function loadLatestSymbols(db) {
  // Only symbols that traded in the last 2 days — index scan instead of full scan.
  const { rows } = await db.query(
    `SELECT DISTINCT ON (symbol) symbol FROM ${T.snapshots}
     WHERE created_at >= NOW() - INTERVAL '2 days'
     ORDER BY symbol, created_at DESC;`);
  return rows.map((r) => r.symbol);
}
async function loadWindows(db, symbols, n = CONFIG.WINDOW.snapshots) {
  if (!symbols.length) return new Map();
  // Top-N per symbol via LATERAL + LIMIT — uses the (symbol, created_at DESC)
  // index to read only n rows per symbol, no full-window scan/sort.
  const { rows } = await db.query(
    `SELECT w.symbol, w.last_price, w.change_percent, w.volume, w.avg_volume, w.created_at
       FROM unnest($1::text[]) AS sym(symbol)
       CROSS JOIN LATERAL (
         SELECT s.symbol, s.last_price, s.change_percent, s.volume, s.avg_volume, s.created_at
         FROM ${T.snapshots} s
         WHERE s.symbol = sym.symbol
         ORDER BY s.created_at DESC
         LIMIT $2
       ) w
      ORDER BY w.symbol, w.created_at ASC;`,
    [symbols, n]);
  const m = new Map();
  for (const r of rows) { if (!m.has(r.symbol)) m.set(r.symbol, []); m.get(r.symbol).push(r); }
  return m;
}
// Order-book window from the broker feed. Same LATERAL+LIMIT shape as loadWindows.
// stock_quotes is written by the watchlist scraper on its OWN cron, so its newest row
// can trail the snapshot by up to a minute; buildBook() carries ageMin and the caller
// fails open on stale. Errors are swallowed for the same reason — a quotes outage must
// degrade the engine to its old price-only behaviour, never stop the scan.
async function loadQuoteWindows(db, symbols, n = (CONFIG.LIQUIDITY && CONFIG.LIQUIDITY.window) || 20) {
  if (!symbols.length) return new Map();
  try {
    const { rows } = await db.query(
      `SELECT q.symbol, q.last_price, q.bid, q.bid_qty, q.offer, q.offer_qty, q.trades,
              q.high_price, q.low_price, q.volume, q.created_at
         FROM unnest($1::text[]) AS sym(symbol)
         CROSS JOIN LATERAL (
           SELECT s.symbol, s.last_price, s.bid, s.bid_qty, s.offer, s.offer_qty, s.trades,
                  s.high_price, s.low_price, s.volume, s.created_at
           FROM ${T.quotes} s
           WHERE s.symbol = sym.symbol
           ORDER BY s.created_at DESC
           LIMIT $2
         ) q
        ORDER BY q.symbol, q.created_at ASC;`,
      [symbols, n]);
    const m = new Map();
    for (const r of rows) { if (!m.has(r.symbol)) m.set(r.symbol, []); m.get(r.symbol).push(r); }
    return m;
  } catch (e) {
    console.warn(`[live] loadQuoteWindows failed (${e.message}) - liquidity unknown this cycle`);
    return new Map();
  }
}
async function loadClassifications(db) {
  try {
    const { rows } = await db.query(`SELECT symbol, profile, trend, lane, target_fils, net_fils, tradable_swings, price_band FROM ${T.classification};`);
    const m = new Map();
    for (const r of rows) m.set(r.symbol, r);
    return m;
  } catch { return new Map(); }   // classification table not built yet -> Live still runs, just no Gate-2 pass
}
async function loadBudget(db, tradingDay) {
  try {
    const { rows } = await db.query(`SELECT budget_kd FROM ${T.session} WHERE trading_day = $1;`, [tradingDay]);
    if (rows[0]) return Number(rows[0].budget_kd);
    console.warn(`[live] no budget row in session_settings for ${tradingDay} - sizing falls back to CONFIG.SIZING.defaultBudgetKd`);
    return null;
  } catch (e) {
    console.warn(`[live] loadBudget failed (${e.message}) - falling back to CONFIG.SIZING.defaultBudgetKd`);
    return null;
  }
}
async function loadProcessedToday(db, tradingDay) {
  await ensureTables(db);
  const { rows } = await db.query(`SELECT symbol FROM ${T.state} WHERE processed_day = $1;`, [tradingDay]);
  return new Set(rows.map((r) => r.symbol));
}

async function saveSignals(db, rows, runTs, version, day) {
  if (!rows.length) return;
  const cols = ['run_ts','symbol','trading_day','engine_version','snapshots','age_min','fresh','in_radar','trigger','swing_count','swing1_fils','panel','reasons'];
  const params = []; const tuples = rows.map((r, i) => {
    const b = i * cols.length;
    params.push(runTs, r.symbol, day, version, r.snapshots ?? null, r.age_min ?? null, r.fresh ?? null,
      r.in_radar ?? null, r.trigger ?? null, r.swing_count ?? null, r.swing1_fils ?? null,
      JSON.stringify(r.panel ?? {}), JSON.stringify(r.reasons ?? []));
    return '(' + cols.map((_, k) => `$${b + k + 1}`).join(',') + ')';
  });
  await db.query(`INSERT INTO ${T.signals} (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (run_ts, symbol) DO NOTHING;`, params);
}
async function saveRadarEvent(db, e, runTs, version, day) {
  await db.query(
    `INSERT INTO ${T.events} (run_ts,symbol,trading_day,engine_version,entry_type,reasons,profile,trend,lane,
       swing1_fils,entry_price,reject_reason,history_qualifies,outcome,detected_ts,triggered_ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (run_ts, symbol) DO NOTHING;`,
    [runTs, e.symbol, day, version, e.entry_type ?? null, JSON.stringify(e.reasons ?? []), e.profile ?? null,
     e.trend ?? null, e.lane ?? null, e.swing1_fils ?? null, e.entry_price ?? null, e.reject_reason ?? null,
     e.history_qualifies ?? null, e.outcome ?? null, e.detected_ts ?? null, e.triggered_ts ?? null]);
}

// #2B — the REJECTED list: radar hit but History said no. Sorted by swing size.
async function getRejectedList(db, tradingDay) {
  const { rows } = await db.query(
    `SELECT symbol, profile, trend, lane, swing1_fils, entry_price, reject_reason,
            max(run_ts) AS last_hit, count(*) AS hits_today
     FROM ${T.events} WHERE trading_day = $1 AND history_qualifies = false
     GROUP BY symbol, profile, trend, lane, swing1_fils, entry_price, reject_reason
     ORDER BY swing1_fils DESC NULLS LAST;`, [tradingDay]);
  return rows;
}

// #2B — re-classification candidates: stocks that keep hitting radar but are benched
// on >= minDays distinct days in the last N days -> their history is likely stale.
async function getReclassificationCandidates(db, { days = 10, minDays = 4 } = {}) {
  const { rows } = await db.query(
    `SELECT symbol, profile, lane, count(DISTINCT trading_day) AS reject_days,
            max(swing1_fils) AS biggest_swing
     FROM ${T.events}
     WHERE history_qualifies = false AND trading_day >= (CURRENT_DATE - $1::int)
     GROUP BY symbol, profile, lane
     HAVING count(DISTINCT trading_day) >= $2
     ORDER BY reject_days DESC, biggest_swing DESC NULLS LAST;`, [days, minDays]);
  return rows;   // History step can read this and recompute these symbols' classification
}
async function insertOpportunity(db, o, version, day) {
  const { rows } = await db.query(
    `INSERT INTO ${T.opps} (symbol,trigger_ts,trading_day,engine_version,profile,trend,lane,entry_type,
       entry_price,swing1_fils,swings_so_far,expected_fils,net_fils,price_band,rvol,change_pct,value_traded,volume,avg_volume,
       suggested_shares,contracts,kd_needed,est_profit_kd,size_tag,warnings,reasons,fib,pullback_pct,fib_level_hit,detected_ts,triggered_ts,intended_fib_price,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,'OPEN')
     ON CONFLICT (symbol, trigger_ts) DO NOTHING RETURNING id;`,
    [o.symbol, o.trigger_ts, day, version, o.profile, o.trend, o.lane, o.entry_type, o.entry_price,
     o.swing1_fils, o.swings_so_far, o.expected_fils, o.net_fils, o.price_band, o.rvol, o.change_pct, o.value_traded,
     o.volume, o.avg_volume, o.suggested_shares, o.contracts, o.kd_needed, o.est_profit_kd, o.size_tag,
     JSON.stringify(o.warnings ?? []), JSON.stringify(o.reasons ?? []), JSON.stringify(o.fib ?? null), o.pullback_pct ?? null, o.fib_level_hit ?? null, o.detected_ts ?? null, o.triggered_ts ?? null, o.intended_fib_price ?? null]);
  return rows[0]?.id ?? null;
}
async function markProcessed(db, { symbol, tradingDay, outcome, profile, trend, now }) {
  await db.query(
    `INSERT INTO ${T.state} (symbol,processed_day,outcome,profile,trend,processed_ts,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (symbol) DO UPDATE SET processed_day=EXCLUDED.processed_day, outcome=EXCLUDED.outcome,
       profile=EXCLUDED.profile, trend=EXCLUDED.trend, processed_ts=EXCLUDED.processed_ts, updated_at=now();`,
    [symbol, tradingDay, outcome ?? null, profile ?? null, trend ?? null, new Date(now).toISOString()]);
}
// ─── Batched writes — one round-trip each instead of one per symbol ──────────
async function saveRadarEvents(db, events, runTs, version, day) {
  if (!events.length) return;
  const cols = ['run_ts','symbol','trading_day','engine_version','entry_type','reasons','profile','trend','lane','swing1_fils','entry_price','reject_reason','history_qualifies','outcome','detected_ts','triggered_ts','liquidity_pass','liquidity_blocked','book','liquidity_checks'];
  const params = [];
  const tuples = events.map((e, i) => {
    const b = i * cols.length;
    params.push(runTs, e.symbol, day, version, e.entry_type ?? null, JSON.stringify(e.reasons ?? []),
      e.profile ?? null, e.trend ?? null, e.lane ?? null, e.swing1_fils ?? null, e.entry_price ?? null,
      e.reject_reason ?? null, e.history_qualifies ?? null, e.outcome ?? null, e.detected_ts ?? null, e.triggered_ts ?? null,
      e.liquidity_pass ?? null, e.liquidity_blocked ?? null,
      e.book ? JSON.stringify(e.book) : null, e.liquidity_checks ? JSON.stringify(e.liquidity_checks) : null);
    return '(' + cols.map((_, k) => `$${b + k + 1}`).join(',') + ')';
  });
  await db.query(`INSERT INTO ${T.events} (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (run_ts, symbol) DO NOTHING;`, params);
}

async function insertOpportunities(db, opps, version, day) {
  if (!opps.length) return;
  const cols = ['symbol','trigger_ts','trading_day','engine_version','profile','trend','lane','entry_type','entry_price','swing1_fils','swings_so_far','expected_fils','net_fils','price_band','rvol','change_pct','value_traded','volume','avg_volume','suggested_shares','contracts','kd_needed','est_profit_kd','size_tag','warnings','reasons','fib','pullback_pct','fib_level_hit','detected_ts','triggered_ts','intended_fib_price','book','liquidity_pass','liquidity_checks','shares_by_volume_cap','shares_by_book_cap','cap_source','status'];
  const params = [];
  const tuples = opps.map((o, i) => {
    const b = i * cols.length;
    params.push(o.symbol, o.trigger_ts, day, version, o.profile ?? null, o.trend ?? null, o.lane ?? null,
      o.entry_type ?? null, o.entry_price ?? null, o.swing1_fils ?? null, o.swings_so_far ?? null,
      o.expected_fils ?? null, o.net_fils ?? null, o.price_band ?? null, o.rvol ?? null, o.change_pct ?? null,
      o.value_traded ?? null, o.volume ?? null, o.avg_volume ?? null, o.suggested_shares ?? null,
      o.contracts ?? null, o.kd_needed ?? null, o.est_profit_kd ?? null, o.size_tag ?? null,
      JSON.stringify(o.warnings ?? []), JSON.stringify(o.reasons ?? []), JSON.stringify(o.fib ?? null), o.pullback_pct ?? null, o.fib_level_hit ?? null, o.detected_ts ?? null, o.triggered_ts ?? null, o.intended_fib_price ?? null,
      o.book ? JSON.stringify(o.book) : null, o.liquidity_pass ?? null,
      o.liquidity_checks ? JSON.stringify(o.liquidity_checks) : null,
      o.shares_by_volume_cap ?? null, o.shares_by_book_cap ?? null, o.cap_source ?? null, 'OPEN');
    return '(' + cols.map((_, k) => `$${b + k + 1}`).join(',') + ')';
  });
  await db.query(`INSERT INTO ${T.opps} (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (symbol, trigger_ts) DO NOTHING;`, params);
}

async function markProcessedBatch(db, rows) {
  if (!rows.length) return;
  const cols = ['symbol','processed_day','outcome','profile','trend','processed_ts'];
  const params = [];
  const tuples = rows.map((r, i) => {
    const b = i * cols.length;
    params.push(r.symbol, r.tradingDay, r.outcome ?? null, r.profile ?? null, r.trend ?? null, new Date(r.now).toISOString());
    return '(' + cols.map((_, k) => `$${b + k + 1}`).join(',') + ',now())';
  });
  await db.query(
    `INSERT INTO ${T.state} (${cols.join(',')},updated_at) VALUES ${tuples.join(',')}
     ON CONFLICT (symbol) DO UPDATE SET processed_day=EXCLUDED.processed_day, outcome=EXCLUDED.outcome,
       profile=EXCLUDED.profile, trend=EXCLUDED.trend, processed_ts=EXCLUDED.processed_ts, updated_at=now();`,
    params);
}

module.exports = { TABLES: T, DDL, ensureTables, loadLatestSymbols, loadWindows, loadQuoteWindows, loadClassifications,
  loadBudget, loadProcessedToday, saveSignals, saveRadarEvent, insertOpportunity, markProcessed, getRejectedList, getReclassificationCandidates,
  saveRadarEvents, insertOpportunities, markProcessedBatch };