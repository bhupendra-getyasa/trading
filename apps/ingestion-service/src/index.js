const cron = require('node-cron');
const { connection, stockQueue } = require('@trading/shared');
const { main } = require('./scrape-table-data')
require('./worker');

async function start() {
  console.log('✅ Ingestion service started');

  // ─── Every minute: queue a scrape job ──────────────────────────────────────
  cron.schedule(
    '*/1 9-12 * * 0-4',
    // '* * * * *',
    async () => {
      try {
        const activeJobs = await stockQueue.getActiveCount();

        if (activeJobs > 0) {
          console.log(`[${new Date().toISOString()}] Previous scrape still running — skipping`);
          return;
        }

        console.log(`[${new Date().toISOString()}] Scheduling scrape job`);

        await stockQueue.add(
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

  // ─── Daily at 5:30 PM: scrape data ─────────────────────────────────────────
  cron.schedule(
    '30 17 * * *',
    async () => {
      try {
        console.log(`[${new Date().toISOString()}] Data scrapping...`);
        await main()
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