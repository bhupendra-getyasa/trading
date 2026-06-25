const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const WATCHLIST_URL = 'https://www.tradingview.com/watchlists/330160510/';
const COOKIES_PATH = path.resolve(__dirname, 'tradingview-cookies.json');

let browser;
let context;
let page;

async function initBrowser() {
    if (browser) return;

    if (!fs.existsSync(COOKIES_PATH)) {
        throw new Error(`Cookie file not found at ${COOKIES_PATH}. Run save-cookies.js first.`);
    }

    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));

    browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--no-sandbox',
        ]
    });

    context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    // ✅ Inject saved cookies — no login needed
    await context.addCookies(cookies);

    page = await context.newPage();
    console.log('✅ Browser initialized with saved cookies');
}

async function isSessionValid() {
    try {
        await page.goto('https://www.tradingview.com', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        const loggedIn = await page.evaluate(() => {
            return (
                !!document.querySelector('[data-name="header-user-menu-button"]') ||
                !!document.querySelector('[class*="userMenuButton"]') ||
                !!document.querySelector('[class*="header-user-menu"]')
            );
        });

        return loggedIn;
    } catch {
        return false;
    }
}

async function ensureSession() {
    await initBrowser();

    const valid = await isSessionValid();

    if (!valid) {
        await page.screenshot({ path: '/tmp/session-invalid.png', fullPage: true });
        throw new Error(
            'Session is invalid or cookies have expired.\n' +
            'Run save-cookies.js locally to refresh tradingview-cookies.json and redeploy.'
        );
    }

    console.log('✅ Session valid');
}

async function scrapeStocks() {
    await ensureSession();

    console.log('Navigating to watchlist...');
    await page.goto(WATCHLIST_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    console.log('Current URL:', currentUrl);

    if (currentUrl.includes('/signin') || currentUrl.includes('/accounts')) {
        throw new Error('Redirected to login — cookies likely expired. Re-run save-cookies.js.');
    }

    try {
        await page.waitForSelector('[data-qa-id="column-symbol"]', { timeout: 30000 });
    } catch {
        await page.screenshot({ path: '/tmp/watchlist-error.png', fullPage: true });
        throw new Error('Watchlist did not load. Screenshot saved to /tmp/watchlist-error.png');
    }

    const allStocks = new Map();
    let previousCount = 0;
    let noChangeCount = 0;

    while (true) {
        const stocks = await page.evaluate(() => {
            const rows = document.querySelectorAll('[data-qa-id="column-symbol"]');
            return Array.from(rows).map((row) => {
                const parent = row.parentElement;
                const getText = (id) => {
                    const cell = parent?.querySelector(`[data-qa-id="${id}"]`);
                    return cell?.textContent?.replace(/\u202A|\u202C/g, '').replace(/\s+/g, ' ').trim() || '';
                };
                const symbol = row.querySelector('a span')?.textContent?.trim() || '';
                const spans = row.querySelectorAll('span');
                const companyName = spans[spans.length - 1]?.textContent?.trim() || '';
                const stockUrl = row.querySelector('a')?.getAttribute('href') || '';
                return {
                    symbol,
                    companyName,
                    stockUrl: stockUrl ? `https://www.tradingview.com${stockUrl}` : '',
                    lastPrice: getText('column-last_price'),
                    changePercent: getText('column-change_percent'),
                    change: getText('column-change'),
                    volume: getText('column-volume'),
                    avgVolume: getText('column-average_volume'),
                    marketCap: getText('column-market_cap_basic'),
                };
            });
        });

        for (const stock of stocks) {
            allStocks.set(stock.symbol, stock);
        }

        if (allStocks.size === previousCount) {
            noChangeCount++;
            if (noChangeCount >= 3) break;
        } else {
            noChangeCount = 0;
        }

        previousCount = allStocks.size;
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
        await page.waitForTimeout(1200);
    }

    console.log(`✅ Scraped ${allStocks.size} stocks`);
    return Array.from(allStocks.values());
}

async function closeBrowser() {
    if (browser) {
        await browser.close();
        browser = undefined;
        context = undefined;
        page = undefined;
    }
}

module.exports = { initBrowser, scrapeStocks, closeBrowser };