// save-cookies.js  — run this ONCE locally: node save-cookies.js
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
    const browser = await chromium.launch({ headless: false }); // visible browser
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('https://www.tradingview.com/accounts/signin/');

    console.log('👉 Please log in manually in the browser window...');
    console.log('👉 Waiting until you reach the TradingView homepage...');

    // Wait until you're redirected away from login page
    await page.waitForURL(url => !url.href.includes('/signin') && !url.href.includes('/accounts'), {
        timeout: 120000
    });

    console.log('✅ Logged in! Saving cookies...');

    const cookies = await context.cookies();
    fs.writeFileSync('./apps/ingestion-service/src/tradingview-cookies.json', JSON.stringify(cookies, null, 2));

    console.log(`✅ Saved ${cookies.length} cookies to tradingview-cookies.json`);

    await browser.close();
})();