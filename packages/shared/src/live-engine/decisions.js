'use strict';
/*
 * decisions.js — record the user's action on an opportunity.
 * Called by the front-end/API when the user presses BUY or SKIP (with a reason).
 * A SKIP also marks the symbol processed_today (skip does NOT come back today).
 */
const CONFIG = require('./config');
const { tradingDay } = require('./lib/util');
const { OUTCOMES } = require('./outcome');
const repo = require('./repository');

async function recordDecision(pool, { symbol, opportunityId = null, action, reasonCode = null, reasonText = null, now = Date.now() }) {
  const day = tradingDay(now, CONFIG.SESSION.tzOffsetHours);
  await pool.query(
    `INSERT INTO ${repo.TABLES.decisions} (symbol, opportunity_id, trading_day, action, reason_code, reason_text, engine_version, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now());`,
    [symbol, opportunityId, day, action, reasonCode, reasonText, CONFIG.VERSION]);
  if (action === 'BUY' || action === 'SKIP') {
    // BUY -> hand to TMI; SKIP -> burned for the day. Either way, no re-alert today.
    await repo.markProcessed(pool, { symbol, tradingDay: day, outcome: action === 'SKIP' ? OUTCOMES.SKIPPED : 'bought', now });
    if (action === 'BUY') await pool.query(`UPDATE ${repo.TABLES.opps} SET status='BOUGHT' WHERE id=$1;`, [opportunityId]);
    if (action === 'SKIP') await pool.query(`UPDATE ${repo.TABLES.opps} SET status='SKIPPED' WHERE id=$1;`, [opportunityId]);
  }
  return { symbol, action, trading_day: day };
}
module.exports = { recordDecision };
