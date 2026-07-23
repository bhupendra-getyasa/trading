'use strict';
/*
 * config.js — every env var this service reads, in one place.
 *
 * Follows the repo convention: `require('dotenv').config()` at module load and
 * plain `process.env` reads (same as packages/shared/src/db/postgres.js).
 *
 * The one place we deliberately differ: AGENT_DB_* are read SEPARATELY from the
 * DB_* that packages/shared uses. They must point at a read-only Postgres role
 * (migrations/001_agent_ro_role.sql). If AGENT_DB_USER is unset we fall back to
 * DB_* so the service still boots in dev — but boot then logs a loud warning and
 * db/pool.js will fail its read-only assertion unless AGENT_DB_ASSERT_RO=false.
 */
require('dotenv').config();

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v == null || v === '' ? d : String(v).toLowerCase() === 'true');

const usingSharedCreds = !process.env.AGENT_DB_USER;

module.exports = {
  PORT: int(process.env.AGENT_PORT, 4002),

  DB: {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT, 
    user: process.env.AGENT_DB_USER,
    password: process.env.AGENT_DB_PASSWORD,
    database: process.env.DB_NAME,
    // Matches packages/shared/src/db/postgres.js — RDS with a cert we don't pin.
    // Changing this here only would give the agent a different TLS posture than
    // the rest of the platform for no benefit; if it should be tightened, it
    // should be tightened everywhere, in its own change.
    ssl: { rejectUnauthorized: false },
    // Deliberately small. Total connections against RDS = sum(max) x replicas,
    // shared with ingestion (10) + websocket (10). The agent must never be the
    // reason the live engine can't write at 09:15.
    max: int(process.env.AGENT_DB_POOL_MAX, 4),
    statementTimeoutMs: int(process.env.AGENT_DB_STATEMENT_TIMEOUT_MS, 8000),
    connectionTimeoutMillis: int(process.env.AGENT_DB_CONNECTION_TIMEOUT_MS, 5000),
    idleTimeoutMillis: 30000,
  },

  // Boot probe: prove the pool really cannot write. See db/pool.js.
  ASSERT_READ_ONLY: bool(process.env.AGENT_DB_ASSERT_RO, true),
  USING_SHARED_CREDS: usingSharedCreds,

  ANTHROPIC: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    maxTokens: int(process.env.ANTHROPIC_MAX_TOKENS, 2048),
    timeoutMs: int(process.env.AGENT_LLM_TIMEOUT_MS, 60000),
  },

  // Timeout ladder. Each layer must give up before the one above it, or we
  // abandon a query that is still burning an RDS connection.
  //   statement_timeout 8s < tool 10s < llm 60s < turn 90s
  TIMEOUTS: {
    toolMs: int(process.env.AGENT_TOOL_TIMEOUT_MS, 10000),
    turnMs: int(process.env.AGENT_TURN_TIMEOUT_MS, 90000),
  },

  MAX_ITERATIONS: int(process.env.AGENT_MAX_ITERATIONS, 8),

  // Session/window constants are NOT redefined here — they are read from the
  // live-engine CONFIG so the agent and the engine can never disagree.
};
