'use strict';
/* demo.js — pure pipeline, no DB. Simulates one stock forming a 2nd-swing setup.
 * Shows: swing detection -> radar (Gate 1) -> History validate (Gate 2) -> sizing. */
const { scanCycle } = require('./engine');
const { suggest } = require('./sizing');
const CONFIG = require('./config');

const T0 = Date.parse('2026-06-30T09:20:00+03:00');
const iso = (m) => new Date(T0 - m * 60000).toISOString();
// ACICO ~459 fils: rise 455->465 (swing1 +10), pullback to 459 (~50% hold), turning up (swing2)
const acico = [455,457,460,463,465,463,461,459,460,462].map((p, i, arr) => ({
  symbol: 'ACICO', last_price: String(p), change_percent: String((((p-455)/455)*100).toFixed(2)),
  volume: '2.0 M', avg_volume: '1.4 M', created_at: iso(arr.length - 1 - i) }));
// ZAIN flat -> no swing
const zain = [500,500,499,500,500,500,500].map((p,i,arr)=>({ symbol:'ZAIN', last_price:String(p),
  change_percent:'0', volume:'1.0 M', avg_volume:'1.0 M', created_at: iso(arr.length-1-i) }));

const windows = new Map([['ACICO', acico], ['ZAIN', zain]]);
const classifications = new Map([
  ['ACICO', { profile: 'SWING', trend: 'STABLE', lane: 'A' }],
  ['ZAIN',  { profile: 'MARGINAL', trend: 'STABLE', lane: '-' }],
]);
// stub History (real one reads stock_classification)
const history = { ACICO: { profile:'SWING', trend:'STABLE', lane:'A', target_fils:4, tradable_swings:6, qualifies:true },
                  ZAIN:  { profile:'MARGINAL', trend:'STABLE', lane:'-', qualifies:false } };

const out = scanCycle({ windows, classifications, processedToday: new Set(), now: T0 });
console.log(CONFIG.VERSION, '· trading day', out.tradingDay, '\n');
for (const r of out.radar) {
  const why = r.reasons.map(x => x.signal).join(', ') || '—';
  console.log(`${r.symbol.padEnd(6)} inRadar=${String(r.inRadar).padEnd(5)} entry=${String(r.entry).padEnd(6)} swings=${r.swingCount} swing1=${r.swing1Fils} [${why}]`);
}
console.log('\nGate 2 — History validation + sizing (budget 2000 KD):');
for (const sym of out.toValidate) {
  const h = history[sym];
  const qualifies = h.qualifies && CONFIG.HISTORY.qualifyLanes.includes(h.lane) && !CONFIG.HISTORY.blockTrends.includes(h.trend);
  if (!qualifies) { console.log(`  ${sym}: rejected by History`); continue; }
  const panel = out.panels.find(p => p.symbol === sym);
  const s = suggest({ profile:h.profile, price:panel.price, volume:panel.volume, tradableSwings:h.tradable_swings, targetFils:h.target_fils }, 2000, CONFIG.SIZING, CONFIG.COMMISSION);
  console.log(`  ${sym}: QUALIFIES → ${h.profile}/${h.trend} · buy ~${s.suggested_shares} sh · ~${s.est_roundtrips} round-trips · ${s.kd_needed} KD · [${s.tag}]`);
}
