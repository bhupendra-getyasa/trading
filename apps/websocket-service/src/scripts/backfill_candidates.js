#!/usr/bin/env node
'use strict';
/*
 * backfill_candidates.js — reconstruct past watchlists from opportunity_list.
 *
 * WHY
 * ---
 * tmi_candidates only starts filling from the first session AFTER the watchlist code
 * is deployed. Every day before that has an empty watchlist, including days you were
 * actually watching stocks — today included.
 *
 * But the Live Engine has been recording every nomination in opportunity_list all
 * along: symbol, trading_day, trigger_ts, detected_ts, entry_price, profile, lane,
 * status. That is enough to rebuild what the watching zone WOULD have shown, so past
 * days become reviewable instead of blank.
 *
 * WHAT IT IS AND IS NOT
 * ---------------------
 * This is a RECONSTRUCTION, not a recording. It is built from the nominations the
 * engine persisted, not from the live frames the UI actually rendered. It should match
 * closely — both come from the same nomination step — but a stock that appeared on
 * screen without producing an opportunity_list row will not appear here.
 *
 * Every backfilled row is therefore marked in `reason` as reconstructed, so nobody
 * later mistakes it for a live recording. Days that already have real rows are skipped
 * unless --force is passed; a reconstruction must never overwrite a recording.
 *
 * USAGE
 *   node backfill_candidates.js                       # last 30 days
 *   node backfill_candidates.js --days 90
 *   node backfill_candidates.js --day 2026-07-27      # one specific day
 *   node backfill_candidates.js --dry                 # show, write nothing
 *   node backfill_candidates.js --force               # overwrite existing rows
 */
const { pool } = require('@trading/shared/src/db/postgres');

const OPPS = process.env.OPPS_TABLE || 'public.opportunity_list';
const OPEN_HOUR = Number(process.env.SESSION_OPEN_HOUR || 9);
const TZ_OFFSET = Number(process.env.SESSION_TZ_OFFSET || 3);   // Asia/Kuwait

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : (process.argv[i + 1] || true);
}
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

/** timestamptz -> session minute (0 = 09:00 Kuwait). */
function sessionMinute(ts) {
  if (!ts) return null;
  const k = new Date(new Date(ts).getTime() + TZ_OFFSET * 3600000);
  return (k.getUTCHours() - OPEN_HOUR) * 60 + k.getUTCMinutes();
}

async function daysToDo() {
  const one = arg('day');
  if (one && one !== true) return [String(one)];
  const n = Number(arg('days', 30));
  const { rows } = await pool.query(
    `SELECT DISTINCT trading_day::text AS d
       FROM ${OPPS}
      WHERE trading_day >= (current_date - $1::int)
      ORDER BY d;`, [n]);
  return rows.map((r) => r.d);
}

async function backfillDay(day) {
  const existing = await pool.query(
    `SELECT count(*)::int AS n FROM public.tmi_candidates WHERE trading_day::text = $1;`, [day]);
  if (existing.rows[0].n > 0 && !FORCE) {
    return { day, skipped: true, existing: existing.rows[0].n };
  }

  // One row per symbol per day: first and last nomination, and how many there were.
  const { rows } = await pool.query(
    `SELECT symbol,
            min(COALESCE(detected_ts, trigger_ts)) AS first_ts,
            max(COALESCE(triggered_ts, trigger_ts)) AS last_ts,
            count(*)::int                          AS n,
            (array_agg(entry_price ORDER BY trigger_ts DESC))[1]  AS price,
            (array_agg(profile     ORDER BY trigger_ts DESC))[1]  AS profile,
            (array_agg(lane        ORDER BY trigger_ts DESC))[1]  AS lane,
            (array_agg(trend       ORDER BY trigger_ts DESC))[1]  AS trend,
            (array_agg(book        ORDER BY trigger_ts DESC))[1]  AS book,
            (array_agg(status      ORDER BY trigger_ts DESC))[1]  AS status
       FROM ${OPPS}
      WHERE trading_day::text = $1
      GROUP BY symbol
      ORDER BY symbol;`, [day]);

  if (!rows.length) return { day, none: true };
  if (DRY) return { day, would: rows.length, symbols: rows.map((r) => r.symbol) };

  let n = 0;
  for (const r of rows) {
    await pool.query(
      `INSERT INTO public.tmi_candidates
        (trading_day,symbol,first_minute,last_minute,seen_count,price,book,reason,classification,live)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false)
       ON CONFLICT (trading_day, symbol) DO UPDATE SET
         first_minute=LEAST(public.tmi_candidates.first_minute, EXCLUDED.first_minute),
         last_minute=GREATEST(public.tmi_candidates.last_minute, EXCLUDED.last_minute),
         seen_count=GREATEST(public.tmi_candidates.seen_count, EXCLUDED.seen_count),
         price=COALESCE(public.tmi_candidates.price, EXCLUDED.price),
         book=COALESCE(public.tmi_candidates.book, EXCLUDED.book),
         updated_at=now();`,
      [day, r.symbol, sessionMinute(r.first_ts), sessionMinute(r.last_ts), r.n,
       r.price, r.book ? JSON.stringify(r.book) : null,
       'reconstructed from opportunity_list',
       JSON.stringify({ profile: r.profile, lane: r.lane, trend: r.trend, status: r.status })]);
    n++;
  }
  return { day, written: n };
}

(async () => {
  const days = await daysToDo();
  if (!days.length) { console.log('no days found in ' + OPPS); process.exit(0); }
  console.log(`${DRY ? 'DRY RUN — ' : ''}backfilling ${days.length} day(s)${FORCE ? ' (FORCE)' : ''}\n`);
  let total = 0;
  for (const d of days) {
    const r = await backfillDay(d);
    if (r.skipped)      console.log(`  ${d}  skipped — ${r.existing} real rows already (use --force to overwrite)`);
    else if (r.none)    console.log(`  ${d}  no nominations`);
    else if (r.would)   console.log(`  ${d}  would write ${r.would}: ${r.symbols.join(', ')}`);
    else              { console.log(`  ${d}  wrote ${r.written}`); total += r.written; }
  }
  console.log(`\n${DRY ? 'would write' : 'wrote'} ${total} candidate rows`);
  console.log('Backfilled rows are marked live=false and reason="reconstructed from opportunity_list".');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
