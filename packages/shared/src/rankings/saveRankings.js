async function saveTopPerformers(
  pool,
  stocks
) {
  if (!stocks.length) return;

  const values = [];
  const params = [];

  let index = 1;

  for (const stock of stocks) {
    values.push(`
      (
        $${index++},
        $${index++},
        $${index++},
        $${index++},
        $${index++},
        $${index++},
        $${index++},
        $${index++},
        $${index++},
        $${index++},
        $${index++},
        $${index++},
        $${index++},
        $${index++}
      )
    `);

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
      JSON.stringify(stock)
    );
  }

  await pool.query(`
    INSERT INTO top_performers
    (
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
    VALUES ${values.join(",")}
  `, params);
}

module.exports = {
  saveTopPerformers
};
