// ─────────────────────────────────────────────────────────────────────────────
//  saveRankings.js
//
//  Persists the ranked stock list into the top_performers table.
//
//  v6 changes:
//  - Stores new intraday fields: intraday_move_pct, vol_direction, zero_reason.
//  - These are stored in metadata JSON (no schema change needed).
// ─────────────────────────────────────────────────────────────────────────────

async function saveTopPerformers(pool, stocks) {
  if (!stocks || !stocks.length) return;

  const values = [];
  const params = [];
  let index = 1;

  for (const stock of stocks) {
    values.push(`(
      $${index++}, $${index++}, $${index++}, $${index++}, $${index++},
      $${index++}, $${index++}, $${index++}, $${index++}, $${index++},
      $${index++}, $${index++}, $${index++}, $${index++}
    )`);

    params.push(
      stock.scraped_at,
      stock.rankNo,
      stock.ticker,
      stock.company_name,
      stock.price,
      stock.percent_change,
      stock.volume,
      stock.avg_volume,
      stock.volumeRatio,
      stock.ai_score,
      stock.liquidity,
      stock.market_cap,
      stock.compositeScore,
      JSON.stringify({
        ...stock,
        // trade plan
        entry:             stock.entry,
        target1:           stock.target1,
        target2:           stock.target2,
        stop_loss:         stock.stop_loss,
        probability_3pct:  stock.probability_3pct,
        recommendation:    stock.recommendation,
        // NEW: intraday signals
        intraday_move_pct:  stock.intraday_move_pct,
        vol_direction:      stock.vol_direction,
        recent_day_changes: stock.recent_day_changes,
        zero_reason:        stock.zero_reason,
      })
    );
  }

  await pool.query(`
    INSERT INTO top_performers (
      snapshot_time,
      rank_no,
      ticker,
      company_name,
      price,
      percent_change,
      volume,
      avg_volume,
      volume_ratio,
      ai_score,
      liquidity,
      market_cap,
      composite_score,
      metadata
    )
    VALUES ${values.join(',')}
  `, params);
}

module.exports = { saveTopPerformers };
