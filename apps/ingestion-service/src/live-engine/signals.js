'use strict';
/* signals.js — per-stock live signal panel from the snapshot window (absolute).
 * Logged every cycle for tuning. Add a signal here and it flows through. */
const U = require('./lib/util');
const REG = {
  rvol:        (w) => { const l = w[w.length - 1]; return U.round2(U.ratio(l.volume, l.avgVolume)); },
  changePct:   (w) => U.round2((w[w.length - 1] || {}).changePct),
  velocity:    (w) => { const p = w.map(r => r.price).filter(U.isNum); const n = p.length; return n >= 2 ? U.round3(((p[n-1]-p[n-2]) / p[n-2]) * 100) : null; },
  acceleration:(w) => { const p = w.map(r => r.price).filter(U.isNum); const n = p.length; if (n<3) return null; const v1=(p[n-1]-p[n-2])/p[n-2]*100, v0=(p[n-2]-p[n-3])/p[n-3]*100; return U.round3(v1-v0); },
  upStreak:    (w) => { const p = w.map(r => r.price).filter(U.isNum); let s=0; for (let i=p.length-1;i>0;i--){ if (p[i]>p[i-1]) s++; else break; } return s; },
  breakout:    (w) => { const p = w.map(r => r.price).filter(U.isNum); const l = w[w.length-1]; return p.length>=3 && U.isNum(l.price) ? (l.price>=Math.max(...p)?1:0) : null; },
  valueTraded: (w) => { const l = w[w.length-1]; return U.isNum(l.volume)&&U.isNum(l.price) ? U.round1(l.volume*l.price) : null; },
  rangePos:    (w) => { const p = w.map(r => r.price).filter(U.isNum); const hi=Math.max(...p),lo=Math.min(...p),l=p[p.length-1]; return hi===lo?null:U.round1(((l-lo)/(hi-lo))*100); },
  price:       (w) => U.round1((w[w.length-1] || {}).price),
  volume:      (w) => (w[w.length-1] || {}).volume ?? null,
  avgVolume:   (w) => (w[w.length-1] || {}).avgVolume ?? null,
};
function buildPanel(window) {
  const panel = {};
  if (!window.length) return panel;
  for (const [k, fn] of Object.entries(REG)) { try { panel[k] = fn(window); } catch { panel[k] = null; } }
  return panel;
}
module.exports = { buildPanel, SIGNAL_NAMES: Object.keys(REG) };
