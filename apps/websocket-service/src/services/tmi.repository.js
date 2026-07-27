'use strict';
/*
 * tmi.repository.js — persistence for the execution layer.
 *
 * Three tables, and the split between them is deliberate:
 *   tmi_contracts  — one row per contract, its whole life. Never merged, never reused.
 *   tmi_actions    — append-only, timestamped. Every signal, fill, skip and block.
 *   tmi_config     — versioned rule sets. A change is a NEW ROW, never an UPDATE.
 *
 * tmi_actions is the reason any of this is learnable. Six weeks from now the only
 * question that matters is "why did it do that?", and it can only be answered if the
 * reason was written down at the time — including the reasons for the trades it did
 * NOT take, which are invisible everywhere else.
 *
 * tmi_config being append-only means every rule change is recoverable and attributable:
 * what changed, when, why, and what the replay said before it went live.
 */
const { pool } = require('@trading/shared');

const DDL = `
CREATE TABLE IF NOT EXISTS public.tmi_contracts (
  id bigserial PRIMARY KEY,
  trading_day date NOT NULL,
  symbol text NOT NULL,
  seq int NOT NULL,                      -- C1, C2, C3... per symbol per day
  status text NOT NULL,                  -- PENDING_BUY | HOLDING | PENDING_SELL | CLOSED
  mode text NOT NULL DEFAULT 'paper',    -- paper | live
  signal_minute int, signal_price numeric,
  shares int, target_fils numeric, stop_fils numeric,
  entry_reason text, entry_book jsonb,
  buy_price numeric, buy_minute int, buy_ts timestamptz,
  sell_price numeric, sell_minute int, sell_ts timestamptz,
  peak numeric, exit_reason text,
  gross_kd numeric, commission_kd numeric, net_kd numeric,
  config_version int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tmi_contracts_uq UNIQUE (trading_day, symbol, seq));
CREATE INDEX IF NOT EXISTS tmi_contracts_day_idx ON public.tmi_contracts (trading_day, symbol);

CREATE TABLE IF NOT EXISTS public.tmi_actions (
  id bigserial PRIMARY KEY,
  trading_day date NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  minute int,
  symbol text,
  contract_id bigint,
  event text NOT NULL,                   -- BUY_SIGNAL | BUY_FILL | SELL_SIGNAL | SELL_FILL | SKIP | BLOCK | NOMINATE
  price numeric, shares int, net_kd numeric,
  reason text,
  detail jsonb,                          -- target/stop/sizing/book at the moment of the decision
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS tmi_actions_day_idx ON public.tmi_actions (trading_day, ts);
CREATE INDEX IF NOT EXISTS tmi_actions_sym_idx ON public.tmi_actions (symbol, trading_day);

CREATE TABLE IF NOT EXISTS public.tmi_candidates (
  trading_day date NOT NULL,
  symbol text NOT NULL,
  first_minute int,                      -- when it FIRST qualified today
  last_minute int,                       -- when it LAST qualified today
  seen_count int NOT NULL DEFAULT 1,     -- how many ticks it qualified on
  price numeric,                         -- last known
  book jsonb,                            -- last known depth/spread/trades-per-min
  swing jsonb,
  reason text,
  classification jsonb,
  live boolean NOT NULL DEFAULT true,    -- was it still qualifying at the last tick
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trading_day, symbol));
CREATE INDEX IF NOT EXISTS tmi_candidates_day_idx ON public.tmi_candidates (trading_day, last_minute DESC);

CREATE TABLE IF NOT EXISTS public.tmi_config (
  version bigserial PRIMARY KEY,
  config jsonb NOT NULL,
  note text,                             -- why this change was made
  replay_result jsonb,                   -- what the harness said BEFORE it went live
  active boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS tmi_config_active_idx ON public.tmi_config (active, version DESC);
`;

let ready = false;
async function ensure(db = pool) {
  if (ready) return;
  await db.query(DDL);
  ready = true;
}

// ── config ────────────────────────────────────────────────────────────────
async function activeConfig(db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `SELECT version, config, note FROM public.tmi_config WHERE active ORDER BY version DESC LIMIT 1;`);
  return rows[0] || null;
}

/*
 * saveConfig — a change is a NEW VERSION, never an update in place. `replayResult` is
 * stored alongside so the ledger records what the harness predicted, which is the only
 * way to find out later whether the harness is any good at predicting.
 */
