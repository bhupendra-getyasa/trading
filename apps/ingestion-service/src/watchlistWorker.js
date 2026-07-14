/**
 * watchlistWorker.js
 * Processes 'watchlist' jobs. Because the awsat terminal is a single logged-in,
 * headed browser held in-process, this worker MUST run with concurrency 1 — one
 * scrape at a time, reusing the same login across every minute's job.
 *
 * Runs in the same process as index.js, so watchlistScraper's persistent browser
 * survives between jobs (login happens once, on the first job).
 */

const { Worker } = require('bullmq');
const { connection, pool } = require('@trading/shared');
const { scrapeStocks, saveQuotes } = require('./watchlistScraper');

const worker = new Worker(
  'watchlist',
  async () => {
    const t0 = Date.now();
    const records = await scrapeStocks();          // logs in once, reused after
    const { inserted } = await saveQuotes(pool, records);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[${new Date().toISOString()}] watchlist: ${records.length} scraped, ${inserted} inserted (${secs}s)`);
    return { count: records.length, inserted };
  },
  {
    connection,
    concurrency: 1,          // never run two scrapes against the one browser
    lockDuration: 120000,    // a scan (2 markets + scroll) can exceed the 30s default
  }
);

worker.on('failed', (job, err) => {
  console.error(`[${new Date().toISOString()}] watchlist job ${job?.id} failed: ${err.message}`);
  // The next job's ensureReady() re-logs in if the session dropped.
});

module.exports = worker;