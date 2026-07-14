/**
 * watchlistScraper.js  (long-lived / cron-friendly)
 *
 * The awsat/DirectFN terminal logs you out on refresh or tab-close, its session
 * is single-use, and its login only completes in a *headed* browser. So instead
 * of logging in every minute, we:
 *   1. launch ONE browser and log in ONCE,
 *   2. keep the board tab open for the whole trading window,
 *   3. each minute re-read the live board (it self-updates via websocket) —
 *      scrolling + switching the market dropdown, never navigating/refreshing,
 *   4. re-login only if the session actually drops.
 *
 * EC2: login needs a display. Run headed under Xvfb (see README notes), e.g.
 *   xvfb-run -a --server-args="-screen 0 1280x800x24" node runCron.js
 *
 * Env: AWSAT_USER, AWSAT_PASS, PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.
 *
 * Exports: scrapeStocks(), saveQuotes(records), closeScraper().
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  loginUrl: 'https://awsatbroker.com',
  headless: false,               // MUST be headed (use Xvfb on EC2). Auth stalls headless.
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  sel: {
    username: '#txtUsername',
    password: '#txtPassword',
    loginBtn: '#btnLogin',
    terms:    '#chkTermsAndConditions',
    errorMsg: '#loginMsg',
    langEN:   '#priLangRadio',
  },
  forceEnglish: true,

  markets: ['Premier Market', 'Main Market'],
  defaultMarket: 'Premier Market',
  marketDropdownToggle: '',      // set to an exact selector once known; '' = click by text

  bodyContainer: '.ember-table-body-container',
  leftBlock:  '.ember-table-left-table-block',
  rightBlock: '.ember-table-right-table-block',
  row:        '.ember-table-table-row',
  symbolCell: '.symbol-fore-color',

  settleMs: 500,
  wheelDelta: 500,
  maxStalls: 6,
  hardScrollCap: 200,
  dataWaitMs: 20000,
  loginTimeoutMs: 90000,

  outDir: path.resolve(__dirname, 'out'),
};

// ─── DB ──────────────────────────────────────────────────────────────────────
// The DB pool is INJECTED (use your @trading/shared pool). saveQuotes(pool, records).

const FIELD_MAP = {
  'dataObj.lDes': 'description', 'dataObj.ltp': 'last', 'dataObj.ltq': 'lastQty',
  'dataObj.chg': 'chg', 'dataObj.pctChg': 'pctChg', 'dataObj.vol': 'volume',
  'dataObj.bbp': 'bid', 'dataObj.bbq': 'bidQty', 'dataObj.bap': 'offer',
  'dataObj.baq': 'offerQty', 'dataObj.trades': 'trades', 'dataObj.ltd': 'ltDate',
  'dataObj.dltt': 'ltTime', 'dataObj.intsV': 'intrinsicValue', 'dataObj.open': 'open',
  'dataObj.high': 'high', 'dataObj.low': 'low', 'dataObj.sname': 'session', 'dataObj.nms': 'nms',
};
const NUMERIC_KEYS = new Set([
  'last', 'lastQty', 'chg', 'pctChg', 'volume', 'bid', 'bidQty', 'offer',
  'offerQty', 'trades', 'intrinsicValue', 'open', 'high', 'low', 'nms',
]);
const SIGNED_KEYS = new Set(['chg', 'pctChg']);
const DB_COLUMNS = [
  'scrape_batch_id', 'market', 'symbol', 'code', 'description',
  'last_price', 'last_qty', 'chg', 'pct_chg', 'volume',
  'bid', 'bid_qty', 'offer', 'offer_qty', 'trades',
  'last_trade_date', 'last_trade_time', 'intrinsic_value',
  'open_price', 'high_price', 'low_price', 'session', 'nms',
  'trading_date', 'created_at',
];

const TRANSIENT_MSG = /(جاري|جارٍ|authenticat|logging|loading|please\s*wait|connecting|\.\.\.\s*$)/i;

// ─── Parsing ─────────────────────────────────────────────────────────────────
function parseSymbol(raw) {
  if (!raw) return { symbol: null, code: null };
  const [s, c] = raw.split(/\s*-\s*/);
  return { symbol: (s || '').trim() || null, code: (c || '').trim() || null };
}
function parseNumeric(val, allowNegative = false) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim().replace(/\u2212/g, '-').replace(/\u00A0/g, ' ').replace(/,/g, '');
  if (s === '' || s === '—' || s === 'N/A' || s === '-') return null;
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return (!allowNegative && n < 0) ? Math.abs(n) : n;
}
function toDate(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function toTime(v) {
  if (!v) return null;
  const s = String(v).trim();
  return /^\d{1,2}:\d{2}:\d{2}$/.test(s) ? s : null;
}
function kuwaitDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuwait' }).format(new Date());
}
function normalizeRecord(rec) {
  const { symbol, code } = parseSymbol(rec._symbolRaw);
  const row = { symbol, code };
  for (const [cellId, key] of Object.entries(FIELD_MAP)) {
    let v = rec[cellId] ?? null;
    if (NUMERIC_KEYS.has(key)) v = parseNumeric(v, SIGNED_KEYS.has(key));
    row[key] = v;
  }
  return row;
}
function scoreRow(row) {
  let n = 0;
  for (const [k, v] of Object.entries(row)) {
    if (k === 'symbol' || k === 'code' || k === 'description' || k === 'market') continue;
    if (v === null || v === undefined || v === '' || v === 0 || v === '0') continue;
    n++;
  }
  return n;
}

