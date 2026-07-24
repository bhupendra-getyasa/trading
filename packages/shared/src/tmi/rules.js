'use strict';
/*
 * rules.js — the individual decisions, each isolated and pure so it can be tested
 * and replaced on its own. engine.js orchestrates them; nothing here knows about
 * state, IO, or time beyond the minute index it is handed.
 *
 * Every function returns a REASON alongside its verdict. A decision the UI cannot
 * explain is a decision we cannot audit later, and the whole learning loop runs on
 * being able to ask "why did it do that?" three weeks afterwards.
 */

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/*
 * sessionSwings — up-swings in the session-so-far price path, zigzag with a minimum
 * reversal. Used for the target. Reads ONLY prices up to now; nothing here can see
 * the future, which is what made the old "% of the day's full range" rule invalid
 * as a live rule.
 */
function sessionSwings(prices, reversalFils = 2) {
  if (!prices || prices.length < 3) return [];
  const piv = [];
  let ext = prices[0], dir = 0;
  for (let i = 1; i < prices.length; i++) {
    const p = prices[i];
    if (dir === 0) {
      if (p - ext >= reversalFils) { piv.push(['L', ext]); dir = 1; ext = p; }
      else if (ext - p >= reversalFils) { piv.push(['H', ext]); dir = -1; ext = p; }
    } else if (dir > 0) {
      if (p > ext) ext = p;
      else if (ext - p >= reversalFils) { piv.push(['H', ext]); dir = -1; ext = p; }
    } else {
      if (p < ext) ext = p;
      else if (p - ext >= reversalFils) { piv.push(['L', ext]); dir = 1; ext = p; }
    }
  }
  piv.push([dir > 0 ? 'H' : 'L', ext]);
  const ups = [];
  for (let i = 1; i < piv.length; i++) {
    if (piv[i - 1][0] === 'L' && piv[i][0] === 'H') ups.push(piv[i][1] - piv[i - 1][1]);
  }
  return ups;
}

/*
 * computeTarget — how far we expect this stock to actually travel.
 *
 * The history table's target_fils averages EVERY swing including 2-3f noise, which
 * understated real tradable moves by 2-4x (ALDEERA: history 3.2f, actual 15.0f;
 * OULAFUEL 2.1f vs 9.0f). Averaging only swings >= 5f measures the moves you can
 * actually trade. Falls back when the session has not produced enough of them yet.
 */
function computeTarget(sessionPrices, cfg) {
  const fb = cfg.EXIT.targetFallbackFils;
  if (cfg.EXIT.targetMethod !== 'avg_swing_5f') return { target: fb, reason: 'fallback:method' };
  const ups = sessionSwings(sessionPrices).filter((u) => u >= 5);
  if (ups.length < 2) return { target: fb, reason: `fallback:only_${ups.length}_swings>=5f` };
  const avg = ups.reduce((a, b) => a + b, 0) / ups.length;
  return { target: Math.max(fb, Math.round(avg)), reason: `avg of ${ups.length} swings>=5f` };
}

/*
 * computeStop — CURRENTLY THE WEAKEST RULE IN THE SYSTEM. Kept honest rather than
 * quietly patched.
 *
 * "15% of range" was derived from ASC on 16-Jul (54f range -> 8f stop, which turned
 * −58.7 into +34.3) and then failed twice on fresh data: RASIYAT 19-Jul got a 3f
 * stop and was shaken out three times; EMIRATES 20-Jul got 4f and took two −80 KD
 * stops. It is a fitted number wearing a formula.
 *
 * Two changes from the version that failed:
 *  - range is SESSION-TO-DATE (broker high/low so far), not the completed day's
 *    range, which was unknowable at the moment of entry — the old version was
 *    quietly using look-ahead.
 *  - stopMaxFils caps the absolute loss. The two −80 stops were large size times a
 *    stop that scaled upward with nothing to stop it.
 * Replacement candidates (ATR, prior-day range) go through the harness first.
 */
