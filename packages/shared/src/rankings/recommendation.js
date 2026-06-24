// ─────────────────────────────────────────────────────────────────────────────
//  recommendation.js
//
//  Maps AI score → recommendation label and builds the trade plan.
//
//  Rating bands (exactly as per document):
//    85-100  STRONG BUY
//    70-84   BUY
//    50-69   WATCHLIST
//    30-49   WEAK
//    0-29    AVOID
//
//  Trade plan targets scale with confidence level.
// ─────────────────────────────────────────────────────────────────────────────

function getRecommendation(stock) {
  if (stock.fake_movement === 'Possible Fake Move') return 'AVOID';

  const score = stock.ai_score || 0;
  if (score >= 85) return 'STRONG BUY';
  if (score >= 70) return 'BUY';
  if (score >= 50) return 'WATCHLIST';
  if (score >= 30) return 'WEAK';
  return 'AVOID';
}

/**
 * Build a trade plan.
 * Targets and stop-loss scale with score confidence.
 * Win probability is derived from score.
 *
 * From the document:
 *   STRONG BUY → Target +3%, Stop -1.5%, same day–1 day
 *   BUY        → Target +2.5%, Stop -2%, 1-2 days
 *   WATCHLIST  → Watch for breakout, no immediate entry
 */
function getTradePlan(stock) {
  const price = stock.price    || 0;
  const score = stock.ai_score || 0;

  let target1Pct, target2Pct, stopLossPct, holdingPeriod;

  if (score >= 85) {
    // STRONG BUY — document says: Target +3%, Stop -1.5%, same day
    target1Pct    =  0.030;
    target2Pct    =  0.050;
    stopLossPct   = -0.015;
    holdingPeriod = 'Same day – 1 day';
  } else if (score >= 70) {
    // BUY
    target1Pct    =  0.025;
    target2Pct    =  0.040;
    stopLossPct   = -0.020;
    holdingPeriod = '1 – 2 days';
  } else if (score >= 50) {
    // WATCHLIST — wait for breakout
    target1Pct    =  0.020;
    target2Pct    =  0.035;
    stopLossPct   = -0.025;
    holdingPeriod = '2 – 3 days';
  } else {
    // WEAK / AVOID — wider stop, conservative targets
    target1Pct    =  0.015;
    target2Pct    =  0.025;
    stopLossPct   = -0.030;
    holdingPeriod = 'Speculative only';
  }

  // Probability of reaching Target 1 (calibrated to Kuwait market behaviour)
  // Document says: Score >85 → ~82%, 70-85 → ~74%, 50-70 → ~48%, <50 → ~29%
  let probability_3pct;
  if      (score >= 85) probability_3pct = Math.min(92, Math.round(70 + (score - 85) * 1.5));
  else if (score >= 70) probability_3pct = Math.round(55 + (score - 70) * 1.2);
  else if (score >= 50) probability_3pct = Math.round(35 + (score - 50) * 1.0);
  else                  probability_3pct = Math.max(10, Math.round(score * 0.6));

  const riskReward = price > 0
    ? +(target1Pct / Math.abs(stopLossPct)).toFixed(1)
    : 0;

  // Entry range: ±0.5% of current price (document: "Suggested Entry: 480-488")
  const entryLow  = +(price * 0.995).toFixed(3);
  const entryHigh = +(price * 1.005).toFixed(3);

  return {
    entry:            +price.toFixed(3),
    entry_low:        entryLow,
    entry_high:       entryHigh,
    target1:          +(price * (1 + target1Pct)).toFixed(3),
    target2:          +(price * (1 + target2Pct)).toFixed(3),
    stop_loss:        +(price * (1 + stopLossPct)).toFixed(3),
    probability_3pct,
    risk_reward:      riskReward,
    holding_period:   holdingPeriod,
  };
}

module.exports = { getRecommendation, getTradePlan };
