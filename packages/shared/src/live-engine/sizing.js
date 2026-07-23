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

function suggest({ profile, price, volume, avgVolume, tradableSwings, targetFils, lane, book }, budgetKd, sizingCfg, commissionCfg) {
  const risk = sizingCfg.riskPctByProfile[profile] ?? 0.05;
  const est_roundtrips = Math.max(1, Math.round(tradableSwings ?? 1));   // estimation only (revolving = TMI's job)
  // FIX: a missing budget must never delete the risk cap (that silently sized to the exit cap)
  const effBudgetKd = (budgetKd != null && budgetKd > 0) ? budgetKd : (sizingCfg.defaultBudgetKd ?? null);
  const sharesByBudget = effBudgetKd != null ? (effBudgetKd * risk * 1000) / price : Infinity; // risk% cap
  const volForCap = (avgVolume && avgVolume > 0) ? avgVolume : volume;                    // exit safety on TYPICAL daily volume, not intraday-so-far
  const sharesByVolumeCap = sizingCfg.volumeCapPct * volForCap;
  // EXIT SAFETY, book version. Daily volume is a proxy for "could I get out?"; the resting
  // bid is the direct measurement of it. ASC 14-Jul is the case: 0.5% of its daily volume
  // allowed a size its 726-share median bid could never absorb. Both caps are returned so
  // the replay harness can compare them on recorded data.
  const bookDepth = book && book.medBidQty != null && !book.stale ? book.medBidQty : null;
  const sharesByBookCap = bookDepth != null ? bookDepth * (sizingCfg.bookDepthPct ?? 0.5) : null;
  const usingBook = !!(sizingCfg.useBookDepth && sharesByBookCap != null);
  // fall back to the volume proxy whenever the book is unknown — never size unconstrained
  const sharesByVolume = usingBook ? sharesByBookCap : sharesByVolumeCap;

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
      commission_fils_per_share: comm, tag: (targetFils ?? 0) > comm ? 'ILLIQUID-TINY' : 'TOO-EXPENSIVE',
      shares_by_volume_cap: Math.round(sharesByVolumeCap), shares_by_book_cap: sharesByBookCap != null ? Math.round(sharesByBookCap) : null,
      cap_source: usingBook ? 'book' : 'volume' };
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
    if (sizingCfg.minLot > sharesByVolume) tag = usingBook ? 'THIN-BOOK-CAP' : 'ILLIQUID-CAP';   // can't exit a full lot
    else if (sizingCfg.minLot > sharesByBudget) tag = 'OVER-RISK';     // a lot exceeds risk% cap
    else tag = 'OVER-BUDGET';
  }
  const kdNeeded = U.round1((shownShares * price) / 1000);
  if (tag === 'TRADABLE' && effBudgetKd != null && kdNeeded > effBudgetKd) tag = 'OVER-BUDGET';

  return { suggested_shares: shownShares, est_roundtrips, kd_needed: kdNeeded,
    commission_fils_per_share: commPerShare, tag,
    shares_by_volume_cap: Math.round(sharesByVolumeCap),
    shares_by_book_cap: sharesByBookCap != null ? Math.round(sharesByBookCap) : null,
    cap_source: usingBook ? 'book' : 'volume' };
}
module.exports = { suggest, commissionFilsPerShare };
