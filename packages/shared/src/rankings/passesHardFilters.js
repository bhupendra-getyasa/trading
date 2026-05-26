export function passesHardFilters(
  stock
) {

  return true;

  // return (

  //   // #1 Trend
  //   stock.trend_signal ===
  //     "Bullish" &&

  //   // #8 BUY Signal
  //   // stock.buy_signal ===
  //   //   "BUY" &&
  //   [
  //     "STRONG BUY",
  //     "BUY",
  //     "HOLD",
  //     "AVOID"
  //   ].includes(stock.recommendation) &&

  //   // #33 Liquidity
  //   ["High", "Medium"].includes(
  //     stock.liquidity
  //   ) &&

  //   // #7 Fake Movement
  //   stock.fake_movement !==
  //     "Possible Fake Move"
  // );
}