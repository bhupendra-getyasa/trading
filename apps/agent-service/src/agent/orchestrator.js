'use strict';
/*
 * orchestrator.js — the turn loop.
 *
 * Provider-agnostic: it talks to provider.js and executor.js and imports
 * neither the Anthropic SDK nor pg.
 *
 * Returns { answer, sources, meta }.
 */
const provider = require('./provider');
const prompt = require('./prompt');
const registry = require('../tools/registry');
const executor = require('../tools/executor');
const symbols = require('../catalog/symbols');
const config = require('../config');

let SYSTEM = null;
let SYSTEM_HASH = null;

function initPrompt() {
  SYSTEM = prompt.build(symbols.list().length);
  SYSTEM_HASH = prompt.hash(SYSTEM);
  return SYSTEM_HASH;
}

/*
 * The corrective nudge for an answer with no tool calls behind it.
 *
 * Note this is NOT a bare retry. Re-sending an identical request to a
 * non-deterministic model is a reroll, not a retry — it has no mechanism by
 * which to work. The corrective turn APPENDS A REAL MESSAGE, which makes it a
 * materially different request.
 *
 * It fires at most once per turn: a model that ignores one explicit correction
 * will not comply with a second, and each attempt costs real tokens.
 */
const UNGROUNDED_NUDGE =
  'You answered without calling any tool. You have no reliable knowledge of Boursa Kuwait — ' +
  'nothing about this market is in your training data, and any number you produced from memory is ' +
  'invented. Call a tool to retrieve the data. If no tool can answer this, say plainly that you do ' +
  'not have that data and explain what you do have.';

/**
 * Does this look like a question that needs data?
 *
 * Deliberately conservative. Greetings, "what can you do", and questions about
 * concepts ("what does Lane A mean" — answerable from the system prompt) do not
 * need a tool and must not be nudged; nudging them wastes a round-trip and
 * still produces no tool call. So the nudge only fires when the model produced
 * a NUMBER without having read one, which is the failure that actually matters:
 * a confident invented figure.
 */
const NUMBER_RE = /\b\d+(\.\d+)?\b/;
function looksUngrounded(text, ledgerSize) {
  if (ledgerSize > 0) return false;
  if (!text) return false;
  return NUMBER_RE.test(text);
}

/**
 * Sanitize caller-supplied history.
 *
 * The Messages API rejects an array whose first message is not `user`, and
 * expects roles to alternate. A client that seeds its thread with a greeting
 * (ours does) would otherwise 400 on every FIRST question — which is exactly
 * the bug this function was written for.
 *
 * The frontend does this too. It is done again here because the API surface is
 * public and "the client already validated it" is not a validation.
 */
const MAX_HISTORY_TURNS = 20;

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  const mapped = history
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

  while (mapped.length && mapped[0].role !== 'user') mapped.shift();

  const out = [];
  for (const m of mapped) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ ...m });
  }

  // The question is appended as a user turn, so history must not end on one.
  if (out.length && out[out.length - 1].role === 'user') out.pop();

  // Keep the tail: recent context matters, and an unbounded array is an
  // unbounded bill.
  return out.slice(-MAX_HISTORY_TURNS);
}

