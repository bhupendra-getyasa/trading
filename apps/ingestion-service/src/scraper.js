const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const WATCHLIST_URL = 'https://www.tradingview.com/watchlists/330160510/';
const COOKIES_PATH = path.resolve(__dirname, 'tradingview-cookies.json');

let browser;
let context;
let cachedCookies = null;

// ─── Cookie loader with in-memory cache ──────────────────────────────────────
async function getCookies() {
    if (cachedCookies) return cachedCookies;

    if (!fs.existsSync(COOKIES_PATH)) {
        throw new Error(`Cookie file not found at ${COOKIES_PATH}. Run save-cookies.js first.`);
    }

    cachedCookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    console.log('✅ Cookies loaded from disk');
    return cachedCookies;
}

// ─── Reset stale/crashed browser state ───────────────────────────────────────
async function resetBrowser() {
    try {
        if (browser) await browser.close();
    } catch (_) { /* already dead, ignore */ }
    browser = undefined;
    context = undefined;
}

// ─── Launch a fresh browser for every scrape run ─────────────────────────────
async function createBrowser() {
    await resetBrowser();

    const cookies = await getCookies();

    browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-dev-shm-usage',        // ← critical: avoids /dev/shm OOM in containers
            '--disable-setuid-sandbox',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-extensions',
            '--js-flags=--max-old-space-size=256',  // ← cap V8 heap
        ]
    });

    context = await browser.newContext({
        viewport: { width: 1280, height: 800 },   // smaller = less memory
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    await context.addCookies(cookies);
    console.log('✅ Browser initialized with cached cookies');
}

// ─── Validate session on a fresh page, then close it ─────────────────────────
async function isSessionValid() {
    let page;
    try {
        page = await context.newPage();
        await page.goto('https://www.tradingview.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        const loggedIn = await page.evaluate(() =>
            !!document.querySelector('[data-name="header-user-menu-button"]') ||
            !!document.querySelector('[class*="userMenuButton"]') ||
            !!document.querySelector('[class*="header-user-menu"]')
        );

        return loggedIn;
    } catch {
        return false;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

// ─── Main scrape — fresh browser + fresh page every run ──────────────────────
async function scrapeStocks() {
    await createBrowser();

    const valid = await isSessionValid();

    if (!valid) {
        cachedCookies = null;  // ← clear cache so fresh cookies load after redeploy
        await resetBrowser();
        throw new Error(
            'Session is invalid or cookies have expired.\n' +
            'Run save-cookies.js locally to refresh tradingview-cookies.json and redeploy.'
        );
    }

    console.log('✅ Session valid');

    let page;
    try {
        page = await context.newPage();

        // Block heavy resources to reduce memory and CPU usage
        await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4,mp3}', r => r.abort());
        await page.route('**/ads/**', r => r.abort());

        console.log('Navigating to watchlist...');
        await page.goto(WATCHLIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        const currentUrl = page.url();
        console.log('Current URL:', currentUrl);

        if (currentUrl.includes('/signin') || currentUrl.includes('/accounts')) {
            cachedCookies = null;  // ← stale cookies, clear cache
            throw new Error('Redirected to login — cookies likely expired. Re-run save-cookies.js.');
        }

        try {
            await page.waitForSelector('[data-qa-id="column-symbol"]', { timeout: 30000 });
        } catch {
            throw new Error('Watchlist did not load — selector not found within 30s.');
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
                if (stock.symbol) allStocks.set(stock.symbol, stock);
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

    } finally {
        // ✅ Always clean up page and browser — even on error
        if (page) await page.close().catch(() => {});
        await resetBrowser();
    }
}

// ─── Explicit shutdown (call on SIGTERM / process exit) ───────────────────────
async function closeBrowser() {
    await resetBrowser();
}

module.exports = { scrapeStocks, closeBrowser };