const cron = require('node-cron');
const { pool, connection, scrapeQueue, watchlistQueue } = require('@trading/shared');
const { main, saveProgress } = require('./history/history-scrapper');
const { runClassificationStep } = require('@trading/shared/src/live-engine/history/classificationStep');
const { generateHistoryScore } = require('./history-engine');
const { runTransform } = require('./history/transform');
const { closeScraper } = require('./watchlistScraper');

require('./scrapeWorker');
require('./stockUpdateWorker');
require('./analyticsWorker');
require('./liveScanWorker');
require('./watchlistWorker');

async function start() {
  console.log('✅ Ingestion service started');

  // ─── Every minute: queue a scrape job ──────────────────────────────────────
  cron.schedule(
    '*/1 9-12 * * 0-4',
    // '* * * * *',
    async () => {
      try {
        const activeJobs = await scrapeQueue.getActiveCount();

        if (activeJobs > 0) {
          console.log(`[${new Date().toISOString()}] Previous scrape still running — skipping`);
          return;
        }

        console.log(`[${new Date().toISOString()}] Scheduling scrape job`);

        await scrapeQueue.add(
          'scrape-job',
          {},
          {
            removeOnComplete: true,
            removeOnFail: true,
          }
        );
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to schedule scrape job:`, err.message);
      }
    },
    { timezone: 'Asia/Kuwait' }
  );

  // ─── Every minute (Sun–Thu, 09:00–12:59 Kuwait): queue a watchlist scrape ────
  cron.schedule(
    '*/1 9-12 * * 0-4',
    // '* * * * *',
    async () => {
      try {
        // Overrun guard: never queue on top of a scan that's still running/waiting.
        const [active, waiting] = await Promise.all([
          watchlistQueue.getActiveCount(),
          watchlistQueue.getWaitingCount(),
        ]);
        if (active > 0 || waiting > 0) {
          console.log(`[${new Date().toISOString()}] Watchlist scrape still pending (active=${active}, waiting=${waiting}) — skipping`);
          return;
        }
 
        await watchlistQueue.add(
          'watchlist-job',
          {},
          {
            removeOnComplete: true,
            removeOnFail: true,
            attempts: 1
          }
        );
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to schedule watchlist scrape:`, err.message);
      }
    },
    { timezone: 'Asia/Kuwait' }
  );

  cron.schedule(
    '0-10 13 * * 0-4',
    // '* * * * *',
    async () => {
      try {
        // Overrun guard: never queue on top of a scan that's still running/waiting.
        const [active, waiting] = await Promise.all([
          watchlistQueue.getActiveCount(),
          watchlistQueue.getWaitingCount(),
        ]);
        if (active > 0 || waiting > 0) {
          console.log(`[${new Date().toISOString()}] Watchlist scrape still pending (active=${active}, waiting=${waiting}) — skipping`);
          return;
        }
 
        await watchlistQueue.add(
          'watchlist-job',
          {},
          {
            removeOnComplete: true,
            removeOnFail: true,
            attempts: 1
          }
        );
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to schedule watchlist scrape:`, err.message);
      }
    },
    { timezone: 'Asia/Kuwait' }
  );

  cron.schedule(
    '15 13 * * 0-4',
    async () => {
      try {
        await closeScraper();
        console.log('closed browser');
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to schedule watchlist scrape:`, err.message);
      }
    },
    { timezone: 'Asia/Kuwait' }
  );

  // ─── Daily at 8:30 PM: history score ─────────────────────────────────────────
  cron.schedule(
    '30 08 * * 0-4',
    // '40 17 * * 0-4',
    async () => {
      try {
        console.log(`[${new Date().toISOString()}] Generating history score...`);
        // await generateHistoryScore();
        await runClassificationStep(pool);  
        console.log(`[${new Date().toISOString()}] Generated history score`);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] History score failed:`, err.message);
      }
    },
    { timezone: 'Asia/Kuwait' }
  );

  // ─── Daily at 02:00 PM: scrape data ─────────────────────────────────────────
  cron.schedule(
    '00 14 * * 0-4',
    async () => {
      try {
        console.log(`[${new Date().toISOString()}] Data scrapping...`);
        await saveProgress({ completed: [], failed: [] })
        await main();
        console.log(`[${new Date().toISOString()}] Data scrapped`);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Data scrap failed:`, err.message);
      }
    },
    { timezone: 'Asia/Kuwait' }
  );

  // ─── Daily at 05:00 PM: create data ─────────────────────────────────────────
  cron.schedule(
    '00 17 * * 0-4',
    async () => {
      try {
        console.log(`[${new Date().toISOString()}] Data scrapping...`);

        const date = new Date().toISOString().split("T")[0];

        const opts = {
          dateFrom: date,
          dateTo:   date
        };

        await runTransform(opts);
        console.log(`[${new Date().toISOString()}] Data scrapped`);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Data scrap failed:`, err.message);
      }
    },
    { timezone: 'Asia/Kuwait' }
  );

  // ─── Daily at 2:00 AM: flush Redis ─────────────────────────────────────────
  cron.schedule(
    '0 2 * * *',
    async () => {
      try {
        console.log(`[${new Date().toISOString()}] Clearing Redis...`);
        await connection.flushall();
        console.log(`[${new Date().toISOString()}] Redis cleared`);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Redis cleanup failed:`, err.message);
      }
    },
    { timezone: 'Asia/Kuwait' }
  );
}

// ─── Graceful shutdown: close the persistent browser ─────────────────────────
async function shutdown(sig) {
  console.log(`\n${sig} — shutting down...`);
  try { await closeScraper(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();