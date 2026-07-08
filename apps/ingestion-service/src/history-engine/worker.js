'use strict';
/*
 * BullMQ worker — runs history scoring as a queued job, matching your
 * ingestion-service worker pattern. Enqueue a job on the "history-scoring"
 * queue (e.g. from a scheduler after the daily ingestion completes) and this
 * processes it.
 *
 * Integration points (adjust to your shared packages if names differ):
 *   - Redis connection: tries packages/shared redis, else REDIS_URL env.
 *   - DB pool: reused from index.js resolver (shared pool or env).
 *
 * Enqueue example (from another service):
 *   const { Queue } = require('bullmq');
 *   const q = new Queue('history-scoring', { connection });
 *   await q.add('run', {});                       // score "today"
 *   await q.add('run', { runDate: '2026-06-29' }); // score a specific run_date
 */

const { Worker } = require('bullmq');
const { runHistoryScoring } = require('./runHistoryScoring');
const { pool, connection } = require('@trading/shared');

const QUEUE_NAME = process.env.HISTORY_QUEUE || 'history-scoring';


function startWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const runDate = job.data && job.data.runDate;
      return runHistoryScoring(pool, { runDate });
    },
    { connection, concurrency: 1 }, // scoring is a single cross-sectional pass
  );

  worker.on('completed', (job, res) => {
    console.log(`[history-worker] job ${job.id} done: scored ${res.scored} symbols (run_date=${res.runDate})`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[history-worker] job ${job?.id} failed:`, err.message);
  });

  console.log(`[history-worker] listening on queue "${QUEUE_NAME}"`);
  return worker;
}

startWorker();

module.exports = { startWorker, QUEUE_NAME };