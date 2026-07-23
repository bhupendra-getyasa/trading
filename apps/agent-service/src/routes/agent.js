'use strict';
const express = require('express');
const orchestrator = require('../agent/orchestrator');
const registry = require('../tools/registry');
const symbols = require('../catalog/symbols');
const db = require('../db/pool');

const router = express.Router();

/**
 * POST /agent/ask
 * body: { question: string, history?: [{role, content}] }
 *
 * Synchronous. The socket path (agent.socket.js) is the streaming one; this
 * exists so the agent is usable and testable without a socket, and so a dropped
 * socket has a reconciliation path. The database is truth; the socket is a
 * convenience.
 */
router.post('/ask', async (req, res, next) => {
  try {
    const { question, history } = req.body || {};
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: 'question is required' });
    }
    if (question.length > 2000) {
      return res.status(400).json({ error: 'question is too long (max 2000 chars)' });
    }
    const out = await orchestrator.run({
      question: question.trim(),
      history: Array.isArray(history) ? history : [],
    });
    return res.json(out);
  } catch (err) {
    return next(err);
  }
});

/** What the agent can do — useful for the frontend and for debugging tool specs. */
router.get('/tools', (req, res) => {
  res.json({
    tools: registry.list().map((t) => ({
      name: t.name,
      version: t.version,
      description: t.description,
    })),
    symbol_count: symbols.list().length,
  });
});

/** Liveness. Deliberately does NOT touch Postgres — see below. */
router.get('/healthz', (req, res) => res.json({ ok: true }));

/**
 * Readiness. Probes the pool.
 *
 * Kept separate from liveness on purpose: if liveness probed the database, an
 * RDS blip would fail every replica's liveness at once and the orchestrator
 * would kill them all — turning a 30-second hiccup into a full outage.
 */
router.get('/readyz', async (req, res) => {
  try {
    await db.query('health.ready', 'SELECT 1');
    res.json({ ready: true, pool: { total: db.pool.totalCount, idle: db.pool.idleCount, waiting: db.pool.waitingCount } });
  } catch (e) {
    res.status(503).json({ ready: false });
  }
});

module.exports = router;
