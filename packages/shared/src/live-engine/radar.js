'use strict';
/*
 * radar.js — Gate 1. Decides if a stock is forming a TRADABLE live setup right now.
 * Combines: (a) "alive" signal gate (RVOL/change%) and (b) swing/Fib structure.
 * Entry timing: second-swing by default; a WARMING SWING may take the first swing.
 * All thresholds from config.RADAR / config.SWING. Records WHY it fired.
 */
const U = require('./lib/util');

function alive(panel, cfg) {
  const fired = [];
  if (cfg.minRvol != null && (panel.rvol ?? 0) >= cfg.minRvol) fired.push({ signal: 'rvol', v: cfg.minRvol, actual: panel.rvol });
  if (cfg.minChangePct != null && (panel.changePct ?? -Infinity) > cfg.minChangePct) fired.push({ signal: 'changePct', v: cfg.minChangePct, actual: panel.changePct });
  let ok;
  if (cfg.combine === 'OR') ok = fired.length > 0;
  else if (cfg.combine === 'NofM') ok = fired.length >= (cfg.minMatch || 1);
  else ok = fired.length >= 2; // AND of the two provisional conditions
  return { ok: cfg.requireAlive ? ok : true, fired };
}

// entryAllowed: profile/trend from History decides whether first-swing is allowed
function evaluateRadar(panel, swing, sw, radarCfg, opts = {}) {
  const a = alive(panel, radarCfg);
  const reasons = [...a.fired];
  let structureOk = false, entry = null;

  const warming = opts.trend === 'WARMING' && opts.profile === 'SWING';
  const wantSecond = sw.defaultEntry === 'second';

  if (sw.defaultEntry === 'first' || (warming && sw.firstSwingIfWarming)) {
    if (swing.firstSwingActive && (swing.swing1Fils ?? 0) >= sw.minSwingFils) { structureOk = true; entry = 'first'; reasons.push({ signal: 'firstSwing', actual: swing.swing1Fils }); }
  }
  if (!structureOk && (wantSecond || warming)) {
    if (swing.secondSwingStarting && swing.pullbackHeldFib) { structureOk = true; entry = 'second'; reasons.push({ signal: 'secondSwing', actual: swing.swing1Fils }); }
  }
  return { inRadar: a.ok && structureOk, alive: a.ok, structureOk, entry, reasons, swingCount: swing.swingCount, swing1Fils: swing.swing1Fils, fib: swing.fib };
}
module.exports = { evaluateRadar, alive };
