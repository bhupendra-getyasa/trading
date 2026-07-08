require('dotenv').config();

const { Worker } = require('bullmq');

const { connection, pool, socketQueue, analyticsQueue, liveQueue } = require('@trading/shared');

/**
 * INGEST WORKER — the "live" critical path ONLY.
 *
 * Responsibilities (must stay tiny & fast so records land with no delay):
 *   1. Cache latest trades in Redis
 *   2. Bulk-insert the snapshot into Postgres
 *   3. Fire socket refresh events
 *   4. Hand the freshly-inserted rows to the analytics queue and RETURN
 *
 * All heavy work (today/closing queries, 365-day history fetch, top-performers
 * scoring, most-active, fib) now lives in analyticsWorker.js so it can never
 * block ingestion or hold this job's lock (which was causing the stalls).
 */
const worker = new Worker(
  'stock-update-queue',
  async (job) => {
    if (job.name !== 'stock-update') return;

    const trades = job.data;
    if (!trades || trades.length === 0) return;

    // ── 1. Cache in Redis ───────────────────────────────────────────────
    await connection.set('latest_trades', JSON.stringify(trades));

    // ── 2. Bulk-insert into Postgres ────────────────────────────────────
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

    const insertLabel = `insert-${job.id}`;
    console.time(insertLabel);
    const { rows: stocks } = await pool.query(query, values);
    console.timeEnd(insertLabel);
    console.log(`Inserted ${trades.length} trades into DB`);

    // ── 3. Trigger socket events (cheap) ────────────────────────────────
    await socketQueue.add('watchlist', {}, { removeOnComplete: true, removeOnFail: true });
    await socketQueue.add('fib-signals', {}, { removeOnComplete: true, removeOnFail: true });

    // ── 4a. Live radar — fires EVERY minute (no coalescing / dedupe) ─────
    //     Its own queue so a slow/backed-up analytics cycle never skips it.
    await liveQueue.add('live-scan', {}, { removeOnComplete: true, removeOnFail: { count: 100 } });

    // ── 4b. Offload ALL heavy analytics — do NOT await the processing ────
    //     A fixed jobId per minute coalesces bursts; the analytics worker
    //     also self-drops stale cycles so it never falls behind.
    const cycleId = `analytics-${createdAt.slice(0, 16).replace(/[:.]/g, '-')}`; // minute-granular, no ':'
    await analyticsQueue.add(
      'analytics',
      { stocks },
      {
        jobId: cycleId,
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      }
    );

  },
  {
    connection,
    concurrency: 1,      // one ingest at a time — no label collisions, no double insert
    lockDuration: 60000,
    maxStalledCount: 2,
  }
);

worker.on('completed', (job) => console.log(`[${new Date().toISOString()}] Ingest completed:`, job.id));
worker.on('failed', (job, err) => console.error(`[${new Date().toISOString()}] Ingest failed:`, job?.id, err.message));

module.exports = worker;