// ─────────────────────────────────────────────────────────────────────────────
//  stockHistory.js
//
//  Fetches daily price history for ALL symbols in a single DB round-trip.
//
//  Your market_stock_snapshots table stores one row per minute.
//  This collapses them to one row per trading day (Kuwait TZ)
//  by taking the LAST snapshot of each day (closing price).
//
//  BUG FIX: Previous query used DISTINCT ON with ORDER BY in wrong order.
//  DISTINCT ON requires the ORDER BY to begin with the DISTINCT ON columns,
//  and picks the FIRST row per group — so to get the LAST snapshot of the
//  day you must order created_at DESC inside the DISTINCT ON group.
//  The fix uses a subquery with ROW_NUMBER() which is unambiguous.
//
//  Returns: Map<symbol, Array<{ date, price, volume, changePct }>>
//           Array is sorted newest → oldest (ready for moving averages).
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_DAYS = 365; // enough for MA200 + repeat-win (12-month) scan

/**
 * Fetch daily history for all symbols in one SQL call.
 * @param {import('pg').Pool} pool
 * @param {string[]}          symbols  – list of ticker symbols
 * @returns {Promise<Map<string, Array>>}
 */
async function fetchAllHistory(pool, symbols) {
  if (!symbols || symbols.length === 0) return new Map();

  // ── BUG FIX: Use ROW_NUMBER() to reliably pick last snapshot per day ──────
  // The old DISTINCT ON approach failed because DISTINCT ON picks the FIRST row
  // after the ORDER BY, but the ORDER BY had 'created_at DESC' after
  // 'trade_date DESC' — PostgreSQL requires DISTINCT ON columns to appear first
  // in ORDER BY, so 'created_at DESC' was ignored → wrong row selected per day.
  const sql = `
    SELECT
      symbol,
      trade_date,
      last_price_raw,
      volume_raw,
      change_pct_raw
    FROM (
      SELECT
        symbol,
        DATE(created_at AT TIME ZONE 'Asia/Kuwait') AS trade_date,
        last_price      AS last_price_raw,
        volume          AS volume_raw,
        change_percent  AS change_pct_raw,
        ROW_NUMBER() OVER (
          PARTITION BY symbol, DATE(created_at AT TIME ZONE 'Asia/Kuwait')
          ORDER BY created_at DESC          -- take the LAST snapshot of each day
        ) AS rn
      FROM public.market_stock_snapshots
      WHERE symbol = ANY($1)
        AND created_at >= NOW() - ($2 || ' days')::interval
    ) ranked
    WHERE rn = 1
    ORDER BY symbol, trade_date DESC
  `;

  const { rows } = await pool.query(sql, [symbols, HISTORY_DAYS]);

  // Group into Map<symbol, rows[]>  (already sorted newest → oldest per symbol)
  const map = new Map();

  for (const r of rows) {
    if (!map.has(r.symbol)) map.set(r.symbol, []);
    map.get(r.symbol).push({
      date:      r.trade_date,
      price:     parseNumeric(r.last_price_raw),
      volume:    parseVolume(r.volume_raw),
      changePct: parsePercent(r.change_pct_raw),
    });
  }

  return map;
}

// ── Inline parsers (mirrors existing normalization, no extra dep) ─────────────

function parseNumeric(value) {
  if (!value || value === '—') return 0;
  return parseFloat(
    String(value).replace(/,/g, '').replace(/[A-Z]+/gi, '').replace(/−/g, '-').trim()
  ) || 0;
}

function parseVolume(value) {
  if (!value || value === '—') return 0;
  const v = String(value).trim();
  const n = parseFloat(v.replace(/,/g, ''));
  if (v.includes('B')) return n * 1_000_000_000;
  if (v.includes('M')) return n * 1_000_000;
  if (v.includes('K')) return n * 1_000;
  return n || 0;
}

function parsePercent(value) {
  if (!value || value === '—') return 0;
  return parseFloat(
    String(value).replace('%', '').replace('−', '-').replace('+', '').trim()
  ) || 0;
}

module.exports = { fetchAllHistory };