// ─── DOM helpers (run in the board frame) ────────────────────────────────────
async function snapshot(target) {
  return target.evaluate((cfg) => {
    const bodies = [...document.querySelectorAll(cfg.bodyContainer)];
    const body = bodies.find((b) => b.querySelector(cfg.symbolCell) && b.querySelector('[cell-id]')) || bodies[0];
    if (!body) return [];
    const left = body.querySelector(cfg.leftBlock);
    const right = body.querySelector(cfg.rightBlock);
    if (!left || !right) return [];
    const symByTop = {};
    left.querySelectorAll(cfg.row).forEach((r) => {
      const el = r.querySelector(cfg.symbolCell);
      if (el) symByTop[r.style.top] = el.textContent.trim();
    });
    const out = [];
    right.querySelectorAll(cfg.row).forEach((r) => {
      const rec = { _symbolRaw: symByTop[r.style.top] || null };
      r.querySelectorAll('[cell-id]').forEach((c) => { rec[c.getAttribute('cell-id')] = c.textContent.trim(); });
      out.push(rec);
    });
    return out;
  }, CONFIG);
}
async function findTableFrame(page, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try { if (await frame.$(selector)) return frame; } catch {}
    }
    await page.waitForTimeout(400);
  }
  return null;
}
async function findBoardAcrossPages(ctx, loginPage, timeoutMs) {
  const sel = `${CONFIG.bodyContainer} ${CONFIG.symbolCell}`;
  const deadline = Date.now() + timeoutMs;
  let lastMsg = '';
  while (Date.now() < deadline) {
    for (const pg of ctx.pages()) {
      for (const frame of pg.frames()) {
        try { if (await frame.$(sel)) return { page: pg, target: frame }; } catch {}
      }
    }
    const msg = await loginPage.$eval(CONFIG.sel.errorMsg, (el) => (el.textContent || '').trim()).catch(() => '');
    if (msg) { lastMsg = msg; if (!TRANSIENT_MSG.test(msg)) return { error: msg }; }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { error: lastMsg || '' };
}
async function waitForData(target, log) {
  const deadline = Date.now() + CONFIG.dataWaitMs;
  while (Date.now() < deadline) {
    const rows = await snapshot(target);
    if (rows.length) {
      const withData = rows.filter((r) => {
        const d = (r['dataObj.ltd'] || '').trim();
        const v = parseNumeric(r['dataObj.vol']);
        return d !== '' || (v && v > 0);
      }).length;
      if (withData / rows.length >= 0.5) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log('  (data-population wait timed out)');
}

// ─── Login + navigation ──────────────────────────────────────────────────────
async function programmaticLogin(ctx, page, log) {
  const user = process.env.AWSAT_USER || '53423', pass = process.env.AWSAT_PASS || 'Qwer@Poiu12';
  if (!user || !pass) throw new Error('Set AWSAT_USER and AWSAT_PASS env vars.');

  log('Opening login page...');
  await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector(CONFIG.sel.username, { state: 'visible', timeout: 30000 });

  if (CONFIG.forceEnglish) {
    const en = await page.$(CONFIG.sel.langEN);
    if (en && !(await en.isChecked().catch(() => false))) {
      await en.check().catch(async () => { await en.click().catch(() => {}); });
      await page.waitForTimeout(1500);
      await page.waitForSelector(CONFIG.sel.username, { state: 'visible', timeout: 15000 });
    }
  }

  log('Entering credentials...');
  const u = page.locator(CONFIG.sel.username);
  await u.click(); await u.fill(''); await u.pressSequentially(user, { delay: 40 });
  const p = page.locator(CONFIG.sel.password);
  await p.click(); await p.fill(''); await p.pressSequentially(pass, { delay: 40 });

  const tc = await page.$(CONFIG.sel.terms);
  if (tc && (await tc.isVisible().catch(() => false))) await tc.check().catch(() => {});

  log('Submitting login...');
  await page.click(CONFIG.sel.loginBtn);

  const { page: bp, target, error } = await findBoardAcrossPages(ctx, page, CONFIG.loginTimeoutMs);
  if (target) { log('Login OK, board loaded.'); return { page: bp, target }; }
  if (error) throw new Error(TRANSIENT_MSG.test(error)
    ? `Board never loaded (still "${error}") — session may be held elsewhere.`
    : `Login failed: ${error}`);
  throw new Error('Logged in but board not found.');
}
/** Log the market dropdown toggle's real selector ONCE, so it can be pinned via
 *  CONFIG.marketDropdownToggle (bulletproof, no text ambiguity). */
let toggleLogged = false;
async function logMarketToggle(page, log) {
  if (toggleLogged) return;
  toggleLogged = true;
  try {
    const info = await page.evaluate((label) => {
      const els = [...document.querySelectorAll('*')].filter((e) => {
        const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
        return t === label && e.children.length <= 2;
      });
      return els.slice(0, 5).map((e) => ({
        tag: e.tagName.toLowerCase(),
        id: e.id || '',
        cls: (e.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 4).join('.'),
      }));
    }, CONFIG.defaultMarket);
    log(`Market toggle candidates for "${CONFIG.defaultMarket}": ${JSON.stringify(info)}`);
  } catch (e) {
    log(`toggle probe failed: ${e.message}`);
  }
}

async function selectMarket(page, currentLabel, target, log) {
  try {
    // Open the dropdown (its toggle shows `currentLabel`). Use an EXACT match so
    // "Main Market" doesn't accidentally hit "Main Market Index (TR)" etc. in the
    // Sector Overview panel.
    if (CONFIG.marketDropdownToggle) {
      await page.click(CONFIG.marketDropdownToggle, { timeout: 6000 });
    } else {
      const exact = page.getByText(currentLabel, { exact: true });
      if (await exact.count()) await exact.first().click({ timeout: 6000 });
      else await page.getByText(currentLabel, { exact: false }).first().click({ timeout: 6000 });
    }
    await page.waitForTimeout(800);
    // Click the target option (exact avoids partial matches).
    const opt = page.getByText(target, { exact: true });
    if (await opt.count()) await opt.first().click({ timeout: 6000 });
    else await page.getByText(target, { exact: false }).first().click({ timeout: 6000 });
    await page.waitForTimeout(2500);
    return true;
  } catch (e) {
    log(`  could not select "${target}": ${e.message}`);
    return false;
  }
}
async function scrapeFromFrame(page, target, log) {
  const bodyHandle = await target.evaluateHandle((cfg) => {
    const bodies = [...document.querySelectorAll(cfg.bodyContainer)];
    return bodies.find((b) => b.querySelector(cfg.symbolCell) && b.querySelector('[cell-id]')) || bodies[0] || null;
  }, CONFIG);
  const el = bodyHandle.asElement();
  const box = el ? await el.boundingBox().catch(() => null) : null;
  const wheelAt = box ? { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 250) } : null;

  await waitForData(target, log);

  const bySymbol = new Map();
  const ingest = (rows) => {
    let added = 0;
    for (const raw of rows) {
      const row = normalizeRecord(raw);
      if (!row.symbol) continue;
      const ex = bySymbol.get(row.symbol);
      if (!ex) { bySymbol.set(row.symbol, row); added++; }
      else if (scoreRow(row) >= scoreRow(ex)) bySymbol.set(row.symbol, row);
    }
    return added;
  };

  ingest(await snapshot(target));
  let stalls = 0;
  for (let i = 0; i < CONFIG.hardScrollCap; i++) {
    if (wheelAt) { await page.mouse.move(wheelAt.x, wheelAt.y); await page.mouse.wheel(0, CONFIG.wheelDelta); }
    await page.waitForTimeout(CONFIG.settleMs);
    const before = bySymbol.size;
    ingest(await snapshot(target));
    stalls = (bySymbol.size - before) === 0 ? stalls + 1 : 0;
    if (stalls >= CONFIG.maxStalls) break;
  }

  // Scroll back to top so the next market/minute starts clean.
  if (wheelAt) { await page.mouse.move(wheelAt.x, wheelAt.y); await page.mouse.wheel(0, -999999); }

  return [...bySymbol.values()].sort((a, b) =>
    (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }));
}

// ─── Persistent browser state ────────────────────────────────────────────────
let browser = null;
let context = null;
let boardPage = null;
let boardTarget = null;
let currentMarket = null;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function launch() {
  await hardClose();
  browser = await chromium.launch({
    headless: CONFIG.headless,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: CONFIG.userAgent,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  // Block heavy resources across all pages (keep fonts/css for layout).
  await context.route('**/*.{png,jpg,jpeg,gif,webp,svg,mp4,mp3}', (r) => r.abort()).catch(() => {});
  await context.route('**/ads/**', (r) => r.abort()).catch(() => {});
}

async function doLogin() {
  const page = context.pages()[0] || (await context.newPage());
  const { page: bp, target } = await programmaticLogin(context, page, log);
  boardPage = bp;
  boardTarget = target;
  currentMarket = CONFIG.defaultMarket;
  for (const pg of context.pages()) if (pg !== boardPage) await pg.close().catch(() => {});
  await logMarketToggle(boardPage, log);
}

/** Is the board still there (session alive)? No navigation/refresh — just a probe. */
async function sessionAlive() {
  if (!browser || !browser.isConnected() || !boardPage || boardPage.isClosed()) return false;
  const sel = `${CONFIG.bodyContainer} ${CONFIG.symbolCell}`;
  const t = await findTableFrame(boardPage, sel, 2000);
  if (t) { boardTarget = t; return true; }
  return false;
}

async function ensureReady() {
  if (!browser || !browser.isConnected()) { log('Launching browser + logging in...'); await launch(); await doLogin(); return; }
  if (!(await sessionAlive())) { log('Session lost — re-logging in...'); await doLogin(); }
}

// ─── Public API ───────────────────────────────────────────────────────────────
/** Scrape all configured markets from the live board. Keeps the browser open. */
async function scrapeStocks() {
  await ensureReady();
  const all = [];
  for (const market of CONFIG.markets) {
    if (market !== currentMarket) {
      const ok = await selectMarket(boardPage, currentMarket, market, log);
      if (!ok) continue;
      currentMarket = market;
    }
    const t = (await findTableFrame(boardPage, `${CONFIG.bodyContainer} ${CONFIG.symbolCell}`, 15000)) || boardTarget;
    const recs = await scrapeFromFrame(boardPage, t, log);
    recs.forEach((r) => { r.market = market; });
    log(`  ${market}: ${recs.length} symbols`);
    all.push(...recs);
  }
  if (!all.length) throw new Error('No records scraped from any market.');
  return all;
}

/** Persist one scan to stock_quotes (chunked, idempotent). Uses the injected pool. */
async function saveQuotes(pool, records) {
  if (!pool) throw new Error('saveQuotes(pool, records): pool is required.');
  if (!records || !records.length) return { inserted: 0 };
  const batchId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const tradingDate = kuwaitDate();
  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    const colList = DB_COLUMNS.join(', ');
    const CHUNK = 500;
    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK);
      const values = [];
      const tuples = chunk.map((r, ri) => {
        const row = [
          batchId, r.market || null, r.symbol, r.code, r.description,
          r.last, r.lastQty, r.chg, r.pctChg, r.volume,
          r.bid, r.bidQty, r.offer, r.offerQty, r.trades,
          toDate(r.ltDate), toTime(r.ltTime), r.intrinsicValue,
          r.open, r.high, r.low, r.session, r.nms,
          tradingDate, createdAt,
        ];
        const ph = row.map((_, ci) => `$${ri * DB_COLUMNS.length + ci + 1}`);
        values.push(...row);
        return `(${ph.join(', ')})`;
      });
      const sql = `INSERT INTO stock_quotes (${colList}) VALUES ${tuples.join(', ')} ` +
                  `ON CONFLICT (market, symbol, created_at) DO NOTHING`;
      const res = await client.query(sql, values);
      inserted += res.rowCount;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { inserted };
}

async function hardClose() {
  try { if (browser) await browser.close(); } catch {}
  browser = context = boardPage = boardTarget = null;
  currentMarket = null;
}
async function closeScraper() {
  await hardClose();
  // Note: the DB pool is owned by @trading/shared — do NOT end it here.
}

module.exports = { scrapeStocks, saveQuotes, closeScraper };