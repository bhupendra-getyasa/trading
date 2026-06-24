// ─────────────────────────────────────────────────────────────────────────────
//  scoring.js — composite score for final display ranking
//
//  ai_score is the primary signal (80% weight).
//  Two tie-breakers for stocks with the same ai_score:
//    • DB vol ratio (15%) — uses db_vol_ratio from enrichStock, NOT the
//      TradingView avg_volume ratio. This keeps both calculations consistent.
//    • Value traded (5%)  — higher KWD value = more liquid, safer to execute.
//
//  BUG FIX vs v4: was using stock.volume_ratio (TradingView avg_volume) which
//  is inconsistent with the DB 20-day avg used inside calculateAiScore.
// ─────────────────────────────────────────────────────────────────────────────

function calculateCompositeScore(stock) {
  const aiScore    = stock.ai_score     || 0;
  // Use DB-computed ratio (from calculateAiScore) for consistency.
  // Fall back to normalizeStock ratio only if db_vol_ratio not present.
  const volRatio   = stock.db_vol_ratio ?? stock.volume_ratio ?? 0;
  const price      = stock.price        || 0;
  const volume     = stock.volume       || 0;
  const valueTraded = price * volume;

  const base         = aiScore * 0.80;
  const volBreaker   = Math.min(volRatio / 5, 1) * 15;
  const valBreaker   = Math.min(valueTraded / 10_000_000, 1) * 5;

  const compositeScore = Math.min(100, Math.max(0,
    +(base + volBreaker + valBreaker).toFixed(2)
  ));

  return { compositeScore, volumeRatio: +volRatio.toFixed(2) };
}

module.exports = { calculateCompositeScore };
