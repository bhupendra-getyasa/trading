const cron = require('node-cron');
const { pool, connection, scrapeQueue } = require('@trading/shared');
const { main, saveProgress } = require('./history/history-scrapper');
const { runClassificationStep } = require('@trading/shared/src/live-engine/history/classificationStep');
const { generateHistoryScore } = require('./history-engine');
const { runTransform } = require('./history/transform');
require('./scrapeWorker');
require('./stockUpdateWorker');
require('./analyticsWorker');
require('./liveScanWorker');

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
    '00 14 * * *',
    async () => {
      try {
        console.log(`[${new Date().toISOString()}] Data scrapping...`);
        await saveProgress({ completed: [], failed: [] })
        await main();

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

start();