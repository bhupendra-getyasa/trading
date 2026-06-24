// ─────────────────────────────────────────────────────────────────────────────
//  processTopPerformers.js
//
//  Scores and ranks ALL stocks. No stock is excluded from the list.
//  The score itself communicates opportunity level — from STRONG BUY to AVOID.
//
//  Pipeline:
//    1. Normalize all snapshots
//    2. Batch-fetch 365-day daily history (single DB round-trip)
//    3. NEW: Build intradayData per symbol from intraday snapshots
//    4. NEW: Build recentDayChanges per symbol from last 3 days of closing data
//    5. Score every stock with the 6-layer AI engine (v6)
//    6. Sort by compositeScore DESC
//    7. Add rankNo
//
//  v6 changes:
//  - Accepts optional intradaySnapshots (array of 1-min rows for today).
//  - Accepts optional recentClosingData (Map<symbol, [todayPct, ystPct, d2Pct]>).
//  - Computes first30minVol, last30minVol, intradayMovePct from snapshots.
//  - Passes intradayData to enrichStock → calculateAiScore.
// ─────────────────────────────────────────────────────────────────────────────

const { normalizeStock }          = require('../normalization/normalizeStock.js');
const { calculateIndicators }     = require('../formula-engine/calculateIndicators.js');
const { enrichStock }             = require('./enrichStock.js');
const { calculateCompositeScore } = require('./scoring.js');
const { fetchAllHistory }         = require('./stockHistory.js');

/**
 * Build intradayData map from raw intraday snapshot rows.
 * Groups by symbol, sorts by time, computes first/last 30-min volumes
 * and the price move % from session open to 30 minutes in.
 *
 * @param {object[]} intradaySnapshots  — raw 1-min rows from today's scrape
 * @returns {Map<string, object>}       — Map<symbol, intradayData>
 */
function buildIntradayMap(intradaySnapshots) {
  if (!intradaySnapshots || intradaySnapshots.length === 0) return new Map();

  // Group by symbol
  const bySymbol = new Map();
  for (const row of intradaySnapshots) {
    if (!row.symbol) continue;
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol).push(row);
  }

  const result = new Map();
  const parseNum = v => parseFloat(String(v || 0).replace(/[^0-9.-]/g, '')) || 0;

  for (const [symbol, rows] of bySymbol) {
    // Sort oldest → newest
    rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const sessionOpen  = new Date(rows[0].created_at);
    const mark30       = new Date(sessionOpen.getTime() + 30 * 60 * 1000);
    const markLast30   = new Date(rows[rows.length - 1].created_at).getTime() - 30 * 60 * 1000;

    const first30rows  = rows.filter(r => new Date(r.created_at) <= mark30);
    const last30rows   = rows.filter(r => new Date(r.created_at).getTime() >= markLast30);

    const first30minVol = first30rows.length > 0
      ? Math.max(...first30rows.map(r => parseNum(r.volume)))
      : 0;
    const last30minVol  = last30rows.length  > 0
      ? Math.max(...last30rows.map(r => parseNum(r.volume)))
      : 0;

    // Price move in first 30 min (open price vs price at 30-min mark)
    const priceOpen   = parseNum(rows[0].last_price);
    const price30m    = first30rows.length > 0 ? parseNum(first30rows[first30rows.length - 1].last_price) : priceOpen;
    const intradayMovePct = priceOpen > 0 ? ((price30m - priceOpen) / priceOpen) * 100 : 0;

    result.set(symbol, { first30minVol, last30minVol, intradayMovePct });
  }

  return result;
}

/**
 * @param {object[]}          rawStocks          — rows from market_stock_snapshots
 * @param {object[]}          formulas            — loaded formula definitions
 * @param {import('pg').Pool} pool                — postgres connection pool
 * @param {object[]}          [intradaySnapshots] — NEW: today's 1-min rows (optional)
 * @param {Map<string,number[]>} [recentClosingMap] — NEW: Map<symbol, [todayPct, ystPct, d2Pct]>
 *                                                    Pass last 3 days closing changePct per symbol.
 *                                                    Build this from your nightly closing snapshots.
 * @returns {Promise<object[]>}                   — all stocks ranked, best first
 */
async function processTopPerformers(rawStocks, formulas, pool, intradaySnapshots = [], recentClosingMap = new Map()) {

  if (!rawStocks || rawStocks.length === 0) {
    console.warn('[processTopPerformers] No raw stocks received');
    return [];
  }

  console.log(`[processTopPerformers] Scoring ${rawStocks.length} stocks...`);

  // ── 1. Normalize ──────────────────────────────────────────────────────────
  const normalized = rawStocks.map(normalizeStock);

  // ── 2. Batch-fetch 365-day history ────────────────────────────────────────
  const symbols    = normalized.map(s => s.ticker).filter(Boolean);
  const historyMap = pool
    ? await fetchAllHistory(pool, symbols).catch(err => {
        console.warn('[processTopPerformers] history fetch failed:', err.message);
        return new Map();
      })
    : new Map();

  console.log(`[processTopPerformers] History loaded for ${historyMap.size}/${symbols.length} symbols`);

  // ── 3. NEW: Build intraday data map ──────────────────────────────────────
  const intradayMap = buildIntradayMap(intradaySnapshots);
  console.log(`[processTopPerformers] Intraday data for ${intradayMap.size} symbols`);

  // ── 4. Score every stock ──────────────────────────────────────────────────
  const results = [];

  for (const stock of normalized) {
    try {
      const indicators  = await calculateIndicators(stock, formulas);
      const historyRows = historyMap.get(stock.ticker) || [];

      // Build intradayData for this symbol
      const intra = intradayMap.get(stock.ticker) || {};
      const recentDayChanges = recentClosingMap.get(stock.ticker) || [];
      const intradayData = {
        first30minVol:    intra.first30minVol   || 0,
        last30minVol:     intra.last30minVol    || 0,
        intradayMovePct:  intra.intradayMovePct || 0,
        recentDayChanges,                         // [todayPct, yesterdayPct, dayBeforePct]
      };

      const enriched    = enrichStock(stock, indicators, historyRows, intradayData);  // ← v6
      const { compositeScore, volumeRatio } = calculateCompositeScore(enriched);

      results.push({ ...enriched, compositeScore, volumeRatio });

    } catch (err) {
      console.warn(`[processTopPerformers] Error scoring ${stock.ticker}:`, err.message);
      results.push({
        ...stock,
        ai_score:       0,
        compositeScore: 0,
        recommendation: 'AVOID',
        score_breakdown: {},
        error:          err.message,
      });
    }
  }

  // ── 5. Sort by compositeScore DESC ───────────────────────────────────────
  results.sort((a, b) => b.compositeScore - a.compositeScore);

  // ── 6. Add rank numbers ───────────────────────────────────────────────────
  const ranked = results.map((stock, index) => ({
    rankNo: index + 1,
    ...stock,
  }));

  const byRec = ranked.reduce((acc, s) => {
    acc[s.recommendation] = (acc[s.recommendation] || 0) + 1;
    return acc;
  }, {});

  // NEW: log zero reasons for debugging
  const zeroReasons = ranked.filter(s => s.zero_reason).reduce((acc, s) => {
    acc[s.zero_reason] = (acc[s.zero_reason] || 0) + 1;
    return acc;
  }, {});

  console.log(`[processTopPerformers] Done. ${ranked.length} stocks ranked.`, byRec);
  if (Object.keys(zeroReasons).length) {
    console.log(`[processTopPerformers] Zero-score reasons:`, zeroReasons);
  }

  return ranked;
}

module.exports = { processTopPerformers, buildIntradayMap };
