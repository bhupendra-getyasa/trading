const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const COOKIES_PATH = path.resolve(__dirname, 'tradingview-cookies.json');
const SYMBOLS_PATH = path.resolve(__dirname, 'symbols2.json');
const PROGRESS_PATH = path.resolve(__dirname, 'scrape-progress.json');
const FAILED_PATH   = path.resolve(__dirname, 'failed-symbols.json');

// ─── DATABASE CONFIG ──────────────────────────────────────────────────────────
const pool = new Pool({
    host: 'trading-db.cip64s8oy79k.us-east-1.rds.amazonaws.com',
    port: 5432,
    user: 'postgres',
    password: 'QwerPoiu12',
    database: 'trading',
    ssl: {
        rejectUnauthorized: false
    }
});

// ─── DATE RANGE (inclusive) ───────────────────────────────────────────────────
const START_DATE = new Date(2026, 1, 1);   // 01 February 2026
const END_DATE   = new Date(2026, 5, 30);  // 30 June 2026

const MAX_RETRIES    = 5;
const RETRY_DELAY_MS = 8000;
const MAX_SCROLLS    = 2000;

// ─── PROGRESS TRACKER ────────────────────────────────────────────────────────
function loadProgress() {
    try {
        if (fs.existsSync(PROGRESS_PATH))
            return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
    } catch { }
    return { completed: [], failed: [] };
}

