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

  // FIX — was 500. The board's scroll viewport (clientHeight) is 426px, so a
  // 500px wheel step jumped PAST the bottom of the visible window and left a
  // ~74px band (~3 rows) that was never rendered at any point in the scan.
  // Premier (scrollHeight 1014, max scrollTop 588) produced 1 such gap ->
  // NIND was lost. Main (scrollHeight 2626, max scrollTop 2200) produced 4 ->
  // ACICO, ABAR, INJAZZAT and SOKOUK were lost. Because both the step size and
  // the board height are fixed, the SAME rows fell in the blind bands on every
  // run, which is why exactly those five went missing every time.
  //
  // 250 < 426 leaves 176px (~6.8 rows) of overlap on every step, so no row can
  // fall between two consecutive windows. Keep this value BELOW the viewport
  // height; if the terminal layout ever changes, re-check clientHeight first.
  wheelDelta: 250,

  maxStalls: 6,
  hardScrollCap: 200,
  dataWaitMs: 20000,
  loginTimeoutMs: 90000,

  // Only symbols present in market_stock_snapshots are written to stock_quotes.
  // Set to false to persist everything the board returns (previous behaviour).
  restrictToSnapshotSymbols: true,
  snapshotSymbolTtlMs: 10 * 60 * 1000,   // re-read the reference list every 10 min
  minSnapshotSymbols: 50,                // sanity floor before trusting a query

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

/**
 * Click the first VISIBLE element whose text is `label`.
 *
 * Why this exists: the board renders each market name MORE THAN ONCE — the dropdown
 * toggle, plus hidden Sector-Overview labels like "Main Market Index (PR)". A bare
 * getByText(label).first() happily resolves to one of those hidden spans, and click()
 * then spins ("element is not visible") until it times out. So we
 *   (a) try an exact match first,
 *   (b) drop anything containing "Index" (those are the ticker/overview labels), and
 *   (c) REQUIRE visibility before clicking, walking every match instead of blindly
 *       taking .first().
 * Returns true only if something was actually clicked.
 */
async function clickVisibleText(page, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const candidates = [
      page.getByText(label, { exact: true }).filter({ visible: true }),
      page.getByText(label, { exact: false }).filter({ visible: true, hasNotText: /index/i }),
    ];
    for (const loc of candidates) {
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        try {
          await el.click({ timeout: 1500 });
          return true;
        } catch { /* obscured or detached — try the next match */ }
      }
    }
    await page.waitForTimeout(150);
  }
  return false;
}

/** Diagnostic: what the page actually offers for `label`, and whether it's visible. */
async function textCandidates(page, label) {
  return page.evaluate((lbl) => {
    const out = [];
    for (const e of document.querySelectorAll('*')) {
      const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t.includes(lbl) || e.children.length > 2) continue;
      const r = e.getBoundingClientRect();
      out.push({
        tag: e.tagName.toLowerCase(),
        id: e.id || '',
        cls: (e.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 3).join('.'),
        text: t.slice(0, 40),
        visible: r.width > 0 && r.height > 0,
      });
      if (out.length >= 8) break;
    }
    return out;
  }, label).catch(() => []);
}

