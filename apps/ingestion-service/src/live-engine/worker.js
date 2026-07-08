'use strict';
/*
 * worker.js — standalone runner. Runs the live scanner once per minute during the
 * Kuwait trading session. Use this to run the engine on its own.
 *
 * In the monorepo you do NOT need this file — instead call runLiveScan(pool) from
 * your existing per-minute 'stock-update' job right after the snapshot insert
 * (see INTEGRATION.md). This worker is just a self-contained equivalent.
 *
 *   npm install
 *   cp .env.example .env   # fill in DB details
 *   npm run worker
 */
require('dotenv').config();
const { pool } = require('@trading/shared');
// const { createPool } = require('./db');
const { runLiveScan } = require('./index');
const CONFIG = require('./config');

// const pool = createPool();
const TZ = CONFIG.SESSION.tzOffsetHours;

function inSession(now = new Date()) {
  const k = new Date(now.getTime() + TZ * 3600 * 1000);   // Kuwait time
  const day = k.getUTCDay();                              // 0 Sun ... 6 Sat
  const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
  const open = CONFIG.SESSION.openHour * 60;
  const close = CONFIG.SESSION.closeHour * 60;
  const tradingDay = day >= 0 && day <= 4;                // Sun–Thu
  return tradingDay && mins >= open && mins <= close;
}

async function tick() {
  if (!inSession()) return;
  try {
    const res = await runLiveScan(pool);
    console.log(`[live] ${new Date().toISOString()} scanned=${res?.scanned ?? '?'} qualified=${res?.qualified?.length ?? 0}`);
  } catch (e) {
    console.error('[live] error:', e.message);
  }
}

console.log('[live] worker started — scanning every minute during the Kuwait session');
tick();
const timer = setInterval(tick, 60 * 1000);

process.on('SIGINT', async () => {
  clearInterval(timer);
  await pool.end();
  console.log('\n[live] stopped');
  process.exit(0);
});
