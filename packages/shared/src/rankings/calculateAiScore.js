// function calculateAiScore(stock) {

//   const percentMoveScore =
//     stock.percent_change * 5;

//   const volumeScore =
//     (stock.volume_ratio - 1) * 20;

//   let marketCapBonus = 0;

//   if (stock.market_cap > 20_000_000_000) {
//     marketCapBonus = 15;
//   } else if (
//     stock.market_cap > 10_000_000_000
//   ) {
//     marketCapBonus = 10;
//   } else if (
//     stock.market_cap > 5_000_000_000
//   ) {
//     marketCapBonus = 7;
//   } else if (
//     stock.market_cap > 1_000_000_000
//   ) {
//     marketCapBonus = 3;
//   }

//   let score =
//     50 +
//     percentMoveScore +
//     volumeScore +
//     marketCapBonus;

//   // Clamp 0-100

//   if (score > 100) {
//     score = 100;
//   }

//   if (score < 0) {
//     score = 0;
//   }

//   return Number(score.toFixed(2));
// }

function calculateAiScore(stock) {

  const percentMoveScore =
    stock.percent_change * 5;

  const volumeScore =
    (stock.volume_ratio - 1) * 20;

  let marketCapBonus = 0;

  // Market Cap Bonus Logic
  if (stock.market_cap >= 200_000_000_000) {
    // MEGA
    marketCapBonus = 15;
  } else if (
    stock.market_cap >= 10_000_000_000
  ) {
    // LARGE
    marketCapBonus = 10;
  } else if (
    stock.market_cap >= 2_000_000_000
  ) {
    // MID
    marketCapBonus = 5;
  } else if (
    stock.market_cap >= 300_000_000
  ) {
    // SMALL
    marketCapBonus = 0;
  } else {
    // MICRO
    marketCapBonus = -10;
  }

  let score =
    50 +
    percentMoveScore +
    volumeScore +
    marketCapBonus;

  // Clamp 0-100
  if (score > 100) {
    score = 100;
  }

  if (score < 0) {
    score = 0;
  }

  return Number(score.toFixed(2));
}

module.exports = {
  calculateAiScore,
};