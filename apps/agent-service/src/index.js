'use strict';
/*
 * index.js — agent-service entry point.
 *
 * Shape follows apps/websocket-service/src/index.js: express + http.Server +
 * socket init + routes. Port 4002 (4000 = websocket, 4001 = ingestion).
 *
 * BOOT ORDER IS LOAD-BEARING:
 *   1. assert the DB role really is read-only  <- refuses to start otherwise
 *   2. load the symbol universe                <- feeds every tool's enum
 *   3. register + freeze tools
 *   4. build the system prompt
 *   5. only then bind the port
 *
 * A service that starts with the wrong credentials and discovers it at 03:00 is
 * strictly worse than one that refuses to start at 09:00.
 */
const express = require('express');
const http = require('http');
const cors = require('cors');
require('dotenv').config();

const config = require('./config');
const db = require('./db/pool');
const { bootstrapAgent } = require('./bootstrap');
const routes = require('./routes');
const agentSocket = require('./agent.socket');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: '*', credentials: true }));

app.use((req, res, next) => {
  console.log('[agent] incoming:', req.method, req.url);
  next();
});

app.use('/', routes);

// Terminal error handler. Never leaks internals to the client — err.message may
// carry driver or provider text.
app.use((err, req, res, next) => {
  console.error('[agent] unhandled:', err.stack || err.message);
  res.status(500).json({ error: 'Internal error' });
});

const server = http.createServer(app);

async function start() {
  // The whole boot sequence lives in bootstrap.js so that a different host
  // process (websocket-service, a CLI, a test harness) can bring the agent up
  // the same way. Registering tools here only would mean any other entry point
  // runs with an empty registry.
  await bootstrapAgent();

  agentSocket.init(server);

  server.listen(config.PORT, () => {
    console.log(`[agent] agent-service listening on ${config.PORT}`);
  });
}

async function shutdown(signal) {
  console.log(`[agent] ${signal} received, shutting down`);
  server.close();
  await db.close().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('[agent] failed to start:', err.message);
  process.exit(1);
});