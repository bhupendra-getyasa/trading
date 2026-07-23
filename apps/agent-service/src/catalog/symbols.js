'use strict';
/*
 * symbols.js — the live symbol universe, loaded once at boot.
 *
 * This feeds an `enum` into every tool's input_schema. That matters: the model
 * sees the full list of valid tickers in the tool spec itself, so a hallucinated
 * symbol is a SCHEMA violation it can see and avoid, not a runtime miss it
 * discovers by burning a round-trip.
 *
 * Boot-loaded rather than per-call: the KSE listing set changes on the order of
 * months, and re-reading it per turn would put a query in front of every tool
 * spec build. The tradeoff is that a newly listed symbol needs a restart, which
 * matches how the rest of the platform already behaves (live-engine caches
 * classifications for the trading day).
 *
 * Query shape mirrors live-engine/repository.js listSymbols(): DISTINCT ON over
 * market_stock_snapshots using the (symbol, created_at DESC) index.
 */
const db = require('../db/pool');

let symbols = [];

async function load() {
  const { rows } = await db.query(
    'symbols.load',
    `SELECT DISTINCT ON (symbol) symbol
       FROM public.market_stock_snapshots
      ORDER BY symbol, created_at DESC`
  );
  symbols = rows.map((r) => r.symbol).filter(Boolean).sort();
  if (symbols.length === 0) {
    // Refuse to start. An empty enum is not a degraded service, it is a trap:
    // every tool would reject every ticker, the model would conclude it has no
    // usable tools, and a model that believes it has no usable tools does not
    // say so — it invents the data. Better to not start than to answer wrongly.
    throw new Error(
      'market_stock_snapshots returned no symbols. Every tool enum would be empty and every ' +
        'ticker would be rejected. Check that ingestion has run and that agent_ro has SELECT on it.'
    );
  }
  console.log(`[agent][symbols] loaded ${symbols.length} symbols`);
  return symbols;
}

function list() {
  return symbols;
}

function has(sym) {
  return symbols.includes(sym);
}

/** The reusable schema fragment for a symbol argument. */
function schema(description) {
  return {
    type: 'string',
    enum: symbols,
    description,
  };
}

module.exports = { load, list, has, schema };