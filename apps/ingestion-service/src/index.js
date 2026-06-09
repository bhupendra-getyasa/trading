const cron = require('node-cron');
const { connection, stockQueue } = require('@trading/shared');
require('./worker');

const {
    initBrowser,
    scrapeStocks,
} = require('./scraper');

const {
    publishStock,
} = require('./publisher');

async function start() {
  await initBrowser();

    // cron.schedule(
    //     // '*/1 9-13 * * *',
    //      '*/1 * * * *',
    //     async () => {
    //         console.log('Scraping started');

    //         const stocks = await scrapeStocks();

    //         await publishStock(stocks);

    //         // for (const stock of stocks) {
    //         //     await publishStock(stock);
    //         // }
    //     },
    //     {
    //         timezone: 'Asia/Kuwait',
    //     }
    // );

    // cron.schedule(
    //   //   '*/1 * * * *',
    //   '*/1 9-12 * * 0-4',
    //   async () => {
    //     console.log(`[${new Date().toISOString()}] Scheduling scrape job`);
    //     await stockQueue.add('scrape-job', {});
    //   },
    //   { timezone: 'Asia/Kuwait' }
    // );

  cron.schedule(
    '*/1 9-12 * * 0-4',
    async () => {

      const activeJobs =
        await stockQueue.getActiveCount();

      if (activeJobs > 0) {
        console.log(
          'Previous scrape still running'
        );
        return;
      }

      console.log(
        `[${new Date().toISOString()}] Scheduling scrape job`
      );

      await stockQueue.add(
        'scrape-job',
        {},
        {
          removeOnComplete: true,
          removeOnFail: true,
        }
      );

    }, 
    { timezone: 'Asia/Kuwait'}
  );

  cron.schedule(
    "0 2 * * *", // 2:00 AM daily
    async () => {
      try {
        console.log("Clearing Redis...");
        await connection.flushall(); // clears all Redis databases
        console.log("Redis cleared");
      } catch (err) {
        console.error("Redis cleanup failed:", err);
      }
    },
    {
      timezone: "Asia/Kuwait",
    }
  );
}

start();