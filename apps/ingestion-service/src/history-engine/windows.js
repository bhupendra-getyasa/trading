'use strict';
/*
 * windows.js — time-window helpers for the history engine.
 *
 * The engine (runHistoryEngine) is window-agnostic: it scores whatever daily
 * rows it is given, cross-sectionally across the universe. So "score last week"
 * is a DATA-SELECTION step, not an engine change. This module turns the loaded
 * daily rows into named windows; runHistoryScoring runs the engine once per
 * window and stamps each result with the window name.
 *
 * Market-specific choices (Boursa Kuwait trades Sunday–Thursday):
 *   - Week starts on SUNDAY (Date.getUTCDay() returns 0 for Sunday).
 *   - The whole window set is anchored to the LATEST TRADING DAY present in the
 *     data, not to wall-clock "today". Running on a Fri/Sat/holiday then still
 *     yields sensible windows, and "yesterday" = last real trading day.
 *
 * trade_date arrives as 'YYYY-MM-DD' text (repository sets pg type parser for
 * DATE/OID 1082), so lexical string comparison is a valid date comparison.
 */

// ---- date string helpers (all UTC, all 'YYYY-MM-DD') ----------------------
function toUTC(s) { return new Date(`${s}T00:00:00Z`); }
function ymd(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = toUTC(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function startOfWeekSunday(s) { return addDays(s, -toUTC(s).getUTCDay()); } // Sunday
function startOfMonth(s) { return `${s.slice(0, 7)}-01`; }

// distinct trade_dates present in the data, ascending
function distinctDates(rows) {
  return [...new Set(rows.map((r) => r.trade_date).filter(Boolean))].sort();
}

/*
 * Build the default window set. Each window is { name, from, to } with
 * INCLUSIVE 'YYYY-MM-DD' bounds. Pass opts.refDate to pin the anchor, or
 * opts.only (array of names) to run a subset.
 */
function buildWindows(rows, opts = {}) {
  const dates = distinctDates(rows);
  if (!dates.length) return [];

  const ref = opts.refDate || dates[dates.length - 1];            // latest trading day
  const prevTradingDay = [...dates].reverse().find((d) => d < ref) || ref;

  const curWeekStart  = startOfWeekSunday(ref);
  const lastWeekStart = addDays(curWeekStart, -7);
  const lastWeekEnd   = addDays(curWeekStart, -1);                // Sat; only Sun–Thu carry data
  const curMonthStart = startOfMonth(ref);
  const lastMonthEnd  = addDays(curMonthStart, -1);
  const lastMonthStart = startOfMonth(lastMonthEnd);

  const defs = [
    { name: 'all',           from: dates[0],          to: ref },
    { name: 'current_month', from: curMonthStart,     to: ref },
    { name: 'last_month',    from: lastMonthStart,    to: lastMonthEnd },
    { name: 'current_week',  from: curWeekStart,      to: ref },
    { name: 'last_week',     from: lastWeekStart,     to: lastWeekEnd },
    { name: 'last_30d',      from: addDays(ref, -29), to: ref },
    { name: 'last_7d',       from: addDays(ref, -6),  to: ref },
    { name: 'yesterday',     from: prevTradingDay,    to: prevTradingDay },
    { name: 'latest_day',    from: ref,               to: ref },
  ];

  const wanted = opts.only && new Set(opts.only);
  return defs.filter((w) => !wanted || wanted.has(w.name));
}

// inclusive lexical slice (trade_date is 'YYYY-MM-DD' text)
function sliceWindow(rows, w) {
  return rows.filter((r) => r.trade_date >= w.from && r.trade_date <= w.to);
}

module.exports = { buildWindows, sliceWindow, distinctDates };