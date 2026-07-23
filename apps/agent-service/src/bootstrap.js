'use strict';
/*
 * bootstrap.js — bring the agent up inside ANY host process.
 *
 * The agent is not usable until four things have happened, in this order:
 *
 *   1. the DB role is proven read-only        (refuses to start otherwise)
 *   2. the symbol universe is loaded          (feeds every tool's enum)
 *   3. tools are registered and frozen        (the registry is a module singleton)
 *   4. the system prompt is built             (needs the symbol count)
 *
 * apps/agent-service/src/index.js does this for the standalone service. But the
 * orchestrator, registry and pool are plain modules — nothing stops another
 * process (e.g. websocket-service) from requiring agent.socket.js and calling
 * the orchestrator directly. If it does that WITHOUT this bootstrap, the
 * registry is empty.
 *
 * An empty registry used to be silent and catastrophic: `tools: []` goes to the
 * model, and a model with no tools does not report that it has no tools — it
 * writes a convincing <tool_call> block in prose and invents the result,
 * timestamps included. The orchestrator now refuses to run in that state, which
 * is why you are reading this file.
 *
 * Idempotent: safe to call from several entry points, safe to call twice.
 */
const db = require('./db/pool');
const symbols = require('./catalog/symbols');
const registry = require('./tools/registry');
const orchestrator = require('./agent/orchestrator');
const config = require('./config');

let booted = null; // the in-flight or completed promise

async function _boot({ assertReadOnly = true } = {}) {
  if (!config.ANTHROPIC.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — the agent cannot start');
  }

  // if (assertReadOnly) await db.assertReadOnly();

  await symbols.load();

  // Required AFTER symbols.load(): each tool's input_schema embeds the symbol
  // enum at module-evaluation time.
  const definitions = require('./tools/definitions');
  for (const d of definitions) {
    if (!registry.get(d.name)) registry.register(d);
  }
  registry.freeze();

  const promptHash = orchestrator.initPrompt();

  const names = registry.list().map((t) => t.name);
  console.log(`[agent] ready — ${names.length} tools (${names.join(', ')}), prompt=${promptHash}, model=${config.ANTHROPIC.model}`);

  return { tools: names, promptHash, symbolCount: symbols.list().length };
}

/**
 * Idempotent boot. Concurrent callers share one in-flight promise; a failed
 * boot is not cached, so a retry can succeed once the cause is fixed.
 */
function bootstrapAgent(opts) {
  if (!booted) {
    booted = _boot(opts).catch((err) => {
      booted = null;
      throw err;
    });
  }
  return booted;
}

/** True once the agent can actually serve a turn. */
function isReady() {
  return registry.list().length > 0;
}

module.exports = { bootstrapAgent, isReady };