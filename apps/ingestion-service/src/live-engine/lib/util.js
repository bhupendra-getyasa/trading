'use strict';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const round1 = (x) => (isNum(x) ? Math.round(x * 10) / 10 : null);
const round2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);
const round3 = (x) => (isNum(x) ? Math.round(x * 1000) / 1000 : null);
const ratio = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? a / b : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function parseNum(v) {
  if (v == null || v === '') return null;
  const f = parseFloat(String(v).replace(/\u2212/g, '-').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(f) ? f : null;
}
function parseVolume(v) {
  if (v == null || v === '') return null;
  let s = String(v).trim().replace(/,/g, '');
  let mult = 1; const last = s.slice(-1).toLowerCase();
  if (last === 'k') { mult = 1e3; s = s.slice(0, -1); }
  else if (last === 'm') { mult = 1e6; s = s.slice(0, -1); }
  else if (last === 'b') { mult = 1e9; s = s.slice(0, -1); }
  const f = parseFloat(s.trim());
  return Number.isFinite(f) ? f * mult : null;
}
function tradingDay(now, offsetHours = 0) {
  return new Date(now + offsetHours * 3600000).toISOString().slice(0, 10);
}
function parseSnapshot(r) {
  return {
    symbol: r.symbol,
    price: parseNum(r.last_price),
    changePct: parseNum(r.change_percent),
    volume: parseVolume(r.volume),
    avgVolume: parseVolume(r.avg_volume),
    ts: toMs(r.created_at),
  };
}
// FIX: how much of the trading session has elapsed at ts (0..1).
// rvol must compare todays PARTIAL volume against the pro-rated average,
// not the FULL-day average - otherwise every stock looks thin in the morning.
// robust timestamp -> ms. Handles Date objects (pg), numbers, and
// postgres-ish strings like "2026-07-09 06:10:20.968+00" (offset without colon).
function toMs(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  let ms = Date.parse(v);
  if (!isNaN(ms)) return ms;
  const fixed = String(v).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  ms = Date.parse(fixed);
  return isNaN(ms) ? null : ms;
}

function sessionElapsedMin(ts, session) {
  const startMin = ((session?.openHour ?? 9) - (session?.tzOffsetHours ?? 3)) * 60;
  const ms = toMs(ts);
  if (ms == null) return null;
  const d = new Date(ms);
  return (d.getUTCHours() * 60 + d.getUTCMinutes()) - startMin;
}

function sessionFraction(ts, session) {
  const startMin = ((session?.openHour ?? 9) - (session?.tzOffsetHours ?? 3)) * 60;
  const totalMin = (((session?.closeHour ?? 13) - (session?.openHour ?? 9)) * 60) || 240;
  const ms = toMs(ts);
  if (ms == null) return 1;
  const d = new Date(ms);
  const elapsed = (d.getUTCHours() * 60 + d.getUTCMinutes()) - startMin;
  const frac = elapsed / totalMin;
  if (!isFinite(frac)) return 1;
  // floor at 3 minutes only (was 0.08 = ~19min, which badly understated early rvol)
  return Math.min(1, Math.max(3 / totalMin, frac));
}

module.exports = {
  sessionFraction, sessionElapsedMin, toMs, isNum, round1, round2, round3, ratio, clamp, parseNum, parseVolume, tradingDay, parseSnapshot };
