function calculateCompositeScore(
  stock
) {
  // ----------------------------------------
  // MOMENTUM SCORE
  // ----------------------------------------

  const momentumScore =
    normalize(
      Math.abs(stock.percent_change),
      0,
      10
    ) * 40;

  // ----------------------------------------
  // VOLUME RATIO
  // ----------------------------------------

  const volumeRatio =
    stock.avg_volume > 0
      ? stock.volume /
        stock.avg_volume
      : 0;

  const volumeScore =
    normalize(volumeRatio, 0, 5) *
    25;

  // ----------------------------------------
  // AI SCORE
  // ----------------------------------------

  const aiScore =
    normalize(stock.ai_score, 0, 100) *
    20;

  // ----------------------------------------
  // LIQUIDITY BONUS
  // ----------------------------------------

  let liquidityBonus = 0;

  if (stock.liquidity === "High") {
    liquidityBonus = 10;
  }

  if (
    stock.liquidity === "Medium"
  ) {
    liquidityBonus = 5;
  }

  // ----------------------------------------
  // MARKET CAP BONUS
  // ----------------------------------------

  let marketCapBonus = 0;

  if (
    stock.market_cap > 20000000000
  ) {
    marketCapBonus = 15;
  } else if (
    stock.market_cap > 10000000000
  ) {
    marketCapBonus = 10;
  } else if (
    stock.market_cap > 5000000000
  ) {
    marketCapBonus = 7;
  } else if (
    stock.market_cap > 1000000000
  ) {
    marketCapBonus = 3;
  }

  // ----------------------------------------
  // FINAL
  // ----------------------------------------

  const total =
    momentumScore +
    volumeScore +
    aiScore +
    liquidityBonus +
    marketCapBonus;

  return {
    volumeRatio,
    compositeScore:
      total > 100 ? 100 : total,
  };
}

function normalize(
  value,
  min,
  max
) {
  if (value <= min) return 0;

  if (value >= max) return 1;

  return (value - min) / (max - min);
}

module.exports = {
  calculateCompositeScore,
};