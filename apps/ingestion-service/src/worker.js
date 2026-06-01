// apps/ingestion-service/src/worker.js
// ─── MODIFIED: calls fibProcessor.processBatch() after each DB insert ────────

require('dotenv').config();

const { Worker } = require('bullmq');

const { connection, pool, socketQueue } = require('@trading/shared');
const { loadFormulas } = require('@trading/shared/src/formula-engine/loadFormulas.js');
const { processTopPerformers } = require('@trading/shared/src/rankings/processTopPerformers.js');

const { scrapeStocks } = require('./scraper');
const { publishStock } = require('./publisher');
const { processBatch } = require('./fib/fibProcessor');    // ← NEW


const worker = new Worker(
  'stock-queue',
  async (job) => {

    // ─────────────────────────────────────────────────────────────────────
    // JOB: scrape-job  (fired by cron every minute)
    // ─────────────────────────────────────────────────────────────────────
    if (job.name === 'scrape-job') {
      console.log(`[${new Date().toISOString()}] Scraping started`);
      const stocks = await scrapeStocks();
      await publishStock(stocks);
      console.log(`[${new Date().toISOString()}] Scraping finished — ${stocks.length} stocks`);

      // ─────────────────────────────────────────────────────────────────────
      // JOB: stock-update  (published by publisher.js after each scrape)
      // ─────────────────────────────────────────────────────────────────────
    } else if (job.name === 'stock-update') {
      const trades = job.data;

      if (!trades || trades.length === 0) return;

      // ── 1. Cache in Redis ─────────────────────────────────────────────
      await connection.set('latest_trades', JSON.stringify(trades));
      console.log('Updated Redis with latest trades');

      // ── 2. Bulk-insert into Postgres ──────────────────────────────────
      const values = [];
      const createdAt = new Date().toISOString();

      const placeholders = trades.map((trade, i) => {
        const idx = i * 10;
        values.push(
          trade.symbol,
          trade.companyName,
          trade.stockUrl,
          trade.lastPrice,
          trade.changePercent,
          trade.change,
          trade.volume,
          trade.avgVolume,
          trade.marketCap,
          createdAt
        );

        return `(
          $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5},
          $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10}
        )`;
      }).join(',');

      const query = `
        INSERT INTO trades
        (symbol, company_name, stock_url, last_price, change_percent,
          change, volume, avg_volume, market_cap, created_at)
        VALUES ${placeholders}
        ON CONFLICT (id) DO NOTHING
        RETURNING *;
      `;

      try {
        const { rows: stocks } = await pool.query(query, values);
        console.log(`Inserted ${trades.length} trades into DB`);

        // ── 3. Top performers (existing logic — unchanged) ─────────────
        const formulas = await loadFormulas(pool);
        const top10 = await processTopPerformers(stocks, formulas);

        await connection.set('top_performers', JSON.stringify(top10));
        await socketQueue.add('top-performers', top10);

        // ── 4. NEW: Fibonacci swing detection & signal generation ───────
        // stocks[] are DB rows (snake_case) — fibProcessor handles both formats
        // Run in background — don't await so it doesn't delay the main job
        // processBatch(pool, stocks).catch(err => {
        //   console.error('[fib] processBatch error:', err.message);
        // });

      } catch (err) {
        console.error('Error inserting trades:', err);
      }
    }
  },
  {
    connection,
    concurrency: 1,
  }
);

worker.on('completed', (job) => console.log('Job completed:', job.id));
worker.on('failed', (job, err) => console.error('Job failed:', job.id, err));

module.exports = worker;