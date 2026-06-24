// apps/ingestion-service/src/worker.js

require('dotenv').config();

const { Worker } = require('bullmq');

const { connection, pool, socketQueue } = require('@trading/shared');
const { loadFormulas } = require('@trading/shared/src/formula-engine/loadFormulas.js');
const { processTopPerformers } = require('@trading/shared/src/rankings/processTopPerformers.js');

const { scrapeStocks } = require('./scraper');
const { publishStock } = require('./publisher');
const { processBatch } = require('./fib/fibProcessor'); 
const { computeMostActive } = require('@trading/shared/src/rankings/mostActive.js');

let count = 0;
let stockts = [];


const worker = new Worker(
  'stock-queue',
  async (job) => {

    // ─────────────────────────────────────────────────────────────────────
    // JOB: scrape-job  (fired by cron every minute)
    // ─────────────────────────────────────────────────────────────────────
    if (job.name === 'scrape-job') {
      console.log(`[${new Date().toISOString()}] Scraping started`);
      // const result = await pool.query(`
      //   WITH scrape_times AS (
      //     SELECT DISTINCT created_at
      //     FROM public.market_stock_snapshots
      //     WHERE created_at >= date_trunc('day', NOW()) + INTERVAL '7 hour 50 minute'
      //       AND created_at <  date_trunc('day', NOW()) + INTERVAL '10 hour'
      //     ORDER BY created_at
      //     OFFSET $1 LIMIT 1
      //   )
      //   SELECT *
      //   FROM public.market_stock_snapshots
      //   WHERE created_at = (SELECT created_at FROM scrape_times)
      //   ORDER BY symbol;
      // `, [count])

      // stocks = result.rows
      // count++;
      // console.log('stocks: ', stocks.length, count)

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
        INSERT INTO market_stock_snapshots
        (symbol, company_name, stock_url, last_price, change_percent,
          change, volume, avg_volume, market_cap, created_at)
        VALUES ${placeholders}
        ON CONFLICT (id) DO NOTHING
        RETURNING *;
      `;

      try {
        const { rows: stocks } = await pool.query(query, values);
        console.log(`Inserted ${trades.length} trades into DB`);
        await socketQueue.add('watchlist', {}, {
          removeOnComplete: true,
          removeOnFail: true
        });
        await socketQueue.add('fib-signals', {}, {
          removeOnComplete: true,
          removeOnFail: true
        });

        const { rows: todayIntradayRows } = await pool.query(`
          SELECT symbol, last_price, volume, change_percent, created_at
          FROM public.market_stock_snapshots
          WHERE created_at >= CURRENT_DATE AT TIME ZONE 'Asia/Kuwait'
          ORDER BY created_at ASC
        `);

        const { rows: closingRows } = await pool.query(`
          SELECT symbol, change_percent, DATE(created_at AT TIME ZONE 'Asia/Kuwait') AS trade_date
          FROM (
            SELECT symbol, change_percent, created_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY symbol, DATE(created_at AT TIME ZONE 'Asia/Kuwait')
                    ORDER BY created_at DESC
                  ) AS rn
            FROM public.market_stock_snapshots
            WHERE created_at >= NOW() - INTERVAL '4 days'
          ) ranked
          WHERE rn = 1
          ORDER BY symbol, trade_date DESC
        `);

        // Now build the Map
        const recentClosingMap = new Map();
        for (const row of closingRows) {
          const pct = parseFloat(String(row.change_percent).replace('%','').replace('−','-')) || 0;
          if (!recentClosingMap.has(row.symbol)) recentClosingMap.set(row.symbol, []);
          recentClosingMap.get(row.symbol).push(pct); // pushes newest first: [today, yesterday, dayBefore]
        }

        // ── 3. Top performers (existing logic — unchanged) ─────────────
        const formulas = await loadFormulas(pool);
        const top10 = await processTopPerformers(stocks, formulas, pool, todayIntradayRows, recentClosingMap);

        await connection.set('top_performers', JSON.stringify(top10));
        await socketQueue.add('top-performers', top10, {
          removeOnComplete: true,
          removeOnFail: true
        });

        // ── 4. NEW: Fibonacci swing detection & signal generation ───────
        // stocks[] are DB rows (snake_case) — fibProcessor handles both formats
        // Run in background — don't await so it doesn't delay the main job
        processBatch(pool, stocks).catch(err => {
          console.error('[fib] processBatch error:', err.message);
        });

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