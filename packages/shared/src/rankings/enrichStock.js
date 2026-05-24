// function enrichStock(
//   stock,
//   indicators
// ) {
//   return {

//     ...stock,

//     trend_signal:
//       indicators[
//         "Bullish/Bearish Trend"
//       ],

//     buy_signal:
//       indicators[
//         "BUY Signal"
//       ],

//     momentum_rank:
//       indicators[
//         "Price Momentum Ranking"
//       ],

//     buying_pressure:
//       indicators[
//         "Strong Buying Pressure"
//       ],

//     volume_spike:
//       indicators[
//         "Volume Spike Detection"
//       ],

//     ai_score:
//       calculateAiScore(
//         stock,
//         indicators
//       ),

//     liquidity:
//       indicators[
//         "Liquidity Detection"
//       ],

//     fake_movement:
//       indicators[
//         "Fake Movement Detection"
//       ],
//   };
// }

const { calculateAiScore } = require("./calculateAiScore.js");

const { getRecommendation } = require("./recommendation.js");



function enrichStock(
  stock,
  indicators
) {

  const ai_score = calculateAiScore(
    stock
  );

  const recommendation =
  getRecommendation({
    ...stock,
    ...indicators,
    ai_score,
  });


  return {

    ...stock,

    trend_signal:
      indicators[
        "Bullish/Bearish Trend"
      ] || null,

    buy_signal:
      indicators[
        "BUY Signal"
      ] || null,

    momentum_rank:
      indicators[
        "Price Momentum Ranking"
      ] || null,

    buying_pressure:
      indicators[
        "Strong Buying Pressure"
      ] || null,

    volume_spike:
      indicators[
        "Volume Spike Detection"
      ] || null,

    // ai_score:
    //   calculateAiScore(
    //     stock,
    //     indicators
    //   ) || null,

    liquidity:
      indicators[
        "Liquidity Detection"
      ] || "Low",

    fake_movement:
      indicators[
        "Fake Movement Detection"
      ] || null,

    ai_score,

    recommendation,
  };
}

// function calculateAiScore(
//   stock,
//   indicators
// ) {

//   let score = 0;

//   if (
//     indicators[
//       "Bullish/Bearish Trend"
//     ] === "Bullish"
//   ) {
//     score += 20;
//   }

//   if (
//     indicators[
//       "BUY Signal"
//     ] === "BUY"
//   ) {
//     score += 20;
//   }

//   if (
//     indicators[
//       "Strong Buying Pressure"
//     ]
//   ) {
//     score += 20;
//   }

//   if (
//     indicators[
//       "Volume Spike Detection"
//     ]
//   ) {
//     score += 20;
//   }

//   if (
//     stock.volume_ratio > 1.5
//   ) {
//     score += 20;
//   }

//   return score;
// }

module.exports = {
    enrichStock
}