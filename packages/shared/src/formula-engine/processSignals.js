
const { loadFormulas } = require("./loadFormulas.js");
const { evaluateFormula } = require("./evaluateFormula.js");
const { pool } = require("../db/postgres.js");

async function processSignals(pool) {
  // Load formulas
  const formulas = await loadFormulas(pool);

  // Get latest Kuwait stock data
  const { rows: stocks } = await pool.query(`
    SELECT *
    FROM market_stock_snapshots
    WHERE created_at = (
      SELECT MAX(created_at)
      FROM market_stock_snapshots
    )
  `);

  const inserts = [];

  for (const stock of stocks) {
    for (const formula of formulas) {
      const matched = evaluateFormula(
        formula,
        formula.conditions,
        stock
      );

      if (!matched) continue;

      inserts.push([
        stock.id,
        formula.indicator_id,
        formula.signal_output,
        JSON.stringify({
          ticker: stock.ticker,
          company_name: stock.company_name,
        }),
      ]);
    }
  }

  // Bulk insert
  const values = [];
  const params = [];

  let index = 1;

  for (const row of inserts) {
    values.push(
      `($${index++}, $${index++}, $${index++}, $${index++})`
    );

    params.push(...row);
  }

  if (values.length) {
    await pool.query(`
      INSERT INTO market_indicator_results
      (
        snapshot_id,
        indicator_id,
        signal_output,
        metadata
      )
      VALUES ${values.join(",")}
    `, params);
  }

  console.log("Signals calculated successfully");
}

module.exports = {
  processSignals
};

// processSignals(pool).then((res) => console.log(res)).catch((err) => console.log(err));