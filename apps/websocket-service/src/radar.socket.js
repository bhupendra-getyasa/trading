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

async function emitRadar(socket) {
  const sub = socket.data.radar;
  if (!sub || !sub.date) return;
  try {
    const snap = await radar.getRadarSnapshot(sub.date, sub.budget);
    socket.emit('radar:update', snap);
  } catch (err) {
    console.error('[radar] emit error:', err.message);
  }
}

/** Attach the radar handlers to a freshly connected socket. Call inside io.on('connection'). */
function registerRadarHandlers(io, socket) {
  socket.on('radar:subscribe', async ({ date } = {}) => {
    const budget = await radar.getBudget(date);          // today's saved budget (may be null)
    socket.data.radar = { date, budget };
    await connection.set(SUB_KEY(socket.id), JSON.stringify(socket.data.radar));
    await emitRadar(socket);
  });

  socket.on('budget:set', async ({ date, ceiling_kd } = {}) => {
    const d = date || socket.data.radar?.date;
    if (!d) return;
    await radar.setBudget(d, ceiling_kd);
    socket.data.radar = { date: d, budget: Number(ceiling_kd) };
    await connection.set(SUB_KEY(socket.id), JSON.stringify(socket.data.radar));
    await emitRadar(socket);
  });

  socket.on('decision', async ({ id, symbol, action, reason } = {}) => {
    try {
      await radar.recordDecision({ id, symbol, action, reason, date: socket.data.radar?.date });
    } catch (err) {
      console.error('[radar] decision error:', err.message);
    }
    await emitRadar(socket);                              // reflect the status change at once
  });

  socket.on('disconnect', async () => {
    await connection.del(SUB_KEY(socket.id));
  });
}

/**
 * Re-broadcast the radar to every subscribed socket. Called by the socket-queue
 * worker each minute after the scanner writes a fresh opportunity_list.
 */
async function broadcastRadar(io) {
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    const raw = await connection.get(SUB_KEY(socket.id));
    if (!raw) continue;
    const { date, budget } = JSON.parse(raw);
    try {
      const snap = await radar.getRadarSnapshot(date, budget);
      socket.emit('radar:update', snap);
    } catch (err) {
      console.error('[radar] broadcast error:', err.message);
    }
  }
}

module.exports = { registerRadarHandlers, broadcastRadar };