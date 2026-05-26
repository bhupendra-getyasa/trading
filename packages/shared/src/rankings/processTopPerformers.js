const { normalizeStock } = require("../normalization/normalizeStock.js");

const { calculateAiScore } = require("./calculateAiScore.js");

const { calculateIndicators } = require("../formula-engine/calculateIndicators.js");

const { enrichStock } = require("./enrichStock.js");

const { passesHardFilters } = require("./passesHardFilters.js");

const { calculateCompositeScore } = require("./scoring.js");

const { pool } = require("../db/postgres.js")

const { loadFormulas } = require("../formula-engine/loadFormulas.js");

async function processTopPerformers(
  rawStocks,
  formulas
) {

  const results = [];

  for (const raw of rawStocks) {

    // --------------------------------
    // Normalize
    // --------------------------------

    const normalized =
      normalizeStock(raw);

    // --------------------------------
    // AI Score
    // --------------------------------

    // const aiScore =
    //   calculateAiScore(
    //     normalized
    //   );

    // normalized.ai_score = aiScore;

    // --------------------------------
    // Calculate indicators
    // --------------------------------

    const indicators =
      await calculateIndicators(
        normalized,
        formulas
      );

    // --------------------------------
    // Merge indicators
    // --------------------------------

    const stock =
    enrichStock(
      normalized,
      indicators
    );

    // --------------------------------
    // Apply filters
    // --------------------------------

    // if (
    //   !passesHardFilters(
    //     stock
    //   )
    // ) {
    //   continue;
    // }

    // --------------------------------
    // Calculate ranking score
    // --------------------------------

    const ranking =
      calculateCompositeScore(
        stock
      );

    results.push({
      ...stock,
      ...ranking,
    });
  }

  // --------------------------------
  // SORT DESC
  // --------------------------------

  results.sort(
    (a, b) =>
      b.compositeScore -
      a.compositeScore
  );

  // --------------------------------
  // TOP 10
  // --------------------------------

  return results
    // .slice(0, 10)
    .map((stock, index) => ({
      rankNo: index + 1,
      ...stock,
    }));
}

// async function topStock () {
//   const { rows: stocks } =
//     await pool.query(`
//       SELECT *
//       FROM (
//         SELECT DISTINCT ON (symbol) *
//         FROM public.market_stock_snapshots
//         ORDER BY symbol, created_at DESC
//       ) t
//       ORDER BY created_at DESC;
//   `);

//   const formulas =
//   await loadFormulas(pool);
  
//   const top10 =
//   await processTopPerformers(
//     stocks,
//     formulas
//   );
//   console.log('top10: ', top10);
// }

// topStock();

module.exports = {
  processTopPerformers
}