async function saveConfig(config, { note, replayResult, createdBy, activate = false } = {}, db = pool) {
  await ensure(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (activate) await client.query(`UPDATE public.tmi_config SET active = false WHERE active;`);
    const { rows } = await client.query(
      `INSERT INTO public.tmi_config (config, note, replay_result, active, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING version;`,
      [JSON.stringify(config), note || null, replayResult ? JSON.stringify(replayResult) : null, !!activate, createdBy || null]);
    await client.query('COMMIT');
    return rows[0].version;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function configHistory(limit = 50, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `SELECT version, note, replay_result, active, created_by, created_at
       FROM public.tmi_config ORDER BY version DESC LIMIT $1;`, [limit]);
  return rows;
}

// ── contracts ─────────────────────────────────────────────────────────────
async function upsertContract(c, tradingDay, mode, configVersion, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `INSERT INTO public.tmi_contracts
      (trading_day,symbol,seq,status,mode,signal_minute,signal_price,shares,target_fils,stop_fils,
       entry_reason,entry_book,buy_price,buy_minute,sell_price,sell_minute,peak,exit_reason,
       gross_kd,commission_kd,net_kd,config_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (trading_day, symbol, seq) DO UPDATE SET
       status=EXCLUDED.status, shares=EXCLUDED.shares, buy_price=EXCLUDED.buy_price,
       buy_minute=EXCLUDED.buy_minute, sell_price=EXCLUDED.sell_price, sell_minute=EXCLUDED.sell_minute,
       peak=EXCLUDED.peak, exit_reason=EXCLUDED.exit_reason, gross_kd=EXCLUDED.gross_kd,
       commission_kd=EXCLUDED.commission_kd, net_kd=EXCLUDED.net_kd, updated_at=now()
     RETURNING id;`,
    [tradingDay, c.symbol, c.seq, c.status, mode, c.signalMinute ?? null, c.signalPrice ?? null,
     c.shares ?? null, c.target ?? null, c.stop ?? null, c.entryReason ?? null,
     c.entryBook ? JSON.stringify(c.entryBook) : null, c.buyPrice ?? null, c.buyMinute ?? null,
     c.sellPrice ?? null, c.sellMinute ?? null, c.peak ?? null, c.exitReason ?? null,
     c.grossKd ?? null, c.commissionKd ?? null, c.netKd ?? null, configVersion ?? null]);
  return rows[0].id;
}

async function loadContracts(tradingDay, db = pool) {
  await ensure(db);
  // ::text on both sides - the same type-tolerance stock_quotes needed. A silent
  // zero-row result from a type mismatch is indistinguishable from "nothing traded",
  // and that ambiguity has already cost us a debugging session.
  const { rows } = await db.query(
    `SELECT * FROM public.tmi_contracts WHERE trading_day::text = $1 ORDER BY symbol, seq;`,
    [String(tradingDay)]);
  return rows;
}

/*
 * diagnoseContracts — has TMI ever actually recorded anything?
 *
 * Distinguishes three states that all look identical on screen:
 *   - the table is empty                -> TMI has never persisted a contract
 *   - rows exist for other days only    -> it worked once and stopped
 *   - rows exist for this day           -> the loader is at fault
 */
async function diagnoseContracts(tradingDay, db = pool) {
  await ensure(db);
  const q = async (sql, p) => (await db.query(sql, p).catch((e) => ({ rows: [{ error: e.message }] }))).rows;
  const out = { tradingDay };
  out.totalRows = (await q(`SELECT count(*)::int AS n FROM public.tmi_contracts;`))[0];
  out.byDay = await q(
    `SELECT trading_day::text AS day, mode, count(*)::int AS contracts,
            count(*) FILTER (WHERE status='CLOSED')::int AS closed,
            round(sum(net_kd)::numeric,2) AS net_kd,
            min(created_at) AS first_write, max(updated_at) AS last_write
       FROM public.tmi_contracts
      GROUP BY trading_day, mode ORDER BY trading_day DESC LIMIT 10;`);
  out.thisDay = (await q(
    `SELECT count(*)::int AS contracts FROM public.tmi_contracts WHERE trading_day::text = $1;`,
    [String(tradingDay)]))[0];
  out.actionsByDay = await q(
    `SELECT trading_day::text AS day, count(*)::int AS actions,
            count(*) FILTER (WHERE event='BUY_FILL')::int AS buys,
            count(*) FILTER (WHERE event='SELL_FILL')::int AS sells
       FROM public.tmi_actions GROUP BY trading_day ORDER BY trading_day DESC LIMIT 10;`);
  out.verdict = !out.totalRows || !out.totalRows.n
    ? 'tmi_contracts is EMPTY - TMI has never persisted a contract. The per-minute tick is probably not running.'
    : (out.thisDay && out.thisDay.contracts)
      ? `${out.thisDay.contracts} contracts recorded for ${tradingDay} - the loader is at fault, not the data.`
      : `nothing recorded for ${tradingDay}, but other days have rows - see byDay.`;
  return out;
}

