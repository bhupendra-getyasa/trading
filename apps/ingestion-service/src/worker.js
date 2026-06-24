// apps/ingestion-service/src/worker.js

require('dotenv').config();

const { Worker } = require('bullmq');

const { connection, pool, socketQueue } = require('@trading/shared');
const { loadFormulas }         = require('@trading/shared/src/formula-engine/loadFormulas.js');
const { processTopPerformers } = require('@trading/shared/src/rankings/processTopPerformers.js');

const { publishStock }      = require('./publisher');
const { processBatch }      = require('./fib/fibProcessor');
const { computeMostActive } = require('@trading/shared/src/rankings/mostActive.js');

let count = 0;

const worker = new Worker(
  'stock-queue',
  async (job) => {

    // ─────────────────────────────────────────────────────────────────────
    // JOB: scrape-job  (fired by cron every minute)
    // Reads the latest snapshot batch from DB and enqueues stock-update.
    // ─────────────────────────────────────────────────────────────────────
    if (job.name === 'scrape-job') {
      console.log(`[scrape-job] Starting batch ${count}`);

      // ── BUG FIX: removed hard 6am-10am time window filter.
      // The old query returned 0 rows outside market hours, killing the pipeline.
      // Now we take the Nth distinct snapshot time from today, falling back to
      // the absolute latest snapshot if nothing exists for today yet.
      const result = await pool.query(`
        WITH today_times AS (
          SELECT DISTINCT created_at
          FROM public.market_stock_snapshots
          WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kuwait') AT TIME ZONE 'Asia/Kuwait'
          ORDER BY created_at
          OFFSET $1 LIMIT 1
        ),
        fallback AS (
          SELECT MAX(created_at) AS created_at
          FROM public.market_stock_snapshots
        ),
        target_time AS (
          SELECT created_at FROM today_times
          UNION ALL
          SELECT created_at FROM fallback
          WHERE NOT EXISTS (SELECT 1 FROM today_times)
          LIMIT 1
        )
        SELECT s.*
        FROM public.market_stock_snapshots s
        JOIN target_time t ON s.created_at = t.created_at
        ORDER BY s.symbol;
      `, [count]);

      const stocks = result.rows;
      count++;

      console.log(`[scrape-job] Fetched ${stocks.length} stocks (batch ${count})`);

      if (stocks.length === 0) {
        console.warn('[scrape-job] No stocks found — skipping publish');
        return;
      }

      // ── BUG FIX: pass stocks as job.data so stock-update job is self-contained.
      // The old code relied on a module-level 'stocks' variable shared between
      // two different job handlers — unreliable across restarts or concurrency.
      await publishStock(stocks);
      console.log(`[scrape-job] Published ${stocks.length} stocks`);

    // ─────────────────────────────────────────────────────────────────────
    // JOB: stock-update  (published by publisher.js after each scrape)
    // ─────────────────────────────────────────────────────────────────────
    } else if (job.name === 'stock-update') {

      // ── BUG FIX: use job.data directly — never rely on module-level variable.
      // publisher.js sends the stocks array as job.data. Use it here.
      const stocks = job.data;

      if (!stocks || stocks.length === 0) {
        console.warn('[stock-update] Empty job.data — nothing to process');
        return;
      }

      console.log(`[stock-update] Processing ${stocks.length} stocks`);

      // ── 1. Cache raw trades in Redis ──────────────────────────────────
      await connection.set('latest_trades', JSON.stringify(stocks));

      // ── 2. Notify websocket service ───────────────────────────────────
      await socketQueue.add('watchlist', {}, { removeOnComplete: true, removeOnFail: true });
      await socketQueue.add('fib-signals', {}, { removeOnComplete: true, removeOnFail: true });

      // ── 3. Compute & broadcast Most Active (gainers / losers / value) ─
      // Runs synchronously from raw stocks — no scoring needed, very fast.
      try {
        const mostActive = computeMostActive(stocks);
        await connection.set('most_active', JSON.stringify(mostActive));
        await socketQueue.add('most-active', mostActive, {
          removeOnComplete: true,
          removeOnFail:     true,
        });
        console.log(
          `[stock-update] Most active: ` +
          `${mostActive.gainers.length} gainers, ` +
          `${mostActive.losers.length} losers, ` +
          `${mostActive.topValue.length} top value`
        );
      } catch (err) {
        console.error('[stock-update] Most-active error:', err.message);
      }

      // ── 4. Run 7-layer scoring pipeline ──────────────────────────────
      try {
        const formulas = await loadFormulas(pool);
        const top10    = await processTopPerformers(stocks, formulas, pool);

        console.log(`[stock-update] Scored ${top10.length} top performers`);

        // Save to Redis so socket.js fallback and new connections get it
        await connection.set('top_performers', JSON.stringify(top10));

        // Broadcast to all connected clients
        await socketQueue.add('top-performers', top10, {
          removeOnComplete: true,
          removeOnFail: true,
        });

      } catch (err) {
        console.error('[stock-update] Scoring error:', err.message, err.stack);
      }
    }
  },
  {
    connection,
    concurrency: 1,
  }
);

worker.on('completed', (job) => console.log(`[worker] Job completed: ${job.name} (${job.id})`));
worker.on('failed',    (job, err) => console.error(`[worker] Job failed: ${job?.name} (${job?.id})`, err.message));

module.exports = worker;
