const express = require("express");
const router = express.Router();
const { pool } = require('@trading/shared');

router.get('/stocks/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;

    //
    // Latest snapshot
    //
    const stockResult = await pool.query(`
      SELECT *
      FROM market_stock_snapshots
      WHERE symbol = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [symbol]);

    if (!stockResult.rows.length) {
      return res.status(404).json({
        message: 'Stock not found'
      });
    }

    const stock = stockResult.rows[0];

    //
    // Previous snapshots
    // Used for history + sparkline
    //
    const historyResult = await pool.query(`
      SELECT
          created_at,
          last_price AS price,
          volume AS volume
      FROM market_stock_snapshots
      WHERE symbol = $1
      ORDER BY created_at ASC
      LIMIT 50
    `, [symbol]);

    //
    // Active swing
    //
    const swingResult = await pool.query(`
      SELECT *
      FROM fibonacci_swings
      WHERE symbol = $1
      AND status = 'ACTIVE'
      ORDER BY created_at DESC
      LIMIT 1
    `, [symbol]);

    const swing = swingResult.rows[0];

    //
    // Build history candles
    //

    const uniqueRows = [];
    const seenTimes = new Set();

    for (const row of historyResult.rows) {
      const timestamp = Math.floor(
        new Date(row.created_at).getTime() / 1000
      );

      // Skip duplicates
      if (seenTimes.has(timestamp)) {
        continue;
      }

      seenTimes.add(timestamp);
      uniqueRows.push(row);
    }

    const history = uniqueRows.map((row, index, arr) => {
      const previousPrice =
        index === 0
          ? parseFloat(row.price)
          : parseFloat(arr[index - 1].price);

      const currentPrice = parseFloat(row.price);

      return {
        time: row.created_at,

        displayTime: new Date(row.created_at).toLocaleTimeString(
          'en-US',
          {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          }
        ),

        open: previousPrice,
        high: Math.max(previousPrice, currentPrice),
        low: Math.min(previousPrice, currentPrice),
        close: currentPrice,
        volume: parseFloat(row.volume)
      };
    });

    //
    // Sparkline
    //
    const sparkline = historyResult.rows
      .slice(-20)
      .map(r => parseInt(r.price));

    //
    // Momentum
    //
    const firstPrice =
      parseFloat(historyResult.rows[0]?.price || stock.last_price);

    const lastPrice =
      parseFloat(stock.last_price);

    const momentum =
      ((lastPrice - firstPrice) / firstPrice) * 100;

    //
    // Relative Volume
    //
    const avgVolume =
      historyResult.rows.reduce(
        (sum, row) => sum + parseInt(row.volume),
        0
      ) / historyResult.rows.length;

    const rvol =
      avgVolume > 0
        ? parseFloat(stock.volume) / avgVolume
        : 1;

    //
    // Growth Status
    //
    const growthStatus =
      parseFloat(stock.change_percent) > 0
        ? 'bullish'
        : 'bearish';

    //
    // AI Recommendation
    //
    let aiRecommendation = 'NEUTRAL';

    if (momentum > 5) {
      aiRecommendation = 'MOMENTUM PLAY';
    } else if (momentum > 2) {
      aiRecommendation = 'BUY';
    } else if (momentum < -5) {
      aiRecommendation = 'SELL';
    }

    return res.status(200).json({
      success: true, 
      message: 'Stock fetched successfully',
      data: {
        symbol: stock.symbol,
        name: stock.company_name,
  
        price: parseFloat(stock.last_price),
        change: parseFloat(stock.change),
        changePercent: parseFloat(stock.change_percent),
  
        volume: parseFloat(stock.volume),
        marketCap: parseFloat(stock.market_cap),
  
        momentum,
  
        lastUpdated: stock.created_at,
  
        sector:
          swing?.trend_direction === 'BULLISH'
            ? 'Industrials'
            : 'Financials',
  
        rvol,
  
        growthStatus,
  
        sparkline,
  
        aiRecommendation,
  
        history
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: error.message
    });
  }
});

module.exports = router;