function saveProgress(progress) {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function parseRowDate(dateText) {
    if (!dateText) return null;
    const clean = dateText.replace(/[\u202A\u202C\u00A0]/g, ' ').trim();
    const m = clean.match(/(\d{1,2})\s+([A-Za-z]{3})\s+'(\d{2})/);
    if (m) {
        const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
        return new Date(2000 + parseInt(m[3]), months[m[2]] ?? 0, parseInt(m[1]));
    }
    return null;
}

function tsToDate(ts) { return new Date(ts * 1000); }

function isInRange(d) {
    if (!d) return false;
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return day >= START_DATE && day <= END_DATE;
}

function isBeforeRange(d) {
    if (!d) return false;
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return day < START_DATE;
}

function parseNumeric(val, allowNegative = false) {
    if (val === null || val === undefined) return null;

    const s = String(val)
        .trim()
        .replace(/\u2212/g, '-')   // ← Unicode minus sign → ASCII hyphen-minus
        .replace(/\u00A0/g, ' ')   // ← non-breaking space → regular space
        .replace(/,/g, '');        // ← remove thousand separators

    if (s === '' || s === '—' || s === 'N/A') return null;

    const n = parseFloat(s);
    if (isNaN(n)) return null;

    // Stock prices are never negative — TradingView shows U+2212 on inverted charts
    return (!allowNegative && n < 0) ? Math.abs(n) : n;
}

// ─── Database helpers ─────────────────────────────────────────────────────────
async function getExistingCount(symbol) {
    const res = await pool.query(
        `SELECT COUNT(*) FROM public.stock_prices
         WHERE symbol = $1
           AND created_at >= $2
           AND created_at <  $3`,
        [symbol, START_DATE, new Date(END_DATE.getTime() + 86400000)]
    );
    return parseInt(res.rows[0].count, 10);
}

async function deleteSymbolData(symbol) {
    await pool.query(
        `DELETE FROM public.stock_prices
         WHERE symbol = $1
           AND created_at >= $2
           AND created_at <  $3`,
        [symbol, START_DATE, new Date(END_DATE.getTime() + 86400000)]
    );
}

async function insertBatch(symbol, rows, headers) {
    if (!rows.length) return 0;

    const hLower = headers.map(h => h.toLowerCase().trim());

    function valIdx(predicate) {
        const hi = hLower.findIndex(predicate);
        return hi <= 0 ? -1 : hi - 1;
    }

    const colOpen   = valIdx(h => h === 'open');
    const colHigh   = valIdx(h => h === 'high');
    const colLow    = valIdx(h => h === 'low');
    const colClose  = valIdx(h => h === 'close');
    const colChange = valIdx(h => h.includes('change') || h.includes('%'));
    const colVolume = valIdx(h => h === 'volume' || h === 'vol');

    console.log(`    Headers     : [${headers.join(' | ')}]`);
    console.log(`    Column map  : open=${colOpen} high=${colHigh} low=${colLow} close=${colClose} change=${colChange} volume=${colVolume}`);

    // ── Show first 3 raw rows to verify values are being read correctly ────────
    console.log('    First 3 raw rows:', rows);
    rows.slice(0, 3).forEach((row, i) => {
        console.log(`      row[${i}] ts=${row.ts} values=[${row.values.join(' | ')}]`);
        console.log(`        → open="${row.values[colOpen]}" high="${row.values[colHigh]}" low="${row.values[colLow]}" close="${row.values[colClose]}"`);
        console.log(`        → parsed: open=${parseNumeric(row.values[colOpen])} high=${parseNumeric(row.values[colHigh])} low=${parseNumeric(row.values[colLow])} close=${parseNumeric(row.values[colClose])}`);
    });

    if (colOpen < 0 || colHigh < 0 || colLow < 0 || colClose < 0) {
        throw new Error(`Could not map OHLC columns. Headers were: [${headers.join(', ')}]`);
    }

    const client = await pool.connect();
    let totalInserted = 0;

    try {
        await client.query('BEGIN');

        const CHUNK = 500;
        for (let i = 0; i < rows.length; i += CHUNK) {
            const chunk = rows.slice(i, i + CHUNK);
            const placeholders = [];
            const values = [];
            let p = 1;
            let skipped = 0;

            for (const row of chunk) {
                const v = row.values;

                const open   = parseNumeric(colOpen   >= 0 ? v[colOpen]   : null);
                const high   = parseNumeric(colHigh   >= 0 ? v[colHigh]   : null);
                const low    = parseNumeric(colLow    >= 0 ? v[colLow]    : null);
                const close  = parseNumeric(colClose  >= 0 ? v[colClose]  : null);
                const change = colChange >= 0 ? (v[colChange] || '') : '';
                const volume = colVolume >= 0 ? (v[colVolume] || '') : '';

                if (open === null || high === null || low === null || close === null) {
                    skipped++;
                    // Log first few skipped rows to help diagnose
                    if (skipped <= 3) {
                        console.log(`    SKIPPED row ts=${row.ts}: open="${v[colOpen]}" high="${v[colHigh]}" low="${v[colLow]}" close="${v[colClose]}"`);
                    }
                    continue;
                }

                const createdAt = tsToDate(row.ts);
                placeholders.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7})`);
                values.push(symbol, open, high, low, close, change, volume, createdAt);
                p += 8;
            }

            if (skipped > 0) console.log(`    Skipped ${skipped} rows with null OHLC in chunk`);
            if (!placeholders.length) continue;

            const res = await client.query(
                `INSERT INTO public.stock_prices
                     (symbol, open, high, low, close, change, volume, created_at)
                 VALUES ${placeholders.join(',')}
                 ON CONFLICT DO NOTHING`,
                values
            );
            totalInserted += res.rowCount;
        }

        await client.query('COMMIT');
        return totalInserted;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ─── Page helpers ─────────────────────────────────────────────────────────────
async function dismissModals(page) {
    const texts = ['Decline offer','Decline','No thanks','Skip','Close','Maybe later','Not now'];
    for (const text of texts) {
        try {
            const btn = page.getByRole('button', { name: new RegExp(text,'i') });
            if (await btn.count() > 0) {
                await btn.first().click({ timeout: 3000 });
                await page.waitForTimeout(800);
                return;
            }
        } catch { }
    }
    try {
        const hasModal = await page.evaluate(() => {
            const els = document.querySelectorAll('[class*="modal"],[class*="dialog"],[class*="overlay"]');
            return Array.from(els).some(e => {
                const s = window.getComputedStyle(e);
                return s.display !== 'none' && s.visibility !== 'hidden';
            });
        });
        if (hasModal) { await page.keyboard.press('Escape'); await page.waitForTimeout(600); }
    } catch { }
}

async function collapseRightPanel(page) {
    try {
        await page.evaluate(() => {
            const rightBar = document.querySelector('[class*="rightToolbar"],[class*="right-toolbar"],[id*="right-toolbar"]');
            if (rightBar) {
                const btn = rightBar.querySelector('[aria-pressed="true"],[class*="active"],button.active');
                if (btn) { btn.click(); return; }
            }
            const btn = document.querySelector(
                '[data-name="right-toolbar"] button[aria-pressed="true"],' +
                '[class*="widgetbar"] button[aria-pressed="true"],' +
                'button[data-name="toggle-visibility-button"]'
            );
            if (btn) btn.click();
        });
        await page.waitForTimeout(800);
    } catch { }
}

async function openTableView(page) {
    await dismissModals(page);

    const chartSelectors = ['canvas[data-name="d"]','.chart-container canvas','[class*="pane"] canvas','canvas'];
    let chartEl = null;
    for (const sel of chartSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: 8000 });
            chartEl = await page.$(sel);
            if (chartEl) break;
        } catch { }
    }
    if (!chartEl) throw new Error('Chart canvas not found');

    await page.waitForTimeout(2000);
    const box  = await chartEl.boundingBox();
    const x = box.x + box.width  / 2;
    const y = box.y + box.height / 2;

    for (let attempt = 1; attempt <= 4; attempt++) {
        await page.mouse.click(x, y, { button: 'right' });
        await page.waitForTimeout(1500);

        const menuItems = await page.evaluate(() => {
            const sels = ['[class*="menu"] [class*="item"]','[class*="contextMenu"] li',
                          '[role="menuitem"]','[class*="menuItem"]','[class*="menu-item"]'];
            const found = [];
            for (const sel of sels)
                document.querySelectorAll(sel).forEach(el => {
                    const t = el.textContent?.replace(/\s+/g,' ').trim();
                    if (t) found.push(t);
                });
            return [...new Set(found)];
        });

        const tableLabel = menuItems.find(t => t.toLowerCase().includes('table'));
        if (tableLabel) {
            const clicked = await page.evaluate((label) => {
                const sels = ['[class*="menu"] [class*="item"]','[class*="contextMenu"] li',
                              '[role="menuitem"]','[class*="menuItem"]','[class*="menu-item"]'];
                for (const sel of sels)
                    for (const el of document.querySelectorAll(sel))
                        if (el.textContent?.replace(/\s+/g,' ').trim() === label) { el.click(); return true; }
                return false;
            }, tableLabel);
            if (!clicked) await page.locator('text=' + tableLabel).first().click({ timeout: 5000 });
            await page.waitForTimeout(2000);
            return;
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(800);
        await dismissModals(page);
    }
    throw new Error('Could not open Table View after 4 attempts');
}

async function extractHeaders(page) {
    return page.evaluate(() => {
        const thead = document.querySelector('table[aria-label="Table view"] thead');
        if (!thead) return ['Date','Open','High','Low','Close','Change','Volume'];

        const rows = thead.querySelectorAll('tr');

        // Log raw HTML for debugging
        console.log('[extractHeaders] thead rows count:', rows.length);
        Array.from(rows).forEach((r, i) => {
            console.log(`[extractHeaders] row[${i}]:`, r.innerText);
        });

        // TradingView uses 2-row thead:
        //   Row 0: "Date·1m" | "KSE-AAYAN · BSE D" (colspan=5) | "Vol" (colspan=1)
        //   Row 1: (empty)   | Open | High | Low | Close | Change | Volume
        if (rows.length >= 2) {
            const sub = Array.from(rows[1].querySelectorAll('th'))
                .map(th => th.textContent.replace(/\s+/g, ' ').trim())
                .filter(t => t.length > 0);
            if (sub.length >= 3) {
                console.log('[extractHeaders] Using sub-headers:', sub);
                return ['Date', ...sub];
            }
        }

        // Fallback: single row, skip group headers (colspan > 1) and date
        if (rows.length >= 1) {
            const allTh = Array.from(rows[0].querySelectorAll('th'));
            const headers = ['Date'];
            for (const th of allTh) {
                const text = th.textContent.replace(/\s+/g, ' ').trim();
                if (!text || text.toLowerCase().includes('date') || text.includes('·')) continue;
                if (parseInt(th.getAttribute('colspan') || '1', 10) > 1) continue;
                headers.push(text);
            }
            if (headers.length > 1) return headers;
        }

        return ['Date','Open','High','Low','Close','Change','Volume'];
    });
}

async function extractRows(page) {
    return page.evaluate(() => {
        const rows = document.querySelectorAll('table[aria-label="Table view"] tbody tr[data-row-time]');
        return Array.from(rows).map(row => {
            const ts = parseInt(row.getAttribute('data-row-time') || '0', 10);
            const cells = Array.from(row.querySelectorAll('td'));
            if (!cells.length) return null;

            const dateText = cells[0].textContent
                .replace(/[\u202A\u202C]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const values = cells.slice(1).map(td => {
                // Prefer data-copy-value BUT fall back to textContent
                // data-copy-value is often missing for negative numbers on TradingView
                const copyVal = (td.getAttribute('data-copy-value') || '').trim();
                const textVal = (td.textContent || '').replace(/[\u202A\u202C\u00A0]/g, '').trim();
                return copyVal !== '' ? copyVal : textVal;
            });

            return { ts, dateText, values };
        }).filter(Boolean);
    });
}

async function scrollTableBy(page, px) {
    await page.evaluate((px) => {
        const table = document.querySelector('table[aria-label="Table view"]');
        if (!table) return;
        let el = table.parentElement;
        while (el && el !== document.body) {
            if (el.scrollHeight > el.clientHeight + 10) { el.scrollTop += px; return; }
            el = el.parentElement;
        }
        window.scrollBy(0, px);
    }, px);
}

async function getScrollInfo(page) {
    return page.evaluate(() => {
        const table = document.querySelector('table[aria-label="Table view"]');
        if (!table) return { scrollTop:0, scrollHeight:0, clientHeight:0 };
        let el = table.parentElement;
        while (el && el !== document.body) {
            if (el.scrollHeight > el.clientHeight + 10)
                return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
            el = el.parentElement;
        }
        return { scrollTop: window.scrollY, scrollHeight: document.body.scrollHeight, clientHeight: window.innerHeight };
    });
}

// ─── Scrape a single symbol (one attempt) ────────────────────────────────────
async function scrapeSymbolOnce(ctx, symbolEntry, log) {
    const { symbol, url } = symbolEntry;
    const page = await ctx.newPage();
    await page.route('**/*.{woff,woff2,ttf,mp4,mp3}', r => r.abort());
    await page.route('**/ads/**', r => r.abort());

    try {
        log('Navigating to chart...');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (page.url().includes('/signin')) throw new Error('Session expired — re-run save-cookies.js');
        await page.waitForTimeout(6000);

        await collapseRightPanel(page);
        await openTableView(page);

        await page.waitForSelector('table[aria-label="Table view"]', { timeout: 20000 });
        log('Table view open');

        const headers = await extractHeaders(page);
        log('Headers: ' + headers.join(', '));

        // ── Scroll & collect ──────────────────────────────────────────────────
        const allRows    = new Map();
        let passedStart  = false;
        let scrollTries  = 0;
        let lastCount    = 0;
        let noNewRows    = 0;
        let lastLogCount = 0;

        while (!passedStart && scrollTries < MAX_SCROLLS) {
            const rows = await extractRows(page);

            for (const row of rows) {
                // Use date text first; fall back to unix timestamp
                let d = parseRowDate(row.dateText);
                if (!d) d = tsToDate(row.ts);

                if (isInRange(d))    allRows.set(row.ts, row);
                if (isBeforeRange(d)) { passedStart = true; break; }
            }

            // Progress log every 500 new rows
            if (allRows.size - lastLogCount >= 500) {
                log(`  ... ${allRows.size} rows collected so far`);
                lastLogCount = allRows.size;
            }

            if (allRows.size === lastCount) {
                noNewRows++;
                if (noNewRows >= 8) {
                    // Check if truly at the bottom
                    const info = await getScrollInfo(page);
                    if (info.scrollTop + info.clientHeight >= info.scrollHeight - 20) {
                        log('Reached bottom of table');
                        break;
                    }
                    // Jump-scroll to dislodge virtual list
                    await scrollTableBy(page, 3000);
                    noNewRows = 0;
                } else {
                    await scrollTableBy(page, 300);
                }
            } else {
                noNewRows = 0;
                await scrollTableBy(page, 600);
            }

            lastCount = allRows.size;
            await page.waitForTimeout(350);
            scrollTries++;
        }

        if (scrollTries >= MAX_SCROLLS) {
            log(`WARNING: Hit MAX_SCROLLS (${MAX_SCROLLS}) — some rows may be missing`);
        }

        const sorted = Array.from(allRows.values()).sort((a, b) => a.ts - b.ts);
        log(`Scroll complete. Total rows in range: ${sorted.length}`);
        return { headers, rows: sorted };

    } finally {
        await page.close().catch(() => {});
    }
}

// ─── Process one symbol with retries + DB save ────────────────────────────────
async function processSymbol(ctx, symbolEntry, symbolIndex, totalSymbols, progress) {
    const { symbol } = symbolEntry;
    const tag = `[${symbolIndex}/${totalSymbols}] [${symbol}]`;
    const log = (msg) => console.log(`${tag} ${msg}`);

    // ── Check if already done ─────────────────────────────────────────────────
    if (progress.completed.includes(symbol)) {
        log('Already completed — skipping');
        return 'skipped';
    }

    // ── If previously failed, clear any partial data ──────────────────────────
    const existingRows = await getExistingCount(symbol);
    if (existingRows > 0) {
        log(`Found ${existingRows} existing rows — clearing before re-scrape to ensure completeness`);
        await deleteSymbolData(symbol);
    }

    // ── Retry loop ────────────────────────────────────────────────────────────
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        log(`Attempt ${attempt}/${MAX_RETRIES}`);

        try {
            const { headers, rows } = await scrapeSymbolOnce(ctx, symbolEntry, log);

            if (rows.length === 0) {
                log('WARNING: 0 rows scraped — may be a low-volume symbol or no data in range');
                // Don't retry for 0 rows — mark as completed so we don't loop forever
            }

            // ── Save to DB ────────────────────────────────────────────────────
            log(`Saving ${rows.length} rows to database...`);
            const inserted = await insertBatch(symbol, rows, headers);
            log(`✓ Saved ${inserted} rows to DB`);

            // ── Mark complete ─────────────────────────────────────────────────
            progress.completed.push(symbol);
            // Remove from failed list if it was there before
            progress.failed = progress.failed.filter(f => f.symbol !== symbol);
            saveProgress(progress);

            return 'success';

        } catch (err) {
            lastError = err;
            log(`Attempt ${attempt} FAILED: ${err.message}`);

            if (attempt < MAX_RETRIES) {
                const wait = RETRY_DELAY_MS * attempt; // back-off: 8s, 16s, 24s...
                log(`Waiting ${wait / 1000}s before retry...`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }

    // ── All retries exhausted ─────────────────────────────────────────────────
    log(`✗ FAILED after ${MAX_RETRIES} attempts: ${lastError?.message}`);

    // Update progress file
    const existing = progress.failed.find(f => f.symbol === symbol);
    if (existing) {
        existing.error   = lastError?.message;
        existing.lastTry = new Date().toISOString();
        existing.tries   = (existing.tries || 0) + MAX_RETRIES;
    } else {
        progress.failed.push({
            symbol,
            error:   lastError?.message,
            lastTry: new Date().toISOString(),
            tries:   MAX_RETRIES,
        });
    }
    saveProgress(progress);
    return 'failed';
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    // ── Validate inputs ───────────────────────────────────────────────────────
    if (!fs.existsSync(COOKIES_PATH)) throw new Error('Missing: ' + COOKIES_PATH);
    if (!fs.existsSync(SYMBOLS_PATH)) throw new Error('Missing: ' + SYMBOLS_PATH);

    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    const symbols = JSON.parse(fs.readFileSync(SYMBOLS_PATH, 'utf-8'));
    const progress = loadProgress();

    const remaining = symbols.filter(s => !progress.completed.includes(s.symbol));

    console.log('═'.repeat(55));
    console.log('  KSE Stock Scraper — Sequential Mode');
    console.log('═'.repeat(55));
    console.log(`  Total symbols    : ${symbols.length}`);
    console.log(`  Already done     : ${progress.completed.length}`);
    console.log(`  To scrape now    : ${remaining.length}`);
    console.log(`  Date range       : ${START_DATE.toDateString()} → ${END_DATE.toDateString()}`);
    console.log(`  Retries/symbol   : ${MAX_RETRIES}`);
    console.log('═'.repeat(55) + '\n');

    if (remaining.length === 0) {
        console.log('All symbols already completed! Delete scrape-progress.json to re-run from scratch.');
        await pool.end();
        return;
    }

    // ── Test DB ───────────────────────────────────────────────────────────────
    try {
        await pool.query('SELECT 1');
        console.log('✓ Database connected\n');
    } catch (err) {
        throw new Error('Database connection failed: ' + err.message);
    }

    // ── Single shared browser context (one set of cookies, one session) ───────
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    });
    const ctx = await browser.newContext({
        viewport:  { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    await ctx.addCookies(cookies);

    // ── Sequential scrape ─────────────────────────────────────────────────────
    const stats    = { success: 0, skipped: 0, failed: 0 };
    const startTime = Date.now();

    for (let i = 0; i < remaining.length; i++) {
        const symbolEntry  = remaining[i];
        const globalIndex  = progress.completed.length + i + 1;

        console.log('\n' + '─'.repeat(55));
        const result = await processSymbol(ctx, symbolEntry, globalIndex, symbols.length, progress);
        stats[result === 'success' ? 'success' : result === 'skipped' ? 'skipped' : 'failed']++;

        // Brief pause between symbols to avoid hammering TradingView
        if (i < remaining.length - 1) {
            console.log(`[${symbolEntry.symbol}] Pausing 3s before next symbol...`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    // ── Shutdown ──────────────────────────────────────────────────────────────
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    await pool.end().catch(() => {});

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

    console.log('\n' + '═'.repeat(55));
    console.log('  SCRAPE COMPLETE');
    console.log('═'.repeat(55));
    console.log(`  Time elapsed     : ${elapsed} minutes`);
    console.log(`  ✓ Succeeded      : ${stats.success}`);
    console.log(`  ↷ Skipped        : ${stats.skipped}`);
    console.log(`  ✗ Failed         : ${stats.failed}`);
    console.log(`  Progress saved   : ${PROGRESS_PATH}`);

    if (progress.failed.length > 0) {
        fs.writeFileSync(FAILED_PATH, JSON.stringify(progress.failed, null, 2));
        console.log(`\n  Failed symbols saved to: ${FAILED_PATH}`);
        console.log('  Re-run the script to retry them (progress is preserved).');
        console.log('\n  Failed list:');
        progress.failed.forEach(f => console.log(`    - ${f.symbol}: ${f.error}`));
    }
    console.log('═'.repeat(55));
}

module.exports = {
    main
}

// main().catch(err => {
//     console.error('\nFATAL ERROR:', err.message);
//     process.exit(1);
// });