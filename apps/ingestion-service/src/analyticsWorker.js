require('dotenv').config();

const { Worker } = require('bullmq');

const { connection, pool, socketQueue, analyticsQueue } = require('@trading/shared');
const { computeMostActive } = require('@trading/shared/src/rankings/mostActive.js');
const { loadFormulas } = require('@trading/shared/src/formula-engine/loadFormulas.js');
const { processTopPerformers } = require('@trading/shared/src/rankings/processTopPerformers.js');

const { processBatch } = require('./fib/fibProcessor');
// runLiveScan now runs in its own liveScanWorker (every minute) — not here.

/**
 * ANALYTICS WORKER — everything heavy, off the ingest critical path.
 *
 * Runs one cycle at a time (concurrency 1). If newer analytics cycles are
 * already waiting, this one self-drops so we always compute on the freshest
 * snapshot instead of grinding through a stale backlog.
 */
const worker = new Worker(
  'analytics-queue',
  async (job) => {
    if (job.name !== 'analytics') return;

    // ── Coalesce: skip if a fresher cycle is already queued behind us ─────
    const waiting = await analyticsQueue.getWaitingCount();
    if (waiting > 0) {
      console.log(`[analytics] skipping stale cycle ${job.id} (${waiting} newer waiting)`);
      return;
    }

    const stocks = job.data?.stocks || [];
    if (stocks.length === 0) return;

    try {
      // ── Fib swing detection (fire-and-forget) ──────────────────────────
      processBatch(pool, stocks).catch(err =>
        console.error('[fib] processBatch error:', err.message)
      );

      // ── Intraday rows for today ────────────────────────────────────────
      const todayLabel = `todayQuery-${job.id}`;
      console.time(todayLabel);
      const { rows: todayIntradayRows } = await pool.query(`
        SELECT symbol, last_price, volume, change_percent, created_at
        FROM public.market_stock_snapshots
        WHERE created_at >= CURRENT_DATE AT TIME ZONE 'Asia/Kuwait'
        ORDER BY created_at ASC
      `);
      console.timeEnd(todayLabel);

      // ── Recent closing rows (last 4 days) ──────────────────────────────
      const closingLabel = `closingQuery-${job.id}`;
      console.time(closingLabel);
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
      console.timeEnd(closingLabel);

      // ── Build recent closing map ───────────────────────────────────────
      const recentClosingMap = new Map();
      for (const row of closingRows) {
        const pct = parseFloat(String(row.change_percent).replace('%', '').replace('−', '-')) || 0;
        if (!recentClosingMap.has(row.symbol)) recentClosingMap.set(row.symbol, []);
        recentClosingMap.get(row.symbol).push(pct); // newest first
      }

      // ── Top performers ─────────────────────────────────────────────────
      const formulas = await loadFormulas(pool);
      const top10 = await processTopPerformers(stocks, formulas, pool, todayIntradayRows, recentClosingMap);

      await connection.set('top_performers', JSON.stringify(top10));
      await socketQueue.add('top-performers', top10, { removeOnComplete: true, removeOnFail: true });

      // ── Most active ────────────────────────────────────────────────────
      try {
        const mostActive = computeMostActive(stocks);
        await connection.set('most_active', JSON.stringify(mostActive));
        await socketQueue.add('most-active', mostActive, { removeOnComplete: true, removeOnFail: true });

        console.log(
          `[most-active] gainers:${mostActive.gainers.length}` +
          ` losers:${mostActive.losers.length}` +
          ` topValue:${mostActive.topValue.length}`
        );
      } catch (err) {
        console.error('[most-active] compute error:', err.message);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [analytics] error:`, err.message);
    }
  },
  {
    connection,
    concurrency: 1,
    lockDuration: 300000,   // heavy job — long lease so it never stalls
    maxStalledCount: 2,
  }
);

worker.on('failed', (job, err) => console.error(`[${new Date().toISOString()}] Analytics failed:`, job?.id, err.message));

module.exports = worker;