function computeStop(sessionRangeFils, cfg, price) {
  const c = cfg.EXIT;
  if (c.stopMethod !== 'session_range_pct') return { stop: c.stopMinFils, reason: 'fallback:method' };
  const byRange = sessionRangeFils != null ? sessionRangeFils * c.stopRangePct : 0;
  const byPrice = price != null && c.stopPricePct ? price * c.stopPricePct : 0;
  const raw = Math.max(byRange, byPrice);
  const stop = Math.min(c.stopMaxFils, Math.max(c.stopMinFils, Math.round(raw)));
  const src = byPrice > byRange ? `${(c.stopPricePct * 100).toFixed(1)}% of ${round1(price)}f price`
                                : `${Math.round(c.stopRangePct * 100)}% of ${round1(sessionRangeFils)}f range`;
  const capped = stop !== Math.round(raw);
  return { stop, reason: `${src}${capped ? ' (capped)' : ''}` };
}

/*
 * computeShares — the book decides, not the budget.
 * min(what the slice affords, what the resting bid can absorb). The bid is the
 * exit; taking more than half of it means the last part of the position moves the
 * price against you on the way out.
 */
function computeShares({ price, sliceKd, book }, cfg) {
  if (!price || price <= 0) return { shares: 0, reason: 'no_price' };
  const byBudget = (sliceKd * 1000) / price;
  const depth = book && book.medBidQty != null && !book.stale ? book.medBidQty : null;
  const byBook = depth != null ? depth * cfg.SIZING.bookDepthPct : null;
  const raw = byBook != null ? Math.min(byBudget, byBook) : byBudget;
  const lot = cfg.SIZING.lotSize;
  const shares = Math.floor(raw / lot) * lot;
  const bound = byBook != null && byBook < byBudget ? 'book' : 'budget';
  if (shares < cfg.SIZING.minLot) {
    return { shares: 0, reason: `below_min_lot (${bound}-bound: ${Math.round(raw)})`, bound };
  }
  return { shares, reason: `${bound}-bound`, bound, byBudget: Math.round(byBudget), byBook: byBook != null ? Math.round(byBook) : null };
}

/*
 * canEnter — the entry gate. Order matters: the cheapest and most decisive checks
 * first, so the reason returned is the one a human would give.
 */
function canEnter({ stock, sym, minute, openCount, cfg, slotCap }) {
  if (stock.status === 'BLOCKED') return { ok: false, reason: `blocked:${stock.blockedReason}` };
  const cap = slotCap != null ? slotCap : cfg.SELECTION.maxConcurrentStocks;
  if (openCount >= cap) return { ok: false, reason: 'at_max_stocks' };
  if (stock.banUntilMinute != null && minute < stock.banUntilMinute) {
    return { ok: false, reason: `fail_ban until m${stock.banUntilMinute}` };
  }
  if (cfg.SELECTION.requireRadarQualified && !sym.radarQualified) {
    return { ok: false, reason: 'not_radar_qualified' };
  }
  if (cfg.ENTRY.requireLiquidityPass && sym.liquidityPass === false) {
    return { ok: false, reason: 'liquidity_fail' };
  }
  if (!sym.entrySignal) return { ok: false, reason: 'no_signal' };

  // ANTI-CHASE. The single highest-value rule found so far: on 20-Jul the engine
  // sold the top of a swing and instantly re-bought that same top, five times.
  // Those self-inflicted re-entries were the entire difference between −2.3 KD and
  // +57.5 KD on the day.
  if (stock.lastSell) {
    const since = minute - stock.lastSell.minute;
    if (since < cfg.REENTRY.cooldownMinutes) return { ok: false, reason: `cooldown ${since}/${cfg.REENTRY.cooldownMinutes}m` };
    if (sym.price > stock.lastSell.price - cfg.REENTRY.minDipFils) {
      return { ok: false, reason: `no_dip (needs <= ${stock.lastSell.price - cfg.REENTRY.minDipFils}f)` };
    }
  }
  // don't chase past the signalled entry
  if (sym.entryPrice != null && sym.price > sym.entryPrice + cfg.ENTRY.maxChaseFils) {
    return { ok: false, reason: `chased (${round1(sym.price - sym.entryPrice)}f past entry)` };
  }
  return { ok: true, reason: sym.entryReason || 'signal' };
}

/*
 * shouldExit — evaluated every minute on an open position.
 * Priority: stop (capital first) > quiet tape > trail. Quiet outranks trail because
 * its whole purpose is to get out BEFORE the trail's give-back is spent on a move
 * that has already died.
 */
