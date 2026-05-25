const { chromium } = require('playwright');

const WATCHLIST_URL =
    'https://www.tradingview.com/watchlists/330160510/';

let browser;
let page;

async function initBrowser() {
    browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-sync',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-first-run',
            '--disable-default-apps',
        ],
    });

    const context = await browser.newContext();

    page = await context.newPage();

    await page.goto(WATCHLIST_URL, {
        waitUntil: 'domcontentloaded',
    });
}

// async function scrapeStocks() {
//     await page.waitForSelector('[data-qa-id="column-symbol"]');

//     return await page.evaluate(() => {
//         const rows = document.querySelectorAll('[data-qa-id="column-symbol"]');

//         return Array.from(rows).map((row) => {
//             const parent = row.parentElement;

//             const getText = (id) => {
//                 const cell = parent?.querySelector(`[data-qa-id="${id}"]`);
//                 return (
//                     cell?.textContent
//                         ?.replace(/\u202A|\u202C/g, '')
//                         .replace(/\s+/g, ' ')
//                         .trim() || ''
//                 );
//             };

//             const symbol = row.querySelector('a span')?.textContent?.trim() || '';
//             const spans = row.querySelectorAll('span');
//             const companyName = spans[spans.length - 1]?.textContent?.trim() || '';
//             const stockUrl = row.querySelector('a')?.getAttribute('href') || '';

//             return {
//                 symbol,
//                 companyName,
//                 stockUrl: stockUrl ? `https://www.tradingview.com${stockUrl}` : '',
//                 lastPrice: getText('column-last_price'),
//                 changePercent: getText('column-change_percent'),
//                 change: getText('column-change'),
//                 volume: getText('column-volume'),
//                 avgVolume: getText('column-average_volume'),
//                 marketCap: getText('column-market_cap_basic'),
//                 createdAt: new Date().toISOString(),
//             };
//         });
//     });
// }

async function scrapeStocks() {
    await page.waitForSelector('[data-qa-id="column-symbol"]');

    const allStocks = new Map();

    let previousCount = 0;

    while (true) {
        // Extract currently rendered rows
        const stocks = await page.evaluate(() => {
            const rows = document.querySelectorAll(
                '[data-qa-id="column-symbol"]'
            );

            return Array.from(rows).map((row) => {
                const parent = row.parentElement;

                const getText = (id) => {
                    const cell = parent?.querySelector(
                        `[data-qa-id="${id}"]`
                    );

                    return (
                        cell?.textContent
                            ?.replace(/\u202A|\u202C/g, '')
                            .replace(/\s+/g, ' ')
                            .trim() || ''
                    );
                };

                const symbol =
                    row.querySelector('a span')?.textContent?.trim() || '';

                const spans = row.querySelectorAll('span');

                const companyName =
                    spans[spans.length - 1]?.textContent?.trim() || '';

                const stockUrl =
                    row.querySelector('a')?.getAttribute('href') || '';

                return {
                    symbol,
                    companyName,
                    stockUrl: stockUrl
                        ? `https://www.tradingview.com${stockUrl}`
                        : '',
                    lastPrice: getText('column-last_price'),
                    changePercent: getText('column-change_percent'),
                    change: getText('column-change'),
                    volume: getText('column-volume'),
                    avgVolume: getText('column-average_volume'),
                    marketCap: getText('column-market_cap_basic'),
                    createdAt: new Date().toISOString(),
                };
            });
        });

        // Store unique stocks
        for (const stock of stocks) {
            allStocks.set(stock.symbol, stock);
        }

        // Stop if no new rows appear
        if (allStocks.size === previousCount) {
            break;
        }

        previousCount = allStocks.size;

        // Scroll down
        await page.evaluate(() => {
            window.scrollBy(0, window.innerHeight * 2);
        });

        // Wait for lazy-loaded rows
        await page.waitForTimeout(1000);
    }

    return Array.from(allStocks.values());
}

module.exports = {
    initBrowser,
    scrapeStocks,
};