'use strict';
/*
 * pool.js — the agent's OWN read-only Postgres pool.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT REUSE `require('@trading/shared').pool`
 * ---------------------------------------------------------------------------
 * packages/shared/index.js spreads ./src/db/postgres, which constructs
 * `new Pool({ user: DB_USER, max: 10 })` AS AN IMPORT SIDE EFFECT. That pool is
 * read-write: the live-engine uses it to run CREATE TABLE / ALTER TABLE and to
 * INSERT into opportunity_list, decisions, radar_events.
 *
 * An LLM chooses this service's query parameters. Handing it a connection with
 * write privileges means the only thing standing between a prompt injection and
 * production trading data is application code. Postgres grants are not
 * bypassable by cleverness with text; application code is.
 *
 * So: separate role, separate pool, and a boot probe that PROVES it. If this
 * file is ever "simplified" to import the shared pool, the security model of the
 * whole service is gone and nothing will visibly break until it matters.
 *
 * Note the same rule applies to engine imports elsewhere in this service: always
 * `require('@trading/shared/src/live-engine/sizing')`, NEVER
 * `require('@trading/shared')` — the latter opens the RW pool as a side effect.
 * (apps/websocket-service/src/services/radar.service.js already imports sizing
 * this way; we follow that precedent.)
 */
const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  host: config.DB.host,
  port: config.DB.port,
  user: config.DB.user,
  password: config.DB.password,
  database: config.DB.database,
  ssl: config.DB.ssl,
  max: config.DB.max,
  idleTimeoutMillis: config.DB.idleTimeoutMillis,
  connectionTimeoutMillis: config.DB.connectionTimeoutMillis,
  // Belt and braces: also set via ALTER ROLE in the migration, so it survives
  // someone constructing a Pool without going through this file.
  statement_timeout: config.DB.statementTimeoutMs,
  // Surfaces in pg_stat_activity. When RDS shows a runaway query at 09:15 this
  // is what tells you it was the agent and not the ingestion worker.
  application_name: 'agent-service-ro',
});

pool.on('connect', (client) => {
  // search_path is a shadowing vector: an inherited path could resolve
  // `market_stock_snapshots` to something else entirely.
  client.query('SET search_path TO public').catch((err) => {
    console.error('[agent][db] failed to pin search_path:', err.message);
  });
});

// Mandatory. An idle client emitting 'error' with no listener is an unhandled
// 'error' event, which kills the process. An RDS failover would otherwise take
// down this service on every replica at once.
pool.on('error', (err) => {
  console.error('[agent][db] idle client error (pool will evict):', err.message);
});

/**
 * Prove at boot that this pool cannot write.
 *
 * This is not paranoia about Postgres. It is defence against a deployment
 * mistake: someone points AGENT_DB_USER at the ingestion credentials, in a
 * hurry, probably at 09:00 on a trading day. The failure mode of that mistake
 * must be "the service won't start", not "the AI agent has write access to
 * production market data and nobody finds out until it does something".
 */
async function assertReadOnly() {
  if (!config.ASSERT_READ_ONLY) {
    console.warn('[agent][db] AGENT_DB_ASSERT_RO=false — read-only guarantee is UNVERIFIED');
    return;
  }
  if (config.USING_SHARED_CREDS) {
    console.warn(
      '[agent][db] AGENT_DB_USER is not set; falling back to DB_USER. ' +
        'Run migrations/001_agent_ro_role.sql and set AGENT_DB_* before production.'
    );
  }

  const client = await pool.connect();
  try {
    const flag = await client.query('SHOW default_transaction_read_only');
    const value = flag.rows[0] && flag.rows[0].default_transaction_read_only;
    if (value !== 'on') {
      throw new Error(
        `agent DB role is not read-only (default_transaction_read_only=${value}). ` +
          'Refusing to start. Run migrations/001_agent_ro_role.sql and point AGENT_DB_USER at agent_ro.'
      );
    }

    // A session setting can be overridden. Grants cannot. Probe the grant itself,
    // inside a transaction we always roll back so the probe can never be the
    // thing that writes.
    await client.query('BEGIN');
    let wrote = false;
    try {
      await client.query('CREATE TEMP TABLE __agent_boot_probe__ (x int)');
      wrote = true;
    } catch (e) {
      // 42501 insufficient_privilege / 25006 read_only_sql_transaction are both
      // correct rejections. Anything else means the probe itself is broken and
      // we have learned nothing — fail closed.
      if (e.code !== '42501' && e.code !== '25006') {
        throw new Error(`read-only probe failed unexpectedly (sqlstate=${e.code}): ${e.message}`);
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
    if (wrote) throw new Error('agent DB role was able to create a table. Refusing to start.');

    console.log('[agent][db] read-only assertion passed');
  } finally {
    client.release();
  }
}

/**
 * The single query entry point. Parameterized only — there is no interpolation
 * API in this service, because there is no model-authored SQL in this service.
 *
 * `label` is a bounded, hand-written call-site id used for logging.
 */
async function query(label, text, params = []) {
  const started = Date.now();
  try {
    const res = await pool.query(text, params);
    return {
      rows: res.rows,
      rowCount: res.rowCount == null ? res.rows.length : res.rowCount,
      durationMs: Date.now() - started,
      // Provenance. There is no turn-level snapshot pinning (that would hold a
      // connection for up to 90s and cap concurrency at pool max), so instead
      // every result carries the instant it was read and the answer says so.
      asOf: new Date().toISOString(),
    };
  } catch (err) {
    // Postgres text never leaves this function. `relation "x" does not exist`
    // is schema disclosure, and in this service it would be handed to a model
    // that will repeat it verbatim to whoever asked.
    console.error(`[agent][db] query failed (${label}) sqlstate=${err.code}:`, err.message);
    const safe = new Error('The query could not be completed.');
    safe.code = err.code;
    safe.label = label;
    throw safe;
  }
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, assertReadOnly, close };