function shouldExit({ contract, sym, cfg, minute }) {
  const price = sym.price;
  if (price == null) return null;
  const buy = contract.buyPrice;

  if (price <= buy - contract.stop) {
    return { sell: buy - contract.stop, reason: 'STOP' };
  }
  // TIME EXIT — a position that has not made progress in this long is dead money AND a
  // blocked slot. Checked before quiet/trail because those can never fire on a flat tape.
  if (cfg.EXIT.maxHoldMinutes != null && minute != null && contract.buyMinute != null) {
    const held = minute - contract.buyMinute;
    const progress = (contract.peak ?? buy) - buy;
    if (held >= cfg.EXIT.maxHoldMinutes && progress < (cfg.EXIT.minProgressFils ?? 0)) {
      return { sell: price, reason: 'TIME' };
    }
  }
  // QUIET TAPE — no trades means no move. Sell while green rather than drift into
  // the stop. OULAFUEL 16-Jul: this rule alone swung one contract by 81 KD.
  const tpm = sym.book ? sym.book.tradesPerMin : null;
  if (tpm != null && tpm <= cfg.EXIT.quietMaxTradesPerMin) {
    if (contract.quietRun + 1 >= cfg.EXIT.quietMinutes && price > buy) {
      return { sell: price, reason: 'QUIET' };
    }
  }
  const peak = Math.max(contract.peak ?? buy, price);
  if (peak - buy >= contract.target && price <= peak - cfg.EXIT.trailGiveBackFils) {
    return { sell: price, reason: 'TRAIL' };
  }
  return null;
}

module.exports = { sessionSwings, computeTarget, computeStop, computeShares, canEnter, shouldExit };

/*
 * detectReentry — TMI's OWN entry signal for contracts 2, 3, 4...
 *
 * The radar fires ONCE per symbol per day (runScanner marks it processed after
 * Gate 2), so it is a NOMINATION, not a repeating trigger. Everything after the
 * first contract is TMI's decision — which is precisely the hand-off the two-engine
 * split was designed around: Live Engine says WHICH, TMI says WHEN, every time
 * after the first.
 *
 * Signal = price pulled back at least dipFils from the recent high, then ticked up.
 * Deliberately the same shape as the original strategy (buy the dip, not the top),
 * and it composes with canEnter()'s anti-chase check rather than replacing it.
 */
function detectReentry(sessionPrices, cfg, lookback = 20) {
  const n = sessionPrices.length;
  if (n < 3) return null;
  const w = sessionPrices.slice(Math.max(0, n - lookback));
  const price = w[w.length - 1];
  const prev = w[w.length - 2];
  if (price <= prev) return null;                       // must be ticking up
  const high = Math.max(...w);
  const low = Math.min(...w.slice(w.indexOf(high)));    // low AFTER the high
  const dip = high - low;
  if (dip < cfg.REENTRY.minDipFils) return null;
  if (price > low + Math.max(2, cfg.REENTRY.minDipFils)) return null;  // still near the low
  return { price, reason: `dip ${round1(dip)}f from ${round1(high)}, turning up` };
}

module.exports.detectReentry = detectReentry;

/*
 * passesEntryFilters — the config gates that apply to EVERY entry, whatever produced
 * the signal.
 *
 * Extracted because it was already wrong once: the radar-nomination path skipped these
 * checks entirely, so noTradeBeforeMinute and the swing band silently applied only to
 * re-entries — never to the FIRST entry on a stock, which is most of them. The sweep
 * results for those two filters were meaningless until this was fixed. One function,
 * called from both paths, so they cannot diverge again.
 */
function passesEntryFilters({ minute, swing1Fils, cfg }) {
  if (cfg.SELECTION.noTradeBeforeMinute && minute < cfg.SELECTION.noTradeBeforeMinute) {
    return { ok: false, reason: `before_minute_${cfg.SELECTION.noTradeBeforeMinute}` };
  }
  const s1 = swing1Fils ?? null;
  if (cfg.ENTRY.minSwing1Fils && (s1 == null || s1 < cfg.ENTRY.minSwing1Fils)) {
    return { ok: false, reason: `swing1 ${s1}f < ${cfg.ENTRY.minSwing1Fils}f` };
  }
  if (cfg.ENTRY.maxSwing1Fils && s1 != null && s1 > cfg.ENTRY.maxSwing1Fils) {
    return { ok: false, reason: `swing1 ${s1}f > ${cfg.ENTRY.maxSwing1Fils}f` };
  }
  return { ok: true };
}
module.exports.passesEntryFilters = passesEntryFilters;
