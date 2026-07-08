'use strict';
/*
 * sizing.js — a SUGGESTION only. NEVER hides or filters a stock.
 * Returns suggested shares/contracts/KD and a tag.
 *
 * Bug 6 fix: the min-lot floor must NOT override the risk cap or the exit-safety
 * (volume) cap. If the min tradable lot is bigger than either cap allows, we do NOT
 * silently size up to it and call it TRADABLE — we flag it so the user decides.
 *
 * Tags: TRADABLE | OVER-BUDGET | OVER-RISK | ILLIQUID-CAP | TOO-EXPENSIVE
 *   TOO-EXPENSIVE : expected move can't beat commission
 *   OVER-BUDGET   : position costs more KD than the budget
 *   OVER-RISK     : min lot exceeds the profile risk% cap (too much money at risk)
 *   ILLIQUID-CAP  : min lot exceeds the exit-safety volume cap (can't exit cleanly)
 */
const U = require('./lib/util');

function commissionFilsPerShare(shares, price, cfg) {
  if (cfg.mode === 'fixed') return cfg.filsPerShare;
  // percentage per side with a KD minimum; price in fils -> trade value in KD = shares*price/1000
  const tradeKd = (shares * price) / 1000;
  const perSideKd = Math.max(cfg.minKdPerSide, cfg.pctPerSide * tradeKd);
  const roundTripKd = 2 * perSideKd;
  return (roundTripKd * 1000) / shares;   // -> fils per share
}

function suggest({ profile, price, volume, avgVolume, tradableSwings, targetFils, lane }, budgetKd, sizingCfg, commissionCfg) {
  const risk = sizingCfg.riskPctByProfile[profile] ?? 0.05;
  const est_roundtrips = Math.max(1, Math.round(tradableSwings ?? 1));   // estimation only (revolving = TMI's job)
  const sharesByBudget = budgetKd != null ? (budgetKd * risk * 1000) / price : Infinity; // risk% cap
  const volForCap = (avgVolume && avgVolume > 0) ? avgVolume : volume;                    // exit safety on TYPICAL daily volume, not intraday-so-far
  const sharesByVolume = sizingCfg.volumeCapPct * volForCap;

  // round a share count down to a valid lot: multiples of lotSize, or the minLot (half lot)
  const toLot = (n) => n >= sizingCfg.lotSize ? Math.floor(n / sizingCfg.lotSize) * sizingCfg.lotSize
                     : n >= sizingCfg.minLot ? sizingCfg.minLot : 0;

  // WILD / Lane B — Finding 7: opportunistic, illiquid, hard tiny cap, always warned
  if (profile === 'WILD' || lane === 'B') {
    const raw = Math.min(sizingCfg.wildMaxShares, sharesByVolume, sharesByBudget);
    let shares = Math.floor(raw / sizingCfg.wildLotSize) * sizingCfg.wildLotSize;
    if (shares < sizingCfg.wildLotSize) shares = sizingCfg.wildLotSize;
    const comm = U.round2(commissionFilsPerShare(shares, price, commissionCfg));
    return { suggested_shares: shares, est_roundtrips, kd_needed: U.round1((shares * price) / 1000),
      commission_fils_per_share: comm, tag: (targetFils ?? 0) > comm ? 'ILLIQUID-TINY' : 'TOO-EXPENSIVE' };
  }

  const shares = toLot(Math.min(sharesByBudget, sharesByVolume));  // clean size within all caps

  let shownShares = shares > 0 ? shares : sizingCfg.minLot;
  const commPerShare = U.round2(commissionFilsPerShare(shownShares, price, commissionCfg));
  const clearsCommission = (targetFils ?? 0) > commPerShare;
  let tag = 'TRADABLE';
  if (!clearsCommission) {
    tag = 'TOO-EXPENSIVE'; shownShares = sizingCfg.minLot;
  } else if (shares === 0) {
    // even one min-lot breaches a cap -> flag which; never size up silently past a cap
    shownShares = sizingCfg.minLot;
    if (sizingCfg.minLot > sharesByVolume) tag = 'ILLIQUID-CAP';       // can't exit a full lot
    else if (sizingCfg.minLot > sharesByBudget) tag = 'OVER-RISK';     // a lot exceeds risk% cap
    else tag = 'OVER-BUDGET';
  }
  const kdNeeded = U.round1((shownShares * price) / 1000);
  if (tag === 'TRADABLE' && budgetKd != null && kdNeeded > budgetKd) tag = 'OVER-BUDGET';

  return { suggested_shares: shownShares, est_roundtrips, kd_needed: kdNeeded,
    commission_fils_per_share: commPerShare, tag };
}
module.exports = { suggest, commissionFilsPerShare };