async function run({ question, history = [], onEvent = () => {} }) {
  if (!SYSTEM) initPrompt();

  const startedAt = Date.now();
  const messages = [...sanitizeHistory(history), { role: 'user', content: question }];
  const tools = registry.toModelSpecs();

  // If this is ever empty the model has nothing to call, and a model with no
  // tools does not say "I have no tools" — it writes a plausible-looking
  // <tool_call> block in prose and invents the result. Fail loudly instead.
  if (tools.length === 0) {
    throw new Error('No tools registered — refusing to run a turn that could only hallucinate.');
  }

  // The ledger is the orchestrator's own record of what it dispatched. The model
  // has no write access to it. `sources` is assembled from THIS, never from
  // anything the model reports — a model-reported source list is a claim of
  // provenance, and an unfalsifiable one, because the UI would render an
  // invented tool name with the same confidence as a real read.
  const ledger = [];
  const usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  let nudged = false;
  let iterations = 0;
  let stopReason = 'complete';

  const deadline = startedAt + config.TIMEOUTS.turnMs;

  for (let i = 0; i < config.MAX_ITERATIONS; i++) {
    iterations = i + 1;

    if (Date.now() > deadline) {
      stopReason = 'turn_timeout';
      break;
    }

    onEvent({ type: 'iteration', n: iterations, of: config.MAX_ITERATIONS });

    const params = provider.buildParams({ system: SYSTEM, tools, messages });
    const res = await provider.streamOnce(params, onEvent);

    if (res.usage) {
      usage.input += res.usage.input_tokens || 0;
      usage.output += res.usage.output_tokens || 0;
      usage.cache_read += res.usage.cache_read_input_tokens || 0;
      usage.cache_creation += res.usage.cache_creation_input_tokens || 0;
    }

    // No tool calls -> the model believes it is done.
    if (res.toolCalls.length === 0) {
      if (!nudged && looksUngrounded(res.text, ledger.length)) {
        nudged = true;
        onEvent({ type: 'correction', reason: 'ungrounded' });
        messages.push({ role: 'assistant', content: res.content });
        messages.push({ role: 'user', content: UNGROUNDED_NUDGE });
        continue;
      }
      return finish(res.text, ledger, usage, iterations, stopReason, startedAt, nudged);
    }

    // Every tool_use MUST get a matching tool_result in the immediately
    // following user message — including failures — or the API rejects the
    // request. executeAll returns one result per call by construction.
    messages.push({ role: 'assistant', content: res.content });

    const results = await executor.executeAll(res.toolCalls, {});

    const toolResults = [];
    for (let k = 0; k < res.toolCalls.length; k++) {
      const call = res.toolCalls[k];
      const out = results[k];

      ledger.push({ id: call.id, name: call.name, ok: out.ok, meta: out.meta, error: out.error });

      onEvent({
        type: 'tool_done',
        name: call.name,
        ok: out.ok,
        duration_ms: out.meta ? out.meta.duration_ms : null,
      });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        is_error: !out.ok,
        content: JSON.stringify(out.ok ? out.data : out.error),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Iteration cap or deadline hit with no final answer. Rather than return
  // nothing after paying for N model calls, ask once for a conclusion from what
  // was actually gathered.
  stopReason = stopReason === 'turn_timeout' ? 'turn_timeout' : 'max_iterations';
  messages.push({
    role: 'user',
    content:
      'Stop calling tools and answer now, using only what the tool results above actually show. ' +
      'If that is not enough to answer fully, say what you found and what is still missing.',
  });
  const finalRes = await provider.streamOnce(
    provider.buildParams({ system: SYSTEM, tools: [], messages }),
    () => {} // do not stream this to the client; it would duplicate visible text
  );

  // The forced call is sent with tools: [], so the model has nothing to call and
  // should produce prose. If it still comes back with no text (e.g. it hit
  // max_tokens mid-block), do NOT hand the caller an empty string dressed up as
  // an answer — say what happened. An empty answer looks like a broken UI; an
  // explicit one is actionable.
  const answer =
    finalRes.text && finalRes.text.trim()
      ? finalRes.text
      : stopReason === 'turn_timeout'
        ? 'I ran out of time on that one before I could finish. Try a narrower question.'
        : 'I gathered some data but could not reach a conclusion within my step limit. Try asking about one symbol at a time.';

  return finish(answer, ledger, usage, iterations, stopReason, startedAt, nudged);
}

function finish(answer, ledger, usage, iterations, stopReason, startedAt, nudged) {
  // Sources come out of the execution ledger, not out of the model's mouth.
  const sources = ledger
    .filter((l) => l.ok)
    .map((l) => ({
      tool: l.name,
      tool_version: l.meta && l.meta.tool_version,
      args: l.meta && l.meta.args,
      as_of: l.meta && l.meta.as_of,
      duration_ms: l.meta && l.meta.duration_ms,
    }));

  return {
    answer,
    sources,
    meta: {
      iterations,
      stop_reason: stopReason,
      corrected: nudged,
      tool_calls: ledger.length,
      tool_errors: ledger.filter((l) => !l.ok).length,
      usage,
      prompt_hash: SYSTEM_HASH,
      duration_ms: Date.now() - startedAt,
    },
  };
}

module.exports = { run, initPrompt };