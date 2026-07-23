'use strict';
/*
 * radar.js — Gate 1. Decides if a stock is forming a TRADABLE live setup right now.
 * Combines: (a) "alive" signal gate (RVOL/change%) and (b) swing/Fib structure.
 * Entry timing: second-swing by default; a WARMING SWING may take the first swing.
 * All thresholds from config.RADAR / config.SWING. Records WHY it fired.
 */
const U = require('./lib/util');
const { evaluateLiquidity } = require('./liquidity');

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
    // Confirm-then-act is preserved: secondSwingStarting already means the turn-up is
    // confirmed above the pullback low. We ONLY add a chase gate here — if the confirmation
    // has already carried price past the top of the entry zone (by more than entryTolFils),
    // the good part of the move is gone, so we SKIP rather than enter at the peak.
    if (swing.secondSwingStarting && swing.pullbackHeldFib) {
      const priceNow = (panel && panel.price != null) ? panel.price : swing.lastPrice;
      const zoneTop = swing.fib ? swing.fib.zoneHigh : null;
      const tol = sw.entryTolFils ?? 2;
      const chased = zoneTop != null && priceNow != null && priceNow > zoneTop + tol;
      if (!chased) {
        structureOk = true; entry = 'second';
        reasons.push({ signal: 'secondSwing', actual: swing.swing1Fils, priceNow, zoneTop });
      } else {
        // confirmed, but price already ran past the zone -> do not chase the peak
        reasons.push({ signal: 'secondSwing_skip_chase', priceNow, zoneTop, tol, over: U.round1(priceNow - zoneTop) });
      }
    }
  }
  // Gate 1b — order book. Evaluated ONLY when the structure already fired, so the
  // recorded verdict always describes a stock we would otherwise have taken (that is
  // the population whose thresholds we need to validate). In 'warn' mode liq.blocked
  // is always false and inRadar is unchanged: measurement without behaviour change.
  const liq = evaluateLiquidity(opts.book, { shares: opts.intendedShares }, opts.liquidityCfg || {});
  if (liq.reasons.length) reasons.push(...liq.reasons);
  const inRadar = a.ok && structureOk && !liq.blocked;

  return { inRadar, alive: a.ok, structureOk, entry, reasons,
    swingCount: swing.swingCount, swing1Fils: swing.swing1Fils, fib: swing.fib,
    liquidity: { pass: liq.pass, blocked: liq.blocked, skipped: liq.skipped || null, checks: liq.checks } };
}
module.exports = { evaluateRadar, alive };