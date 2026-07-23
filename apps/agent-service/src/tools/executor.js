'use strict';
/*
 * executor.js — every tool call goes through here. Nothing bypasses it.
 *
 * Chain: resolve -> validate -> timeout -> execute -> shape -> return.
 *
 * ERRORS ARE DATA. This never throws for a tool-level failure. The distinction
 * that matters:
 *
 *   the model's problem  -> { ok: false, error } appended to the conversation,
 *                            model adapts and retries with different args.
 *                            e.g. bad symbol, no rows, range too wide.
 *   our problem          -> throws. Turn fails. e.g. pool exhausted.
 *
 * Error messages handed back are written to be ACTIONABLE BY A MODEL —
 * imperative and specific ("try a narrower range"), not diagnostic
 * ("statement timeout exceeded"). And they never contain Postgres text.
 */
const registry = require('./registry');
const config = require('../config');

const MAX_ROWS = 50;

function withTimeout(promise, ms, toolName) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('TOOL_TIMEOUT');
      e.toolTimeout = true;
      e.toolName = toolName;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Cap rows AFTER execute, BEFORE the result reaches the model.
 *
 * Truncation is TOLD to the model. A silent truncation is a wrong answer: the
 * model would report the top 50 of 412 as if it were the whole set.
 */
function shape(data) {
  if (Array.isArray(data) && data.length > MAX_ROWS) {
    return {
      rows: data.slice(0, MAX_ROWS),
      truncated: true,
      total_rows: data.length,
      note: `Showing the first ${MAX_ROWS} of ${data.length} rows. Narrow the request to see the rest.`,
    };
  }
  return data;
}

async function execute(call, ctx) {
  const started = Date.now();
  const tool = registry.get(call.name);

  if (!tool) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: `No tool named "${call.name}". Available: ${registry.list().map((t) => t.name).join(', ')}.`,
      },
    };
  }

  const v = registry.validate(tool.input_schema, call.input);
  if (!v.ok) {
    // The zod-issues equivalent: give the model exactly what was wrong so it can
    // fix the call itself rather than us guessing on its behalf.
    return {
      ok: false,
      error: { code: 'INVALID_ARGS', message: `Invalid arguments for ${tool.name}: ${v.errors.join('; ')}` },
    };
  }

  try {
    const data = await withTimeout(tool.execute(v.value, ctx), config.TIMEOUTS.toolMs, tool.name);
    return {
      ok: true,
      data: shape(data),
      meta: {
        tool: tool.name,
        tool_version: tool.version,
        args: v.value,
        duration_ms: Date.now() - started,
        as_of: (data && data.as_of) || new Date().toISOString(),
      },
    };
  } catch (err) {
    if (err.toolTimeout) {
      return {
        ok: false,
        error: {
          code: 'TOO_EXPENSIVE',
          message: `${tool.name} took too long. Narrow the range — fewer symbols, or a smaller window.`,
        },
      };
    }
    // 42501 is agent_ro doing its job. Never retried — retrying spends a
    // connection reproducing a CORRECT rejection.
    if (err.code === '42501') {
      return {
        ok: false,
        error: { code: 'NOT_PERMITTED', message: 'That data is not accessible to this agent.' },
      };
    }
    if (err.code === '57014') {
      return {
        ok: false,
        error: { code: 'TOO_EXPENSIVE', message: 'The query took too long. Narrow the date range or symbol list.' },
      };
    }
    if (err.expected) {
      // Tools raise these deliberately for conditions the model should handle.
      return { ok: false, error: { code: err.code || 'TOOL_ERROR', message: err.message } };
    }
    // Anything else is OUR problem, not the model's. Let it kill the turn.
    throw err;
  }
}

/**
 * The Messages API emits parallel tool_use blocks. Every one MUST get a
 * matching tool_result in the immediately following user message or the API
 * 400s — including the failures. So this always returns one result per call.
 *
 * Concurrency is bounded by the pool (max 4) rather than a semaphore: with five
 * tools and a per-tool statement_timeout below the tool timeout, a queued
 * checkout resolves or the connection times out well inside the ladder. If the
 * tool set grows, revisit.
 */
async function executeAll(calls, ctx) {
  return Promise.all(calls.map((c) => execute(c, ctx)));
}

/** A helper for tools to raise model-facing conditions. */
function expected(code, message) {
  const e = new Error(message);
  e.expected = true;
  e.code = code;
  return e;
}

module.exports = { execute, executeAll, expected, MAX_ROWS };
