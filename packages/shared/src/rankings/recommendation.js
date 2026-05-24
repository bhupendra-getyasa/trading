function getRecommendation(stock) {

  const score =
    stock.ai_score || 0;

  // ---------------------------------
  // NEGATIVE CONDITIONS
  // ---------------------------------

  if (
    stock.fake_movement ===
    "Possible Fake Move"
  ) {
    return "AVOID";
  }

//   if (
//     stock.trend_signal !==
//     "Bullish"
//   ) {
//     return "AVOID";
//   }

  // ---------------------------------
  // SCORE BASED
  // ---------------------------------

  if (score >= 80) {
    return "STRONG BUY";
  }

  if (score >= 60) {
    return "BUY";
  }

  if (score >= 40) {
    return "HOLD";
  }

  if (score >= 20) {
    return "WEAK";
  }

  return "AVOID";
}

module.exports = {
  getRecommendation,
};