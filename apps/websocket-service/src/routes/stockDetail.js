const express = require("express");
const router  = express.Router();
const { pool } = require('@trading/shared');
const { normalizeStock }    = require('@trading/shared/src/normalization/normalizeStock.js');
const { calculateAiScore }  = require('@trading/shared/src/rankings/calculateAiScore.js');
const { getRecommendation, getTradePlan } = require('@trading/shared/src/rankings/recommendation.js');
const { fetchAllHistory }   = require('@trading/shared/src/rankings/stockHistory.js');

// ─────────────────────────────────────────────────────────────────────────────
//  GET /stocks/:symbol
//
//  Returns the full enriched profile for a single stock, including:
//   • Latest snapshot data
//   • 7-layer AI score + breakdown
//   • Trade plan (entry, targets, stop-loss, probability)
//   • Intraday history (sparkline + mini chart)
//   • Moving averages (MA20, MA50, MA200)
//   • Smart Money and Liquidity signals
// ─────────────────────────────────────────────────────────────────────────────

router.get('/stocks/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;

    // ── 1. Latest snapshot ─────────────────────────────────────────────────
    const stockResult = await pool.query(`
      SELECT *
      FROM market_stock_snapshots
      WHERE symbol = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [symbol]);

    if (!stockResult.rows.length) {
      return res.status(404).json({ message: 'Stock not found' });
    }

    const rawStock = stockResult.rows[0];
    const stock    = normalizeStock(rawStock);

    // ── 2. Daily history (365 days) for AI score ───────────────────────────
    const historyMap  = await fetchAllHistory(pool, [symbol]);
    const historyRows = historyMap.get(symbol) || [];

    // ── 3. 7-layer AI score + breakdown ───────────────────────────────────
    const { total: ai_score, breakdown } = calculateAiScore(stock, historyRows);

    // ── 4. Trade plan ──────────────────────────────────────────────────────
    const tradePlan = getTradePlan({ ...stock, ai_score });

    // ── 5. Recommendation ──────────────────────────────────────────────────
    const recommendation = getRecommendation({ ...stock, ai_score });

    // ── 6. Intraday snapshots (for sparkline + mini chart) ─────────────────
    const intradayResult = await pool.query(`
      SELECT
        created_at,
        last_price AS price,
        volume
      FROM market_stock_snapshots
      WHERE symbol = $1
      ORDER BY created_at ASC
      LIMIT 100
    `, [symbol]);

    // Deduplicate by minute
    const uniqueRows = [];
    const seenTimes  = new Set();

    for (const row of intradayResult.rows) {
      const ts = Math.floor(new Date(row.created_at).getTime() / (60 * 1000));
      if (!seenTimes.has(ts)) {
        seenTimes.add(ts);
        uniqueRows.push(row);
      }
    }

    // Build OHLC-style history from consecutive snapshots
    const history = uniqueRows.map((row, i, arr) => {
      const prevPrice = i === 0
        ? parseFloat(row.price)
        : parseFloat(arr[i - 1].price);
      const currPrice = parseFloat(row.price);
      return {
        time:        row.created_at,
        displayTime: new Date(row.created_at).toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', hour12: false,
        }),
        open:   prevPrice,
        high:   Math.max(prevPrice, currPrice),
        low:    Math.min(prevPrice, currPrice),
        close:  currPrice,
        volume: parseFloat(row.volume),
      };
    });

    const sparkline = uniqueRows.slice(-20).map(r => parseFloat(r.price));

    // ── 7. Growth status ───────────────────────────────────────────────────
    const growthStatus = stock.percent_change > 0 ? 'bullish' : 'bearish';

    // ── 8. Active swing (Fibonacci) ────────────────────────────────────────
    const swingResult = await pool.query(`
      SELECT *
      FROM fibonacci_swings
      WHERE symbol = $1
        AND status = 'ACTIVE'
      ORDER BY created_at DESC
      LIMIT 1
    `, [symbol]).catch(() => ({ rows: [] }));

    const swing = swingResult.rows[0] || null;

    // ── 9. Score label helper ──────────────────────────────────────────────
    function scoreLabel(score) {
      if (score >= 80) return 'Strong';
      if (score >= 50) return 'Moderate';
      if (score >= 20) return 'Weak';
      return 'None';
    }

    // ─────────────────────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: 'Stock fetched successfully',
      data: {
        // Identity
        symbol:       stock.ticker,
        name:         stock.company_name,
        stockUrl:     stock.stock_url,
        lastUpdated:  rawStock.created_at,

        // Price
        price:         stock.price,
        change:        stock.change_value,
        changePercent: stock.percent_change,

        // Volume
        volume:        stock.volume,
        avgVolume:     stock.avg_volume,
        volumeRatio:   stock.volume_ratio,

        // Market
        marketCap:     stock.market_cap,
        marketCapTier: stock.market_cap_tier,

        // ── 7-layer AI Score ──────────────────────────────────────────
        ai_score,
        recommendation,
        score_breakdown: {
          // Layer 1 — Today's Signal
          volume:     { score: breakdown.volumeScore,     label: scoreLabel(breakdown.volumeScore),     detail: `Volume ratio: ${breakdown.volumeRatio}x` },
          momentum:   { score: breakdown.momentumScore,   label: scoreLabel(breakdown.momentumScore),   detail: `Price change: ${stock.percent_change}%` },
          breakout:   { score: breakdown.breakoutScore,   label: breakdown.isBreakout ? 'Breakout!' : 'No breakout', detail: breakdown.isBreakout ? 'Above 20-day high' : 'Below 20-day high' },
          liquidity:  { score: breakdown.liquidityScore,  label: scoreLabel(breakdown.liquidityScore),  detail: `Value traded: ${breakdown.valueTraded.toLocaleString()}` },
          smart_money:{ score: breakdown.smartMoneyScore, label: scoreLabel(breakdown.smartMoneyScore), detail: 'Volume building before price move' },
          // Layer 2 — Historical Strength
          activity:   { score: breakdown.activityScore,   label: scoreLabel(breakdown.activityScore),   detail: `${breakdown.activeDays} active days in last 60` },
          trend:      { score: breakdown.trendScore,      label: scoreLabel(breakdown.trendScore),      detail: `MA20: ${breakdown.ma20} | MA50: ${breakdown.ma50} | MA200: ${breakdown.ma200}` },
          repeat_win: { score: breakdown.repeatScore,     label: scoreLabel(breakdown.repeatScore),     detail: `${breakdown.repeatWins} profitable setups in 12 months` },
        },

        // ── Trade Plan ────────────────────────────────────────────────
        trade_plan: {
          entry:            tradePlan.entry,
          target1:          tradePlan.target1,
          target2:          tradePlan.target2,
          stop_loss:        tradePlan.stop_loss,
          probability_3pct: tradePlan.probability_3pct,
          risk_reward:      tradePlan.risk_reward,
          holding_period:   tradePlan.holding_period,
        },

        // ── Moving Averages ───────────────────────────────────────────
        moving_averages: {
          ma20:  breakdown.ma20,
          ma50:  breakdown.ma50,
          ma200: breakdown.ma200,
        },

        // ── Chart data ────────────────────────────────────────────────
        history,
        sparkline,
        growthStatus,

        // ── Fibonacci swing ───────────────────────────────────────────
        swing: swing ? {
          direction:   swing.trend_direction,
          high:        swing.swing_high,
          low:         swing.swing_low,
          status:      swing.status,
        } : null,
      },
    });

  } catch (error) {
    console.error('[stockDetail]', error);
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
