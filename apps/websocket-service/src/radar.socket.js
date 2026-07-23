'use strict';
/*
 * radar.socket.js  (apps/websocket-service/src/radar.socket.js)
 * ---------------------------------------------------------------------------
 * Socket.IO wiring for the Intraday Radar dashboard. Follows the same style as
 * the existing watchlist handlers in socket.js (subscription persisted in Redis
 * so the queue worker can re-broadcast each minute).
 *
 * Client -> server:
 *   radar:subscribe  { date }
 *   budget:set       { date, ceiling_kd }
 *   decision         { id, symbol, action, reason }     action = BUY | PAUSE | SKIP
 * Server -> client:
 *   radar:update     { date, opportunities[], rejected[], console{} }
 */
const { connection } = require('@trading/shared');
const radar = require('./services/radar.service');

const SUB_KEY = (id) => `radar_sub:${id}`;

/*
 * The subscription stores the DATE ONLY. Budget is a property of the trading day
 * (session_settings has one row per day, not per user), so caching a copy of it per
 * socket meant a budget:set on one client left every other client re-broadcasting
 * with its own stale number. getRadarSnapshot reads the budget from the DB instead —
 * one source of truth, no cache to invalidate.
 */
async function emitRadar(socket) {
  const sub = socket.data.radar;
  if (!sub || !sub.date) return;
  try {
    const snap = await radar.getRadarSnapshot(sub.date);
    socket.emit('radar:update', snap);
  } catch (err) {
    console.error('[radar] emit error:', err.message);
  }
}

/** Attach the radar handlers to a freshly connected socket. Call inside io.on('connection'). */
function registerRadarHandlers(io, socket) {
  socket.on('radar:subscribe', async ({ date } = {}) => {
    if (!date) return;
    socket.data.radar = { date };
    await connection.set(SUB_KEY(socket.id), JSON.stringify(socket.data.radar));
    await emitRadar(socket);
  });

  socket.on('budget:set', async ({ date, ceiling_kd } = {}) => {
    const d = date || socket.data.radar?.date;
    if (!d) return;
    try {
      // re-sizes every OPEN/PAUSED opportunity for the day against the new budget
      const { resized, report } = await radar.setBudget(d, ceiling_kd);
      const { matched, capped, skipped } = report;
      console.log(`[radar] budget ${d} -> ${ceiling_kd} KD | matched ${matched}, shares changed ${resized}, capped ${capped}, skipped ${skipped}`);
      if (matched === 0) {
        console.warn(`[radar] budget change matched 0 OPEN/PAUSED rows for ${d} - nothing to resize. Check the date is the Kuwait trading_day and the cards aren't all BOUGHT/SKIPPED.`);
      } else if (resized === 0) {
        // Not a bug: every open card is pinned by the volume/WILD cap, so a bigger
        // budget legitimately cannot add shares. Name the binding cap per symbol.
        console.warn(`[radar] budget change moved 0 cards - all ${matched} pinned by volume/WILD cap or skipped: ` +
          report.details.map((x) => `${x.symbol}:${x.reason}`).join(' '));
      }
    } catch (err) {
      console.error('[radar] budget:set error:', err.message);
      socket.emit('radar:error', { scope: 'budget:set', message: err.message });
      return;
    }
    socket.data.radar = { date: d };
    await connection.set(SUB_KEY(socket.id), JSON.stringify(socket.data.radar));
    await broadcastRadar(io, d);   // the budget is day-global: refresh every client on this date
  });

  socket.on('decision', async ({ id, symbol, action, reason } = {}) => {
    try {
      await radar.recordDecision({ id, symbol, action, reason, date: socket.data.radar?.date });
    } catch (err) {
      console.error('[radar] decision error:', err.message);
    }
    await emitRadar(socket);                              // reflect the status change at once
  });

  // BUY — persist the full stock data, mark BOUGHT, refresh the board (card leaves radar).
  socket.on('buy', async ({ id, symbol } = {}) => {
    try {
      const res = await radar.buyStock({ id, symbol, date: socket.data.radar?.date });
      socket.emit('radar:bought', res);                  // { action, trading_day, bought:{...} }
    } catch (err) {
      console.error('[radar] buy error:', err.message);
      socket.emit('radar:error', { scope: 'buy', message: err.message });
    }
    await emitRadar(socket);
  });

  // IGNORE — mark SKIPPED, refresh the board (card moves into snapshot.skipped).
  socket.on('ignore', async ({ id, symbol } = {}) => {
    try {
      const res = await radar.ignoreStock({ id, symbol, date: socket.data.radar?.date });
      socket.emit('radar:ignored', res);                 // { action, trading_day, symbol }
    } catch (err) {
      console.error('[radar] ignore error:', err.message);
      socket.emit('radar:error', { scope: 'ignore', message: err.message });
    }
    await emitRadar(socket);
  });

  socket.on('disconnect', async () => {
    await connection.del(SUB_KEY(socket.id));
  });
}

/**
 * Re-broadcast the radar to every subscribed socket. Called by the socket-queue
 * worker each minute after the scanner writes a fresh opportunity_list, and after a
 * budget change. Pass `onlyDate` to refresh just the sockets watching that day.
 */
async function broadcastRadar(io, onlyDate = null) {
  if (!io) return;
  const cache = new Map();   // date -> snapshot, so N sockets on one day cost one build
  for (const socket of io.sockets.sockets.values()) {
    const raw = await connection.get(SUB_KEY(socket.id));
    if (!raw) continue;
    const { date } = JSON.parse(raw);
    if (!date || (onlyDate && date !== onlyDate)) continue;
    try {
      if (!cache.has(date)) cache.set(date, await radar.getRadarSnapshot(date));
      socket.emit('radar:update', cache.get(date));
    } catch (err) {
      console.error('[radar] broadcast error:', err.message);
    }
  }
}

/**
 * Push ONLY the newly-arrived radar opportunities (by symbol) to every socket watching
 * that trading day, as a `radar:new` event: { date, new: [card...], console }. The
 * frontend shows a pop-up and appends the card. This is the incremental alternative to
 * broadcastRadar's full snapshot — a fresh trigger shows up live, without a page refresh,
 * and we don't resend the whole list each minute.
 */
async function emitRadarNew(io, date, symbols) {
  if (!io || !date) return;
  const list = Array.isArray(symbols) ? symbols.filter(Boolean) : [];
  if (!list.length) return;
  let payload;
  try {
    payload = await radar.getRadarNew(date, list);
  } catch (err) {
    console.error('[radar] getRadarNew error:', err.message);
    return;
  }
  if (!payload.new.length) return;
  for (const socket of io.sockets.sockets.values()) {
    const raw = await connection.get(SUB_KEY(socket.id));
    if (!raw) continue;
    const { date: subDate } = JSON.parse(raw);
    if (subDate !== date) continue;                 // budget/day-scoped: only that day's clients
    socket.emit('radar:new', payload);
  }
}

module.exports = { registerRadarHandlers, broadcastRadar, emitRadarNew };