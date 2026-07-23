require('dotenv').config();

const { Worker } = require('bullmq');

const { connection, pool } = require('@trading/shared');
const { runLiveScan } = require('@trading/shared/src/live-engine');
const { publishRadarNew, publishTmiTick } = require('./publisher');

/**
 * LIVE RADAR WORKER — runs the Gate-1/Gate-2 scanner every minute.
 *
 * Dedicated queue (fed once per ingest cycle) so the radar fires on EVERY
 * minute, independent of the analytics queue's coalescing. concurrency 1
 * keeps cycles serialized; a generous lock means a slow scan won't stall.
 */
const worker = new Worker(
  'live-queue',
  async (job) => {
    if (job.name !== 'live-scan') return;

    const label = `liveScan-${job.id}`;
    console.time(label);
    try {
      const summary = await runLiveScan(pool);
      // emit ONLY the stocks that newly qualified this cycle -> live pop-up, no page refresh
      if (summary?.qualified?.length) {
        await publishRadarNew(summary.tradingDay, summary.qualified);
      }
      // TMI ticks every cycle, qualified or not: open positions still need managing on a
      // minute where nothing new fires. Failure here must not fail the scan.
      try { await publishTmiTick(summary?.tradingDay); }
      catch (e) { console.warn('[live] tmi tick enqueue failed:', e.message); }
    } catch (err) {
      console.error('[live] scan error:', err.message);
    } finally {
      console.timeEnd(label);
    }
  },
  {
    connection,
    concurrency: 1,
    lockDuration: 120000,
    maxStalledCount: 2,
  }
);

worker.on('failed', (job, err) => console.error(`[${new Date().toISOString()}] Live scan failed:`, job?.id, err.message));

module.exports = worker;