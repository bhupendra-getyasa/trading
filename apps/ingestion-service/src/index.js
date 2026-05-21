const cron = require('node-cron');
const { stockQueue } = require('@trading/shared');
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

    cron.schedule(
      //   '*/1 * * * *',
      '*/1 9-13 * * 0-4',
      async () => {
        console.log(`[${new Date().toISOString()}] Scheduling scrape job`);
        await stockQueue.add('scrape-job', {});
      },
      { timezone: 'Asia/Kuwait' }
    );
}

start();