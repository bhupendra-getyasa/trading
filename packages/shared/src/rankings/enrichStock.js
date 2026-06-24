// ─────────────────────────────────────────────────────────────────────────────
//  enrichStock.js
//  Merges AI score + trade plan into one stock object.
//
//  v6 changes:
//  - Accepts optional intradayData and recentDayChanges for new scoring signals.
//  - Passes them through to calculateAiScore.
// ─────────────────────────────────────────────────────────────────────────────

const { calculateAiScore }               = require('./calculateAiScore.js');
const { getRecommendation, getTradePlan } = require('./recommendation.js');

/**
 * @param {object}   stock             — normalizeStock() output
 * @param {object}   indicators        — formula-engine results
 * @param {Array}    historyRows       — [{price, volume, changePct}] newest-first
 * @param {object}   [intradayData]    — NEW: optional intraday signals
 * @param {number}   intradayData.first30minVol    — volume in first 30 min
 * @param {number}   intradayData.last30minVol     — volume in last 30 min
 * @param {number}   intradayData.intradayMovePct  — price move % in first 30 min
 * @param {number[]} intradayData.recentDayChanges — [today%, yesterday%, dayBefore%]
 */
function enrichStock(stock, indicators = {}, historyRows = [], intradayData = {}) {

  const { total: ai_score, dbVolRatio, breakdown: score_breakdown } =
    calculateAiScore(stock, historyRows, intradayData);  // ← v6: pass intradayData

  const tradePlan      = getTradePlan({ ...stock, ai_score });
  const recommendation = getRecommendation({ ...stock, ...indicators, ai_score });

  return {
    ...stock,

    // Formula-engine indicators
    trend_signal:    indicators['Bullish/Bearish Trend']   || null,
    buy_signal:      indicators['BUY Signal']              || null,
    momentum_rank:   indicators['Price Momentum Ranking']  || null,
    buying_pressure: indicators['Strong Buying Pressure']  || null,
    volume_spike:    indicators['Volume Spike Detection']  || null,
    liquidity:       indicators['Liquidity Detection']     || 'Low',
    fake_movement:   indicators['Fake Movement Detection'] || null,

    // AI score
    ai_score,
    score_breakdown,
    recommendation,

    // Expose DB-computed vol ratio for scoring.js composite (consistent)
    db_vol_ratio: dbVolRatio,

    // Trade plan fields
    ...tradePlan,

    // Meta
    history_loaded: historyRows.length > 0,
    history_days:   historyRows.length,

    // NEW: expose intraday flags on the stock object for display/debugging
    intraday_move_pct:     intradayData.intradayMovePct  || 0,
    vol_direction:         (intradayData.last30minVol || 0) > (intradayData.first30minVol || 0) ? 'Accelerating' : 'Fading',
    recent_day_changes:    intradayData.recentDayChanges || [],
    zero_reason:           score_breakdown.zeroReason    || null,
  };
}

module.exports = { enrichStock };
