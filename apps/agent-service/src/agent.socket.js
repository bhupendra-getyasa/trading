'use strict';
/*
 * agent.socket.js — streaming chat.
 *
 * Follows the existing pattern in apps/websocket-service/src/radar.socket.js:
 * a register* function called per connection from socket.js.
 *
 * Each ask gets its own room (`turn:<id>`) so a client with two tabs does not
 * see the other tab's stream. There is no cross-user authorization check here
 * because there is nothing to check against — this service reads no user-scoped
 * data at all (agent_ro has no grant on users/watchlists/watchlist_targets), so
 * one user's answer is not privileged relative to another's. If a future tool
 * ever reads per-user data, this file needs an auth handshake FIRST.
 */
const { Server } = require('socket.io');
const crypto = require('crypto');
const orchestrator = require('./agent/orchestrator');

let io;

function init(server) {
  io = new Server(server, {
    // Matches apps/websocket-service/src/socket.js.
    cors: { origin: '*', credentials: true },
  });

  io.on('connection', (socket) => {
    console.log('[agent][socket] client connected:', socket.id);
    registerAgentHandlers(socket);
    socket.on('disconnect', () => console.log('[agent][socket] client disconnected:', socket.id));
  });

  return io;
}

function registerAgentHandlers(socket) {
  socket.on('agent:ask', async (payload, ack) => {
    // console.log('data: ', data);
    // const payload = JSON.parse(data)
    console.log('payload: ', payload, typeof payload);
    const question = payload && payload.question;
    console.log('question: ', question);
    const history = (payload && payload.history) || [];
    const turnId = crypto.randomUUID();

    if (!question || typeof question !== 'string' || !question.trim()) {
      if (typeof ack === 'function') ack({ ok: false, error: 'question is required' });
      return;
    }
    if (typeof ack === 'function') ack({ ok: true, turnId });

    const emit = (event, data) => socket.emit(event, { turnId, ...data });

    emit('agent:status', { status: 'running' });

    try {
      const out = await orchestrator.run({
        question: question.trim(),
        history: Array.isArray(history) ? history : [],
        onEvent: (e) => {
          switch (e.type) {
            case 'text':
              emit('agent:text', { delta: e.text });
              break;
            case 'tool_start':
              // Tool NAME and timing only — never rows. Streaming result sets
              // through the socket duplicates what `agent:done` already carries
              // and is how you find the adapter's throughput ceiling.
              emit('agent:tool', { name: e.name, state: 'started' });
              break;
            case 'tool_done':
              emit('agent:tool', { name: e.name, state: 'finished', ok: e.ok, duration_ms: e.duration_ms });
              break;
            case 'iteration':
              emit('agent:iteration', { n: e.n, of: e.of });
              break;
            case 'correction':
              emit('agent:correction', { reason: e.reason });
              break;
            default:
              break;
          }
        },
      });

      emit('agent:done', { answer: out.answer, sources: out.sources, meta: out.meta });
    } catch (err) {
      console.error('[agent][socket] turn failed:', err.message);
      emit('agent:error', {
        code: 'TURN_FAILED',
        // Never the raw message: it may carry driver or provider internals.
        message: 'The assistant could not complete that request. Please try again.',
      });
    }
  });
}

module.exports = { init, registerAgentHandlers, getIo: () => io };
