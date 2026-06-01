const { parsePrice } = require("./parsePrice.js");

const { parsePercent } = require("./parsePercent.js");

const { parseVolume } = require("./parseVolume.js");

const { parseMarketCap } = require("./parseMarketCap.js");

const { extractUnit } = require("./extractUnit.js");

function normalizeStock(raw) {

  const volume =
    parseVolume(raw.volume);

  const avgVolume =
    parseVolume(raw.avg_volume);

  const marketCap =
    parseMarketCap(raw.market_cap);

  return {

    // --------------------------------
    // IDs
    // --------------------------------

    id: raw.id,

    ticker: raw.symbol,

    // --------------------------------
    // Company
    // --------------------------------

    company_name:
      raw.company_name,

    stock_url:
      raw.stock_url,

    // --------------------------------
    // Prices
    // --------------------------------

    price:
      parsePrice(
        raw.last_price
      ),

    price_unit: 
      extractUnit(
        raw.last_price
      ),

    percent_change:
      parsePercent(
        raw.change_percent
      ),

    

    change_value:
      parsePrice(raw.change),

    change_value_unit: 
      extractUnit(
        raw.change
      ),

    // --------------------------------
    // Volume
    // --------------------------------

    volume,

    volume_unit:
      extractUnit(
        raw.volume
      ),


    avg_volume: avgVolume,

    volume_ratio:
      avgVolume > 0
        ? Number(
            (
              volume /
              avgVolume
            ).toFixed(2)
          )
        : 0,

    // --------------------------------
    // Market Cap
    // --------------------------------

    market_cap: marketCap,

    // --------------------------------
    // Market Cap Tier
    // --------------------------------

    market_cap_tier:
      getMarketCapTier(
        marketCap
      ),

    // --------------------------------
    // Meta
    // --------------------------------

    scraped_at:
      raw.created_at,
  };
}

function getMarketCapTier(
  marketCap
) {

  if (
    marketCap >=
    20_000_000_000
  ) {
    return "MEGA";
  }

  if (
    marketCap >=
    10_000_000_000
  ) {
    return "LARGE";
  }

  if (
    marketCap >=
    5_000_000_000
  ) {
    return "MID";
  }

  if (
    marketCap >=
    1_000_000_000
  ) {
    return "SMALL";
  }

  return "MICRO";
}

module.exports = {
  normalizeStock,
};
