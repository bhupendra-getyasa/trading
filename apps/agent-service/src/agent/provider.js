'use strict';
/*
 * provider.js — the ONLY module that imports the Anthropic SDK.
 *
 * Everything above it consumes a plain event stream, so swapping providers (or
 * dropping in a fake for tests) does not touch the orchestrator.
 *
 * This is the Messages API (POST /v1/messages), not OpenAI's Responses API.
 * Relevant differences the rest of the service depends on:
 *   - tool schema key is `input_schema`, not `parameters`
 *   - a tool call is a `tool_use` block; a result is a `tool_result` block sent
 *     back in a USER message
 *   - there is no strict mode, so malformed args are normal — the executor
 *     hands the validation errors back and the model self-corrects
 *   - it is STATELESS: no server-side conversation storage. We send full
 *     context each turn and own the history. That is what we wanted anyway.
 */
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

let client = null;
function getClient() {
  if (!client) {
    if (!config.ANTHROPIC.apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set — agent-service cannot start');
    }
    client = new Anthropic({
      apiKey: config.ANTHROPIC.apiKey,
      timeout: config.ANTHROPIC.timeoutMs,
      maxRetries: 0, // we handle retries ourselves — see below
    });
  }
  return client;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

function isRetryable(err) {
  if (err && RETRYABLE_STATUS.has(err.status)) return true;
  const code = err && err.code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stream one model call.
 *
 * `onEvent` receives:
 *   { type: 'text', text }              incremental prose
 *   { type: 'tool_start', name }        a tool_use block began (args not ready)
 *
 * Resolves to { text, toolCalls, stopReason, usage }.
 *
 * RETRY RULE: only before the first emitted token. Once text has reached the
 * user, a silent retry would re-emit from scratch and the UI shows the answer
 * twice — or worse, two different answers. After first emission a retryable
 * error becomes fatal for the turn.
 */
async function streamOnce(params, onEvent) {
  const c = getClient();
  let emitted = false;
  let attempt = 0;

  for (;;) {
    try {
      const stream = await c.messages.stream(params);
      const text = [];
      const toolCalls = [];
      let usage = null;
      let stopReason = null;

      stream.on('text', (delta) => {
        emitted = true;
        text.push(delta);
        onEvent({ type: 'text', text: delta });
      });

      // Tool arguments arrive as input_json_delta fragments and are only
      // parseable at content_block_stop. The SDK accumulates them for us; we
      // announce the start (name is known immediately) so the UI can show
      // activity, and read the parsed input from the final message.
      stream.on('contentBlock', (block) => {
        if (block.type === 'tool_use') {
          emitted = true;
          onEvent({ type: 'tool_start', name: block.name });
        }
      });

      const final = await stream.finalMessage();
      stopReason = final.stop_reason;
      usage = final.usage;

      for (const block of final.content) {
        if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, input: block.input });
        }
      }

      return {
        text: text.join(''),
        content: final.content,
        toolCalls,
        stopReason,
        usage,
      };
    } catch (err) {
      attempt += 1;
      if (emitted || !isRetryable(err) || attempt >= 3) throw err;
      // Honour Retry-After when the API sends one; it knows better than our backoff.
      const retryAfter = err.headers && Number(err.headers['retry-after']);
      const delay = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : Math.min(4000, 300 * 2 ** attempt) * Math.random();
      console.warn(`[agent][llm] retryable error (${err.status || err.code}); retrying in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
}

/**
 * Build the request. The system prompt and tool definitions are marked for
 * ephemeral caching — they are the biggest static block and are byte-identical
 * across every turn, so caching them is the single largest cost lever here.
 *
 * Caching is PREFIX matching: anything before a breakpoint must be identical.
 * That is why nothing time-varying (a timestamp, "today's date") is allowed
 * into the system prompt — it would invalidate the cache on every call.
 */
function buildParams({ system, tools, messages }) {
  return {
    model: config.ANTHROPIC.model,
    max_tokens: config.ANTHROPIC.maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools,
    messages,
  };
}

module.exports = { streamOnce, buildParams };
