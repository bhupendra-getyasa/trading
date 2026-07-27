'use strict';
/*
 * classification.js — the profile/lane/trend RULES (used by the History daily step).
 * All thresholds in CLASSIFY — PROVISIONAL, tune from data.
 *
 * CHANGES from testing (see BUG_LOG.md):
 *  - Finding 7: DEAD now means "does not move" (low hit3) ONLY. A stock that MOVES
 *    a lot but has tiny volume is WILD (Lane B, tiny size), NOT DEAD.
 *  - Finding 5 + ALIMTIAZ: SCALP renamed WATCH; high-volume small-swing stocks are
 *    kept (not DEAD), but only if they actually move sometimes (hit3 >= watchMinHit3).
 *
 * Input `m` = median metrics for a window:
 *   { price, volume, target, win, tradableSwings, hit3, hit5 }
 */
const COMMISSION = require('./commission');

const CLASSIFY = {
  // commissionFils REMOVED (27-Jul). It was a flat 2 fils/share applied to every
  // stock regardless of price, and it was used in THREE places: net_fils, the
  // MARGINAL test, and the SWING test. Real KSE commission is a PERCENTAGE, so
  // true cost is ~0.003 x price fils/share. Break-even is 667 fils — below that
  // the flat model overcharged (6.7x too harsh at 100f), above it undercharged.
  //
  // The damage was not cosmetic. `target < 2` returned MARGINAL, so cheap stocks
  // were rejected for a cost they never paid. On 26-Jul that rejected KFIC
  // (133f, real commission 0.40f) and KHOT (212f, real 0.64f). KHOT was the best
  // available trade of the day. 44% of all stock-days sat pinned at the 2f floor.
  //
  // Cost now comes from commission.js, which is price-, segment- and date-aware.
  // Pass a `costFn` into classifyProfile to override it (tests, replay).
  deadHit3: 20,                 // Finding 7: DEAD only if it barely moves (hit3 < this)
  wildWin: 10, wildHit5: 65, wildThinVol: 300000, wildThinWin: 12, wildThinHit5: 60,
  wildIlliquidVol: 50000,       // Finding 7: high-hit3 but volume under this => WILD (illiquid), not DEAD
  runnerTarget: 6, runnerWin: 10, runnerLiquidVol: 1000000,
  watchMinVolume: 1000000,      // WATCH: liquid...
  watchMaxTarget: 3,            // ...but small normal swing (< 3 fils)...
  watchMinHit3: 25,             // ...and actually pops sometimes (ALIMTIAZ 6% stays DEAD; KFH 35% => WATCH)
  swingHit3: 65, swingWin: 12, swingNet: 1, swingVol: 300000,
};
const RANK = { RUNNER: 0, SWING: 1, WATCH: 2, WILD: 3, MARGINAL: 4, DEAD: 5 };

/**
 * Round-trip commission in fils/share for a stock being classified.
 * Price-dependent, as reality is. Falls back to the real percentage formula if
 * no config is supplied so a caller can never accidentally get a flat number.
 *
 * @param {number} priceFils
 * @param {object} [opts]  { cfg: config.COMMISSION, market, day, referenceNotionalKd }
 */
function commissionFilsFor(priceFils, opts) {
  if (priceFils == null || priceFils <= 0) return 0;
  if (opts && opts.cfg) {
    return COMMISSION.referenceRoundTripFils(priceFils, opts);
  }
  // Safety net: Main Market percentage model, no schedule available.
  // 15 bps/side round trip = 0.003 x price fils/share. NEVER a flat constant.
  return 0.003 * priceFils;
}

/**
 * @param {object} m     median metrics { price, volume, target, win, tradableSwings, hit3, hit5 }
 * @param {object} C     thresholds (CLASSIFY)
 * @param {object} [opts] { cfg: config.COMMISSION, market, day, referenceNotionalKd }
 *                        Supply cfg so cost is date- and segment-accurate. Without it
 *                        the percentage fallback is used — still price-dependent.
 */
function classifyProfile(m, C = CLASSIFY, opts = undefined) {
  const { price, volume, target, win, tradableSwings, hit3, hit5 } = m;
  if (price == null) return 'DEAD';
  const commissionFils = commissionFilsFor(price, opts);
  const net = (target ?? 0) - commissionFils;

  // 1) TRULY DEAD = does not move (Finding 7: volume alone no longer kills it)
  if ((hit3 ?? 0) < C.deadHit3) return 'DEAD';

  // 2) WILD-ILLIQUID = moves a lot (hit3 ok) but volume too thin to trade normally (GINS)
  if ((volume ?? 0) < C.wildIlliquidVol) return 'WILD';

  // 3) can't even clear commission on a normal day — now measured against the REAL
  //    price-dependent cost, not a flat 2 fils. This is the line that wrongly
  //    rejected KFIC and KHOT on 26-Jul.
  if ((target ?? 0) < commissionFils) return 'MARGINAL';

  // 4) WILD = big erratic moves, poor reliability / thin
  if ((win ?? 0) < C.wildWin && (hit5 ?? 0) >= C.wildHit5) return 'WILD';
  if ((volume ?? 0) < C.wildThinVol && (hit5 ?? 0) >= C.wildThinHit5 && (win ?? 0) < C.wildThinWin) return 'WILD';

  // 5) RUNNER = few big clean swings
  if ((target ?? 0) >= C.runnerTarget && (win ?? 0) >= C.runnerWin) return 'RUNNER';

  // 6) WATCH = liquid, small normal swing, but pops sometimes (was SCALP). Movement floor via hit3.
  if ((volume ?? 0) >= C.watchMinVolume && (target ?? 0) < C.watchMaxTarget && (hit3 ?? 0) >= C.watchMinHit3) return 'WATCH';

  // 7) SWING = the core: clean 3-5 fil swings, reliable, liquid enough to exit
  if ((hit3 ?? 0) >= C.swingHit3 && (win ?? 0) >= C.swingWin && net >= C.swingNet && (volume ?? 0) >= C.swingVol) return 'SWING';

  return 'MARGINAL';
}

function classifyLane(profile, volume, C = CLASSIFY) {
  if (profile === 'SWING') return 'A';
  if (profile === 'WATCH') return 'A';                 // liquid; watch line lives in Lane A tooling
  if (profile === 'RUNNER') return (volume ?? 0) >= C.runnerLiquidVol ? 'A' : 'B';
  if (profile === 'WILD') return 'B';                  // Finding 7: wild-illiquid => Lane B, tiny size
  return '-';
}

function classifyTrend(profile3m, profile1m) {
  const a = RANK[profile1m], b = RANK[profile3m];
  if (a == null || b == null) return 'STABLE';
  if (a < b) return 'WARMING';
  if (a > b) return 'COOLING';
  return 'STABLE';
}

module.exports = { classifyProfile, classifyLane, classifyTrend, commissionFilsFor, CLASSIFY, RANK };
