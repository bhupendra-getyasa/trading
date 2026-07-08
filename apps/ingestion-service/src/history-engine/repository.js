'use strict';
/*
 * Repository — the only module that talks to PostgreSQL.
 *
 * Source tables (your schema):
 *   public.stock_prices        (minute bars: symbol, open/high/low/close,
 *                               change TEXT, volume TEXT, created_at TIMESTAMPTZ)
 *   public.stock_prices_daily  (pre-computed daily metrics; must expose
 *                               `symbol` and `trade_date`)
 *
 * Output table:
 *   public.history_scores      (now keyed by run_date + window + symbol)
 *
 * Every function takes an injected `db` (a pg Pool or a pooled client from
 * packages/shared) so this plugs straight into your monorepo.
 */

const { types } = require('pg');

// Return DATE (OID 1082) as 'YYYY-MM-DD' strings, not JS Date objects, so they
// sort lexically and match the intraday stability-map keys AND the window
// bounds. Safe to set once.
types.setTypeParser(1082, (v) => v);

// ---- configurable table / column names (override via env) ------------------
const T = {
  daily:  process.env.DAILY_TABLE  || 'public.stock_prices_daily',
  minute: process.env.MINUTE_TABLE || 'public.stock_prices',
  results: process.env.RESULTS_TABLE || 'public.history_scores',
  mSymbol: process.env.MINUTE_SYMBOL_COL || 'symbol',
  mVolume: process.env.MINUTE_VOLUME_COL || 'volume',
  mTime:   process.env.MINUTE_TIME_COL   || 'created_at',
};

const MIN_STABLE_BARS = 5; // min minute-bars in a day to trust its stability

// ============================================================================
// 1. DAILY METRICS  — small (~137 x days), loaded in full (windowing happens
//    in JS after load; ranking is cross-sectional within each window).
// ============================================================================
async function loadDaily(db) {
  const { rows } = await db.query(`SELECT * FROM ${T.daily};`);
  return rows;
}

// ============================================================================
// 2. INTRADAY VOLUME STABILITY  — aggregated IN SQL so we never pull ~5M rows.
//    volume is TEXT like '6.49 K' / '1.2 M'; parse it inside the query.
// ============================================================================
const MINUTE_AGG_SQL = `
WITH parsed AS (
  SELECT
    ${T.mSymbol}                                   AS symbol,
    (${T.mTime})::date                             AS trade_date,
    regexp_replace(${T.mVolume}, '[^0-9.]', '', 'g')::numeric
      * CASE
          WHEN ${T.mVolume} ILIKE '%m%' THEN 1000000
          WHEN ${T.mVolume} ILIKE '%k%' THEN 1000
          WHEN ${T.mVolume} ILIKE '%b%' THEN 1000000000
          ELSE 1
        END                                        AS vol
  FROM ${T.minute}
  WHERE ${T.mVolume} ~ '[0-9]'
)
SELECT symbol, trade_date,
       avg(vol)         AS vol_mean,
       stddev_samp(vol) AS vol_std,
       count(*)         AS n
FROM parsed
GROUP BY symbol, trade_date;`;

// -> Map(`${symbol}|${trade_date}` -> stability 0..100)
// Matches engine.intradayStability: clip(1 - std/mean, 0, 1) * 100, sample std.
async function loadVolumeStability(db) {
  const { rows } = await db.query(MINUTE_AGG_SQL);
  const map = new Map();
  for (const r of rows) {
    const n = Number(r.n);
    const mean = Number(r.vol_mean);
    const std = r.vol_std == null ? 0 : Number(r.vol_std);
    if (n >= MIN_STABLE_BARS && mean > 0) {
      const cv = std / mean;
      map.set(`${r.symbol}|${r.trade_date}`, Math.max(0, Math.min(1, 1 - cv)) * 100);
    }
  }
  return map;
}

// ============================================================================
// 3. RESULTS TABLE  — create if missing. NOTE the `window` column and the
//    unique key (run_date, window, symbol). If your table already exists,
//    run migration.sql instead of relying on this.
// ============================================================================
const DDL_RESULTS = `
CREATE TABLE IF NOT EXISTS ${T.results} (
  id            bigserial PRIMARY KEY,
  run_date      date         NOT NULL DEFAULT CURRENT_DATE,
  window        text         NOT NULL DEFAULT 'all',
  symbol        text         NOT NULL,
  rank          integer,
  final_score   numeric(5,1),
  base_score    numeric(5,1),
  mult          numeric(5,3),
  liquidity     numeric(5,1),
  opportunity   numeric(5,1),
  probability   numeric(5,1),
  risk          numeric(5,1),
  execution     numeric(5,1),
  consistency   numeric(5,1),
  confidence    text,
  valid_days    integer,
  completeness  numeric(4,2),
  active_ratio  numeric(4,2),
  created_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT history_scores_run_window_symbol_uq UNIQUE (run_date, window, symbol)
);
CREATE INDEX IF NOT EXISTS history_scores_run_window_idx ON ${T.results} (run_date DESC, window, rank ASC);
CREATE INDEX IF NOT EXISTS history_scores_symbol_idx     ON ${T.results} (symbol, window, run_date DESC);`;

async function ensureResultsTable(db) {
  await db.query(DDL_RESULTS);
}

// ============================================================================
// 4. UPSERT RESULTS  — idempotent on (run_date, window, symbol), chunked.
//    Each result row must carry `.window` (stamped in runHistoryScoring).
// ============================================================================
const COLS = [
  'run_date', 'window', 'symbol', 'rank', 'final_score', 'base_score', 'mult',
  'liquidity', 'opportunity', 'probability', 'risk', 'execution', 'consistency',
  'confidence', 'valid_days', 'completeness', 'active_ratio',
];
const CHUNK = 500; // rows per INSERT statement (keeps param count well bounded)

function rowTuple(r, runDate) {
  return [
    runDate, r.window, r.symbol, r.rank, r.final_score, r.base_score, r.mult,
    r.liquidity, r.opportunity, r.probability, r.risk, r.execution, r.consistency,
    r.confidence, r.valid_days, r.completeness, r.active_ratio,
  ];
}

async function saveResults(db, results, runDate) {
  const setClause = COLS
    .filter((c) => c !== 'run_date' && c !== 'window' && c !== 'symbol')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');

  for (let start = 0; start < results.length; start += CHUNK) {
    const slice = results.slice(start, start + CHUNK);
    const params = [];
    const tuples = slice.map((r, i) => {
      const base = i * COLS.length;
      params.push(...rowTuple(r, runDate));
      return '(' + COLS.map((_, k) => `$${base + k + 1}`).join(',') + ')';
    });
    // "window" is a reserved-ish word in SQL; quote it to be safe.
    const colList = COLS.map((c) => (c === 'window' ? '"window"' : c)).join(', ');
    const conflictSet = setClause; // EXCLUDED.window not needed (it's a key)
    const sql =
      `INSERT INTO ${T.results} (${colList})\n` +
      `VALUES ${tuples.join(', ')}\n` +
      `ON CONFLICT (run_date, "window", symbol) DO UPDATE SET ${conflictSet};`;
    await db.query(sql, params);
  }
}

module.exports = {
  TABLES: T,
  loadDaily,
  loadVolumeStability,
  ensureResultsTable,
  saveResults,
  MINUTE_AGG_SQL,
  DDL_RESULTS,
};