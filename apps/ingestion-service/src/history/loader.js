// =============================================================================
// KSE Signal Engine — Step 4: Data Loader
// Reads 1-min rows from stock_prices, parses volumes, groups by date.
// =============================================================================

'use strict';

const { parseVolume } = require('./config');

// ---------------------------------------------------------------------------
// 4A. Fetch symbols to TRANSFORM
//
// priceMax is a RECOMMENDATION criterion enforced later at ranking time, NOT
// here. The transform computes metrics for ALL symbols (including KFH, NBK,
// MABANEE, OOREDOO priced >= 500 fils). priceMax is used only for an
// informational log; nothing is excluded.
// ---------------------------------------------------------------------------
/**
 * @param {import('pg').Pool} pool
 * @param {number} [priceMax]  fils — informational only (no longer filters)
 * @returns {Promise<string[]>}
 */
async function fetchSymbols(pool, priceMax) {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (symbol)
      symbol,
      close::numeric AS last_close
    FROM public.stock_prices
    ORDER BY symbol, created_at DESC;
  `);

  const symbols    = [];
  const abovePrice = [];   // tracked for visibility only — NOT excluded

  for (const row of rows) {
    symbols.push(row.symbol);
    if (priceMax != null && parseFloat(row.last_close) >= priceMax) {
      abovePrice.push({ symbol: row.symbol, price: parseFloat(row.last_close) });
    }
  }

  console.log(
    `[loader] Symbols: ${symbols.length} to transform (ALL symbols). ` +
    `${abovePrice.length} are >= ${priceMax} fils — still transformed, ` +
    `price eligibility is applied later at ranking time.`
  );
  for (const e of abovePrice) {
    console.log(`  ABOVE PRICE CAP (still transformed): ${e.symbol} at ${e.price} fils`);
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// 4B. Fetch 1-min rows for one symbol across a date range
// Returns: Map<dateStr, rows[]>
// ---------------------------------------------------------------------------
/**
 * @param {import('pg').Pool} pool
 * @param {string} symbol
 * @param {string} dateFrom  'YYYY-MM-DD'
 * @param {string} dateTo    'YYYY-MM-DD'
 * @returns {Promise<Map<string, Array>>}
 */
async function fetchRawRows(pool, symbol, dateFrom, dateTo) {
  const params  = [symbol];
  const clauses = ['symbol = $1'];

  if (dateFrom) { clauses.push(`created_at::date >= $${params.length + 1}`); params.push(dateFrom); }
  if (dateTo)   { clauses.push(`created_at::date <= $${params.length + 1}`); params.push(dateTo);   }

  const sql = `
    SELECT
      created_at::date::text      AS trade_date,
      created_at            AS ts,
      open::numeric         AS open,
      high::numeric         AS high,
      low::numeric          AS low,
      close::numeric        AS close,
      volume                AS vol_raw   -- TEXT — parsed below (FIX #1)
    FROM  public.stock_prices
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at ASC;            -- FIX #2 — ASC so closes[-1] = last close
  `;

  const { rows } = await pool.query(sql, params);

  // Group by trade_date and parse volume
  const grouped = new Map();
  for (const row of rows) {
    const dateKey = row.trade_date;
    if (!grouped.has(dateKey)) grouped.set(dateKey, []);

    grouped.get(dateKey).push({
      ts:    row.ts,
      open:  parseFloat(row.open),
      high:  parseFloat(row.high),
      low:   parseFloat(row.low),
      close: parseFloat(row.close),
      vol:   parseVolume(row.vol_raw),   // FIX #1 — handles K/M suffix
    });
  }

  console.log(`[loader] ${symbol}: ${grouped.size} trading days fetched`);
  return grouped;
}

// ---------------------------------------------------------------------------
// 4C. Fetch dates already in stock_prices_daily (for incremental mode)
// ---------------------------------------------------------------------------
/**
 * @param {import('pg').Pool} pool
 * @param {string} symbol
 * @returns {Promise<Set<string>>}
 */
async function fetchComputedDates(pool, symbol) {
  const { rows } = await pool.query(
    `SELECT trade_date::text FROM public.stock_prices_daily WHERE symbol = $1;`,
    [symbol]
  );
  return new Set(rows.map(r => r.trade_date.slice(0, 10)));
}

// ---------------------------------------------------------------------------
// 4D. Resolve date range (defaults to last N days)
// ---------------------------------------------------------------------------
/**
 * @param {string|null} dateFrom
 * @param {string|null} dateTo
 * @param {number}      lookbackDays
 * @returns {{ dateFrom: string, dateTo: string }}
 */
function resolveDateRange(dateFrom, dateTo, lookbackDays = 90) {
  const to   = dateTo   ? new Date(dateTo)   : new Date();
  const from = dateFrom ? new Date(dateFrom) : new Date(to - lookbackDays * 86_400_000);

  return {
    dateFrom: from.toISOString().slice(0, 10),
    dateTo:   to.toISOString().slice(0, 10),
  };
}

module.exports = {
  fetchSymbols,
  fetchRawRows,
  fetchComputedDates,
  resolveDateRange,
};