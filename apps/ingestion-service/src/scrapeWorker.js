require('dotenv').config();

const { Worker } = require('bullmq');

const { pool, connection } = require('@trading/shared');

const { scrapeStocks, closeBrowser } = require('./scraper');
const { publishStock } = require('./publisher');

const SCRAPE_TIMEOUT_MS = 90000; // hard cap — a hung scrape rejects instead of stalling the job

let count = 0;
let stocks = [];

// Reject (and clean up the browser) if scrapeStocks hangs past the deadline.
function scrapeWithTimeout(ms) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await closeBrowser().catch(() => {});
      reject(new Error(`scrapeStocks timed out after ${ms}ms`));
    }, ms);

    scrapeStocks()
      .then((res) => { if (!settled) { settled = true; clearTimeout(timer); resolve(res); } })
      .catch((err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
  });
}

const worker = new Worker(
  'scrape-queue',
  async (job) => {
    if (job.name !== 'scrape-job') return;

    console.log(`[${new Date().toISOString()}] Scraping started`);

    // const result = await pool.query(`
    //   WITH scrape_times AS (
    //     SELECT DISTINCT created_at
    //     FROM public.market_stock_snapshots
    //     WHERE created_at >= date_trunc('day', NOW() - INTERVAL '1 day') + INTERVAL '6 hour'
    //       AND created_at <  date_trunc('day', NOW() - INTERVAL '1 day') + INTERVAL '10 hour'
    //     ORDER BY created_at
    //     OFFSET $1 LIMIT 1
    //   )
    //   SELECT *
    //   FROM public.market_stock_snapshots
    //   WHERE created_at = (SELECT created_at FROM scrape_times)
    //   ORDER BY symbol;
    // `, [count]);

    // stocks = result.rows.map((stock) => {
    //   return {
    //     symbol: stock.symbol,
    //     companyName: stock.company_name,
    //     stockUrl: stock.stock_url,
    //     lastPrice: stock.last_price,
    //     changePercent: stock.change_percent,
    //     change: stock.change,
    //     volume: stock.volume,
    //     avgVolume: stock.avg_volume,
    //     marketCap:stock.market_cap,
    //   }
    // })
    // count++;
    // console.log('stocks: ', stocks.length, count)

    const stocks = await scrapeWithTimeout(SCRAPE_TIMEOUT_MS);
    await publishStock(stocks);

    console.log(`[${new Date().toISOString()}] Scraping finished — ${stocks.length} stocks`);
  },
  {
    connection,
    concurrency: 1,
    lockDuration: 120000,  // scrape can legitimately run > default 30s
    maxStalledCount: 2,
  }
);

worker.on('completed', (job) => console.log(`[${new Date().toISOString()}] Scrape completed:`, job.id));
worker.on('failed', (job, err) => console.error(`[${new Date().toISOString()}] Scrape failed:`, job?.id, err.message));

module.exports = worker;