async function selectMarket(page, currentLabel, target, log) {
  // STEP 1 — open the dropdown. Its toggle shows the CURRENT market's label.
  let opened;
  if (CONFIG.marketDropdownToggle) {
    opened = await page.click(CONFIG.marketDropdownToggle, { timeout: 6000 }).then(() => true).catch(() => false);
  } else {
    opened = await clickVisibleText(page, currentLabel, 6000);
  }
  if (!opened) {
    // Name the step that ACTUALLY failed. The old message always blamed `target`, even when
    // the toggle click was what timed out — which is why "could not select Premier Market"
    // showed a log full of 'Main Market'.
    log(`  could not OPEN the market dropdown (toggle "${currentLabel}") — skipping "${target}" this cycle.`);
    log(`    candidates for "${currentLabel}": ${JSON.stringify(await textCandidates(page, currentLabel))}`);
    log(`    tip: pin CONFIG.marketDropdownToggle to a VISIBLE selector from the list above to end the text ambiguity.`);
    return false;
  }
  await page.waitForTimeout(800);

  // STEP 2 — click the target option.
  const picked = await clickVisibleText(page, target, 6000);
  if (!picked) {
    log(`  dropdown opened but option "${target}" was not clickable.`);
    log(`    candidates for "${target}": ${JSON.stringify(await textCandidates(page, target))}`);
    await page.keyboard.press('Escape').catch(() => {});   // don't leave the menu hanging open
    return false;
  }
  await page.waitForTimeout(2500);
  return true;
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

// ─── Reference symbol list (market_stock_snapshots) ──────────────────────────
// Used ONLY to decide what gets written to stock_quotes. The scrape itself is
// untouched — the board is still read in full, so the log still shows the true
// board counts and any drift between the two lists stays visible.

let snapshotSymbolCache = { at: 0, set: null };

/**
 * Symbols from the most recent market_stock_snapshots batch.
 *
 * Pinned to MAX(created_at) because a snapshot run writes every row with one
 * timestamp. If that batch comes back implausibly small (partial write, or a
 * schema where rows do NOT share a timestamp) we widen to a 24h DISTINCT
 * window rather than trusting it — an unguarded global MAX(created_at) is the
 * same failure shape as the C-1 bug from the refactor.
 *
 * The last good result is cached, so a transient DB hiccup cannot silently
 * empty the allow-list and cause a cycle to write nothing.
 */
async function loadSnapshotSymbols(pool, log) {
  const now = Date.now();
  if (snapshotSymbolCache.set && (now - snapshotSymbolCache.at) < CONFIG.snapshotSymbolTtlMs) {
    return snapshotSymbolCache.set;
  }

  try {
    let res = await pool.query(`
      SELECT DISTINCT UPPER(TRIM(symbol)) AS symbol
      FROM market_stock_snapshots
      WHERE created_at = (SELECT MAX(created_at) FROM market_stock_snapshots)
        AND symbol IS NOT NULL
    `);

    if (res.rows.length < CONFIG.minSnapshotSymbols) {
      log(`  snapshot list: latest batch had only ${res.rows.length} rows — widening to 24h`);
      res = await pool.query(`
        SELECT DISTINCT UPPER(TRIM(symbol)) AS symbol
        FROM market_stock_snapshots
        WHERE created_at >= NOW() - INTERVAL '24 hours'
          AND symbol IS NOT NULL
      `);
    }

    const set = new Set(res.rows.map((r) => r.symbol).filter(Boolean));
    if (!set.size) throw new Error('market_stock_snapshots returned no symbols');

    snapshotSymbolCache = { at: now, set };
    return set;
  } catch (err) {
    if (snapshotSymbolCache.set) {
      log(`  snapshot list: query failed (${err.message}) — reusing cached list of ${snapshotSymbolCache.set.size}`);
      return snapshotSymbolCache.set;
    }
    throw new Error(`Cannot read market_stock_snapshots and no cached list available: ${err.message}`);
  }
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

  // Keep only symbols that exist in market_stock_snapshots. The board carries a
  // few names the snapshot source omits (mostly zero-volume issues), and those
  // must not reach stock_quotes.
  let toInsert = records;
  let skipped = [];
  if (CONFIG.restrictToSnapshotSymbols) {
    const allowed = await loadSnapshotSymbols(pool, log);
    toInsert = [];
    for (const r of records) {
      const key = String(r.symbol || '').trim().toUpperCase();
      if (key && allowed.has(key)) toInsert.push(r);
      else skipped.push(r.symbol);
    }

    const got = new Set(toInsert.map((r) => String(r.symbol).trim().toUpperCase()));
    const notScraped = [...allowed].filter((s) => !got.has(s));

    log(`  filter: ${toInsert.length}/${records.length} symbols matched market_stock_snapshots (${allowed.size} in list)`);
    if (skipped.length) log(`  filter: skipped (not in snapshot list) -> ${skipped.join(', ')}`);
    if (notScraped.length) log(`  filter: in snapshot list but NOT scraped -> ${notScraped.join(', ')}`);

    if (!toInsert.length) return { inserted: 0, skipped: skipped.length, missing: notScraped };
  }

  const batchId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const tradingDate = kuwaitDate();
  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    const colList = DB_COLUMNS.join(', ');
    const CHUNK = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
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
  return { inserted, skipped: skipped.length };
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