// ── actions ───────────────────────────────────────────────────────────────
async function logAction(a, tradingDay, db = pool) {
  await ensure(db);
  await db.query(
    `INSERT INTO public.tmi_actions (trading_day,ts,minute,symbol,contract_id,event,price,shares,net_kd,reason,detail)
     VALUES ($1, COALESCE($2::timestamptz, now()), $3,$4,$5,$6,$7,$8,$9,$10,$11);`,
    [tradingDay, a.ts ?? null, a.minute ?? null, a.symbol ?? null, a.contractId ?? null,
     a.event, a.price ?? null, a.shares ?? null, a.netKd ?? null, a.reason ?? null,
     a.detail ? JSON.stringify(a.detail) : null]);
}

async function logActions(list, tradingDay, db = pool) {
  for (const a of list) await logAction(a, tradingDay, db);
}

async function loadActions(tradingDay, { symbol, limit = 2000 } = {}, db = pool) {
  await ensure(db);
  const params = [tradingDay];
  let sql = `SELECT * FROM public.tmi_actions WHERE trading_day = $1`;
  if (symbol) { params.push(symbol); sql += ` AND symbol = $${params.length}`; }
  params.push(limit);
  sql += ` ORDER BY ts ASC LIMIT $${params.length};`;
  const { rows } = await db.query(sql, params);
  return rows;
}

/*
 * upsertCandidates — persist the day's watchlist.
 *
 * The watchlist is not scratch state. It is the record of what the engine put in
 * front of you on a given day, and it has to be reviewable after the session, after
 * a restart, and months later when asking "what did we see that morning?".
 *
 * Held only in memory it survived neither a restart nor a look at yesterday, which
 * is exactly what a watchlist is for. Keyed (trading_day, symbol) so a tick is
 * idempotent; first_minute is never overwritten, so the moment a stock first
 * appeared is preserved even as everything else is refreshed.
 */
async function upsertCandidates(candidates, tradingDay, db = pool) {
  const list = Array.isArray(candidates) ? candidates : Object.values(candidates || {});
  if (!list.length) return 0;
  await ensure(db);
  let n = 0;
  for (const c of list) {
    await db.query(
      `INSERT INTO public.tmi_candidates
        (trading_day,symbol,first_minute,last_minute,seen_count,price,book,swing,reason,classification,live)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (trading_day, symbol) DO UPDATE SET
         last_minute=EXCLUDED.last_minute, seen_count=EXCLUDED.seen_count,
         price=COALESCE(EXCLUDED.price, public.tmi_candidates.price),
         book=COALESCE(EXCLUDED.book, public.tmi_candidates.book),
         swing=COALESCE(EXCLUDED.swing, public.tmi_candidates.swing),
         reason=EXCLUDED.reason, classification=COALESCE(EXCLUDED.classification, public.tmi_candidates.classification),
         live=EXCLUDED.live, updated_at=now();`,
      [tradingDay, c.symbol, c.firstMinute ?? null, c.lastMinute ?? null, c.seenCount ?? 1,
       c.price ?? null, c.book ? JSON.stringify(c.book) : null,
       c.swing ? JSON.stringify(c.swing) : null, c.reason ?? null,
       c.classification ? JSON.stringify(c.classification) : null, c.live !== false]);
    n++;
  }
  return n;
}

/* loadCandidates — rebuild the day's watchlist. Used on restart AND to review a past day. */
async function loadCandidates(tradingDay, db = pool) {
  await ensure(db);
  const { rows } = await db.query(
    `SELECT * FROM public.tmi_candidates WHERE trading_day::text = $1
      ORDER BY live DESC, last_minute DESC, symbol;`,
    [String(tradingDay)]);
  const out = {};
  for (const r of rows) {
    out[r.symbol] = {
      symbol: r.symbol,
      firstMinute: r.first_minute, lastMinute: r.last_minute,
      seenCount: r.seen_count, price: r.price == null ? null : Number(r.price),
      book: r.book || null, swing: r.swing || null, reason: r.reason,
      classification: r.classification || null, live: r.live,
    };
  }
  return out;
}

module.exports = { DDL, ensure, activeConfig, saveConfig, configHistory,
  upsertCandidates, loadCandidates,
  upsertContract, loadContracts, diagnoseContracts, logAction, logActions, loadActions };