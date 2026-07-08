'use strict';
/*
 * Entry point — runs one history-scoring pass and exits.
 *
 * Usage:
 *   node index.js                          -> all windows
 *   node index.js last_month               -> just last_month
 *   node index.js last_month current_week  -> those two
 *
 * Valid window names: all, current_month, last_month, current_week,
 *                     last_week, last_30d, last_7d, yesterday, latest_day
 */

const { runHistoryScoring } = require('./runHistoryScoring');
const { pool } = require('@trading/shared');

// window names passed as CLI args; empty => undefined => all windows
// const windows = process.argv.slice(2);

async function generateHistoryScore() {
  const windows = ['current_week']
  try {
    const summary = await runHistoryScoring(pool, {
      windows: windows.length ? windows : undefined,
    });

    // one ranked top-5 table per window that ran
    for (const w of summary.windows) {
      console.log(`\n[${w.window}] ${w.from}..${w.to}  (${w.days} trading days, ${w.scored} symbols)`);
      console.table(w.top5);
    }
    return summary;
  } catch (error) {
    console.log('error: ', error);
    throw error;
  }
}

// generateHistoryScore()
//   .then(() => process.exit(0))
//   .catch((err) => { console.error('[history] FAILED:', err); process.exit(1); });

module.exports = { generateHistoryScore };