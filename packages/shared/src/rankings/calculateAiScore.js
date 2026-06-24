// ─────────────────────────────────────────────────────────────────────────────
//  calculateAiScore.js  — Kuwait Stock Exchange (KSE) Scoring Engine v6
//
//  Calibrated to real KSE market data (May–Jun 2026, 137 symbols, 3-day analysis).
//
//  SIGNALS & WEIGHTS (sum = 1.0):
//    Volume Explosion      22%  — today vol vs DB 20-day avg
//    Price Momentum        28%  — today's % change; negative day = 0
//    Near High             13%  — gradient proximity to 20d high
//    Price Trend           13%  — price vs 5/10/20 days ago
//    Green Day Ratio        9%  — % of last 20 days up
//    Relative Momentum      5%  — today's move ÷ stock's own typical move
//    Multi-Day Momentum    10%  — NEW: consecutive up days + accelerating moves
//
//  HARD RULES (applied before scoring):
//    • Negative today_pct      → score CAPPED at 45
//    • Zero volume             → score = 0
//    • Frozen price            → score = 0  (same price ≥18/20 days)
//    • Stale scrape artifact   → score = 0  (NEW: same % 3 days in a row)
//    • Illiquid stock          → score = 0  (NEW: value traded < 10,000 KWD)
//    • Already ran penalty     → NEW: score reduced if stock up >4% in first 30min
//
//  BONUS (added on top, capped at 100):
//    Liquidity     +1 to +12  — KWD value traded (price × volume)
//    Smart Money   +0 to +4   — volume building while price holds
//    Vol Momentum  +0 to +6   — NEW: volume accelerating (last30min > first30min)
//    Breakout      +0 to +5   — NEW: quiet then explode pattern (day3 breakout)
//
//  NEW LOGICS ADDED vs v5:
//  1. Multi-Day Momentum (10% weight) — rewards stocks up 2-3 days in a row
//     with each day's move getting bigger. NICBM/ASC pattern.
//  2. Stale Scrape Detector — same changePct 3 days in a row → score 0.
//     Catches DALQANRE/MASAKEN artifacts that slipped through frozen check.
//  3. Illiquid Hard Gate — value traded < 10,000 KWD fils → score 0.
//     Catches ALKOUT (5,760 shares) and TAMINV (450 shares).
//  4. Volume Direction Bonus — last 30min volume > first 30min = accelerating.
//     Rewards NICBM/ASC pattern, penalises CLEANING (fading volume).
//  5. Already-Ran Penalty — if stock already up >4% in first 30 min of session,
//     reduce score by 25 pts (entry risk too high for same-day trade).
//  6. Quiet-Then-Explode Breakout Bonus — flat/down 2 days then volume spike
//     today = day-3 breakout. Rewards PCEM pattern.
// ─────────────────────────────────────────────────────────────────────────────

const W = {
  volume:       0.22,
  momentum:     0.28,
  nearHigh:     0.13,
  priceTrend:   0.13,
  greenRatio:   0.09,
  relMoment:    0.05,
  multiDayMom:  0.10,   // NEW
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lerp(a, b, t) {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

function movingAverage(prices, n) {
  if (!prices || prices.length < n) return 0;
  return prices.slice(0, n).reduce((s, v) => s + v, 0) / n;
}

// ─── Signal scorers ───────────────────────────────────────────────────────────

/**
 * Volume Explosion (0-100)
 * Compares today's volume to the DB-computed 20-day average.
 */
function scoreVolume(ratio) {
  if (!ratio || ratio <= 0) return 0;
  if (ratio >= 4.0)  return 100;
  if (ratio >= 2.5)  return lerp(85, 100, (ratio - 2.5) / 1.5);
  if (ratio >= 1.5)  return lerp(60, 85,  (ratio - 1.5) / 1.0);
  if (ratio >= 1.0)  return lerp(30, 60,  (ratio - 1.0) / 0.5);
  if (ratio >= 0.5)  return lerp(10, 30,  (ratio - 0.5) / 0.5);
  return lerp(0, 10, ratio / 0.5);
}

/**
 * Price Momentum (0-100)
 * KSE calibration: median daily move 0.64%, so 1% is above-average.
 */
function scoreMomentum(pct) {
  if (pct <= 0)  return 0;
  if (pct >= 10) return 100;
  if (pct >= 5)  return lerp(85, 100, (pct - 5)  / 5);
  if (pct >= 3)  return lerp(65, 85,  (pct - 3)  / 2);
  if (pct >= 2)  return lerp(45, 65,  (pct - 2)  / 1);
  if (pct >= 1)  return lerp(20, 45,  (pct - 1)  / 1);
  return lerp(0, 20, pct / 1);
}

/**
 * Near High Score (0-100) with momentum recovery boost.
 */
function scoreNearHigh(price, high20d, todayPct) {
  if (!high20d || high20d <= 0) return 0;
  if (price >= high20d)         return 100;

  const gap = (high20d - price) / high20d * 100;
  let base;
  if      (gap <= 1)  base = lerp(80, 99,  (1  - gap) / 1);
  else if (gap <= 3)  base = lerp(55, 80,  (3  - gap) / 2);
  else if (gap <= 5)  base = lerp(30, 55,  (5  - gap) / 2);
  else if (gap <= 10) base = lerp(10, 30,  (10 - gap) / 5);
  else                base = lerp(0,  10,  Math.max(0, (20 - gap) / 10));

  if (todayPct >= 5) {
    base = Math.min(90, base + lerp(0, 30, (todayPct - 5) / 10));
  }
  return base;
}

/**
 * Price Trend Score (0-100)
 * Is today's price above where it was 5, 10, 20 days ago?
 */
function scorePriceTrend(prices, hasRichHistory) {
  if (!prices || prices.length < 2 || !hasRichHistory) return 0;
  const today = prices[0];
  let score = 0;
  for (const { days, weight } of [{ days: 5, weight: 50 }, { days: 10, weight: 30 }, { days: 20, weight: 20 }]) {
    if (prices.length > days && prices[days] > 0) {
      const g = (today - prices[days]) / prices[days] * 100;
      let c;
      if      (g >= 5)  c = 1.0;
      else if (g >= 3)  c = lerp(0.75, 1.0,  (g - 3) / 2);
      else if (g >= 1)  c = lerp(0.40, 0.75, (g - 1) / 2);
      else if (g >= 0)  c = lerp(0.10, 0.40,  g / 1);
      else if (g >= -2) c = lerp(0,    0.10,  (g + 2) / 2);
      else              c = 0;
      score += weight * c;
    }
  }
  return Math.min(100, score);
}

/**
 * Green Day Ratio (0-100)
 * KSE median green-day ratio is 35%.
 */
function scoreGreenRatio(prices, hasRichHistory) {
  if (!prices || prices.length < 3 || !hasRichHistory) return 0;
  const n = Math.min(20, prices.length - 1);
  const green = prices.slice(0, n).filter((p, i) => p > prices[i + 1]).length;
  const ratio = green / n;
  if (ratio >= 0.55) return lerp(80, 100, (ratio - 0.55) / 0.45);
  if (ratio >= 0.45) return lerp(55, 80,  (ratio - 0.45) / 0.10);
  if (ratio >= 0.35) return lerp(30, 55,  (ratio - 0.35) / 0.10);
  if (ratio >= 0.25) return lerp(10, 30,  (ratio - 0.25) / 0.10);
  return lerp(0, 10, ratio / 0.25);
}

/**
 * Relative Momentum (0-100)
 * Today's move ÷ this stock's own 20-day average daily move.
 */
function scoreRelMomentum(todayPct, prices, hasRichHistory) {
  if (todayPct <= 0 || !hasRichHistory) return 0;
  if (!prices || prices.length < 3) return 0;
  const n = Math.min(20, prices.length - 1);
  let total = 0, count = 0;
  for (let i = 0; i < n; i++) {
    if (prices[i + 1] > 0) { total += Math.abs((prices[i] - prices[i + 1]) / prices[i + 1] * 100); count++; }
  }
  if (!count || !total) return 0;
  const avgMove = total / count;
  if (avgMove < 0.05) return 0;
  const rel = todayPct / avgMove;
  if (rel >= 4)   return lerp(88, 100, (rel - 4) / 4);
  if (rel >= 2)   return lerp(65, 88,  (rel - 2) / 2);
  if (rel >= 1)   return lerp(35, 65,  (rel - 1) / 1);
  if (rel >= 0.5) return lerp(15, 35,  (rel - 0.5) / 0.5);
  return lerp(0, 15, rel / 0.5);
}

/**
 * NEW: Multi-Day Momentum Score (0-100)
 * Rewards stocks that are up multiple consecutive days with accelerating moves.
 * Uses recentDayChanges: array of daily % changes [today, yesterday, day before...]
 *
 * Scoring:
 *   3 days up, each day bigger than last → 100
 *   3 days up, flat acceleration         →  70
 *   2 days up, accelerating              →  60
 *   2 days up, flat                      →  40
 *   1 day up (today only)                →  10
 *   Any negative day in streak           →   0
 */
function scoreMultiDayMomentum(recentDayChanges) {
  if (!recentDayChanges || recentDayChanges.length < 2) return 0;

  const [d0, d1, d2] = recentDayChanges; // d0=today, d1=yesterday, d2=day before

  if (d0 <= 0) return 0; // today must be positive

  const twoDaysUp    = d1 > 0;
  const threeDaysUp  = d2 !== undefined && d2 > 0;

  // Acceleration: each day's move bigger than the previous
  const accel2 = twoDaysUp  && d0 > d1;
  const accel3 = threeDaysUp && d1 > d2 && d0 > d1;

  if (threeDaysUp && accel3) return lerp(80, 100, Math.min(1, d0 / 10));
  if (threeDaysUp)           return lerp(55, 80,  Math.min(1, d0 / 8));
  if (twoDaysUp   && accel2) return lerp(40, 65,  Math.min(1, d0 / 8));
  if (twoDaysUp)             return lerp(25, 45,  Math.min(1, d0 / 6));
  return lerp(5, 20, Math.min(1, d0 / 5)); // today up only
}

// ─── Bonuses ──────────────────────────────────────────────────────────────────

function liquidityBonus(price, volume) {
  const v = price * volume;
  if (v >= 500_000_000) return 12;
  if (v >= 100_000_000) return 10;
  if (v >= 10_000_000)  return 8;
  if (v >= 2_000_000)   return 6;
  if (v >= 500_000)     return 4;
  if (v >= 50_000)      return 2;
  if (v > 0)            return 1;
  return 0;
}

function smartMoneyBonus(historyRows) {
  if (!historyRows || historyRows.length < 5) return 0;
  const recent = [...historyRows.slice(0, 5)].reverse();
  let volUp = 0, priceOk = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1].volume > 0 && recent[i].volume > recent[i - 1].volume) volUp++;
    if (recent[i - 1].price  > 0 && recent[i].price  >= recent[i - 1].price * 0.99) priceOk++;
  }
  if (volUp >= 3 && priceOk >= 3) return 4;
  if (volUp >= 2) return 2;
  return 0;
}

/**
 * NEW: Volume Direction Bonus (0-6)
 * Rewards stocks where volume is ACCELERATING during the session.
 * last30minVol > first30minVol means buyers are increasing, not fading.
 * NICBM/ASC pattern = +6. CLEANING (fading) = 0.
 *
 * @param {number} first30minVol  — max volume seen in first 30 min of session
 * @param {number} last30minVol   — max volume seen in last 30 min of session
 */
function volumeDirectionBonus(first30minVol, last30minVol) {
  if (!first30minVol || first30minVol <= 0) return 0;
  const ratio = last30minVol / first30minVol;
  if (ratio >= 2.0) return 6;
  if (ratio >= 1.5) return 4;
  if (ratio >= 1.1) return 2;
  return 0;
}

/**
 * NEW: Quiet-Then-Explode Breakout Bonus (0-5)
 * Stock was flat/down last 2 days, today volume spikes with positive move.
 * PCEM pattern: -1.4%, +0.35%, today +1.72% with 3x volume.
 *
 * @param {number[]} recentDayChanges  — [today, yesterday, dayBefore]
 * @param {number}   volRatio          — today vol vs 20d avg
 */
function breakoutBonus(recentDayChanges, volRatio) {
  if (!recentDayChanges || recentDayChanges.length < 3) return 0;
  const [d0, d1, d2] = recentDayChanges;
  const wasQuiet  = Math.abs(d1) <= 1.0 && Math.abs(d2) <= 1.0;
  const todayUp   = d0 > 0;
  const volSpike  = volRatio >= 2.0;
  if (wasQuiet && todayUp && volSpike) return 5;
  if (wasQuiet && todayUp && volRatio >= 1.5) return 3;
  return 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * @param {object}   stock             — normalizeStock() output
 * @param {Array}    historyRows       — [{price, volume, changePct}] newest-first (from DB)
 * @param {object}   [intradayData]    — NEW: optional intraday signals
 * @param {number}   intradayData.first30minVol   — volume in first 30 min of session
 * @param {number}   intradayData.last30minVol    — volume in last 30 min of session
 * @param {number}   intradayData.intradayMovePct — price move % in first 30 min
 * @param {number[]} intradayData.recentDayChanges — [today%, yesterday%, dayBefore%]
 * @returns {{ total, breakdown, dbVolRatio }}
 */
function calculateAiScore(stock, historyRows = [], intradayData = {}) {
  const price     = stock.price          || 0;
  const volume    = stock.volume         || 0;
  const changePct = stock.percent_change || 0;

  const {
    first30minVol    = 0,
    last30minVol     = 0,
    intradayMovePct  = 0,
    recentDayChanges = [],
  } = intradayData;

  // ── Hard rule: zero volume or zero price → AVOID ─────────────────────────
  if (volume <= 0 || price <= 0) {
    return _zeroScore(historyRows.length, 'zero_volume');
  }

  // ── NEW Hard rule: minimum liquidity gate ────────────────────────────────
  // Value traded must be > 10,000 KWD fils to be tradeable same day.
  // Catches ALKOUT (5,760 shares × 892 fils) and TAMINV (450 shares).
  const valueTraded = price * volume;
  if (valueTraded < 10_000_000) {  // 10,000 KWD in fils (price is in fils)
    return _zeroScore(historyRows.length, 'illiquid');
  }

  const prices = historyRows.map(r => r.price  || 0);
  const vols   = historyRows.map(r => r.volume || 0);

  // ── Frozen stock detection: same price ≥18/20 days → score 0 ─────────────
  const prev20Prices = prices.slice(0, 20).filter(p => p > 0);
  const uniquePrices = new Set(prev20Prices.map(p => Math.round(p * 100))).size;
  if (prev20Prices.length >= 10 && uniquePrices <= 2) {
    return _zeroScore(historyRows.length, 'frozen_price');
  }

  // ── NEW: Stale scrape artifact detection ─────────────────────────────────
  // DALQANRE/MASAKEN show identical changePct 3 days in a row — stale data.
  // If recentDayChanges has 3 values and all are the same non-zero number → fake.
  if (recentDayChanges.length >= 3) {
    const [d0, d1, d2] = recentDayChanges;
    const allSame = d0 !== 0 && Math.abs(d0 - d1) < 0.01 && Math.abs(d1 - d2) < 0.01;
    if (allSame) {
      return _zeroScore(historyRows.length, 'stale_scrape');
    }
  }

  // ── Assess data richness ─────────────────────────────────────────────────
  const uniquePrices20  = new Set(prices.slice(0, 20).filter(p => p > 0).map(p => Math.round(p * 100))).size;
  const hasRichHistory  = historyRows.length >= 8 && uniquePrices20 >= 5;

  // ── DB 20-day volume average (excluding today) ───────────────────────────
  const hist20Vols = vols.slice(1, 21).filter(v => v > 0);
  const db20Avg    = hist20Vols.length >= 5
    ? hist20Vols.reduce((s, v) => s + v, 0) / hist20Vols.length
    : (stock.avg_volume || 0);
  const volRatio   = db20Avg > 0 ? volume / db20Avg : (stock.volume_ratio || 0);

  // ── 20-day high (excluding today) ────────────────────────────────────────
  const prev20  = prices.slice(1, 21).filter(p => p > 0);
  const high20d = prev20.length > 0 ? Math.max(...prev20) : 0;

  // ── Score each signal ────────────────────────────────────────────────────
  const volScore   = scoreVolume(volRatio);
  const momScore   = scoreMomentum(changePct);
  const nhScore    = scoreNearHigh(price, high20d, changePct);
  const ptScore    = scorePriceTrend(prices, hasRichHistory);
  const grScore    = scoreGreenRatio(prices, hasRichHistory);
  const rmScore    = scoreRelMomentum(changePct, prices, hasRichHistory);
  const mdScore    = scoreMultiDayMomentum(recentDayChanges);   // NEW

  // ── Bonuses ──────────────────────────────────────────────────────────────
  const liqB    = liquidityBonus(price, volume);
  const smB     = smartMoneyBonus(historyRows);
  const volDirB = volumeDirectionBonus(first30minVol, last30minVol);   // NEW
  const brkB    = breakoutBonus(recentDayChanges, volRatio);           // NEW

  const base =
    volScore  * W.volume      +
    momScore  * W.momentum    +
    nhScore   * W.nearHigh    +
    ptScore   * W.priceTrend  +
    grScore   * W.greenRatio  +
    rmScore   * W.relMoment   +
    mdScore   * W.multiDayMom; // NEW

  let total = Math.round(Math.min(100, Math.max(0, base + liqB + smB + volDirB + brkB)));

  // ── Hard rule: negative day → cap at 45 ──────────────────────────────────
  if (changePct < 0) {
    total = Math.min(45, total);
  }

  // ── NEW: Already-ran penalty ─────────────────────────────────────────────
  // If stock already moved >4% in first 30 min → entry risk too high for same-day.
  // CLEANING was +7.6% by first snapshot. By 9:30 the move is done.
  if (intradayMovePct > 4) {
    total = Math.max(0, total - 25);
  }

  // ── Stability % (for breakdown display) ──────────────────────────────────
  const n = Math.min(20, prices.length - 1);
  let greenDays = 0;
  for (let i = 0; i < n; i++) if (prices[i] > prices[i + 1]) greenDays++;
  const stabilityPct = n > 0 ? Math.round((greenDays / n) * 100) : 0;

  return {
    total,
    dbVolRatio: +volRatio.toFixed(2),
    breakdown: {
      volumeScore:        Math.round(volScore),
      momentumScore:      Math.round(momScore),
      nearHighScore:      Math.round(nhScore),
      priceTrendScore:    Math.round(ptScore),
      greenRatioScore:    Math.round(grScore),
      relMomentumScore:   Math.round(rmScore),
      multiDayMomScore:   Math.round(mdScore),    // NEW
      liquidityBonus:     liqB,
      smartMoneyBonus:    smB,
      volumeDirectionBonus: volDirB,              // NEW
      breakoutBonus:      brkB,                   // NEW
      volumeRatio:        +volRatio.toFixed(2),
      db20dAvgVol:        Math.round(db20Avg),
      isBreakout:         price > 0 && high20d > 0 && price >= high20d,
      high20d:            +high20d.toFixed(3),
      ma20:               +movingAverage(prices, 20).toFixed(3),
      stabilityPct,
      valueTraded:        Math.round(valueTraded),
      historyDays:        historyRows.length,
      hasRichHistory,
      // Intraday signals in breakdown
      intradayMovePct:    +intradayMovePct.toFixed(2),
      alreadyRanPenalty:  intradayMovePct > 4,    // NEW
      recentDayChanges:   recentDayChanges.slice(0, 3),
    },
  };
}

// ── Helper: return a zero score with reason ───────────────────────────────────
function _zeroScore(historyDays, reason) {
  return {
    total: 0,
    dbVolRatio: 0,
    breakdown: {
      volumeScore: 0, momentumScore: 0, nearHighScore: 0,
      priceTrendScore: 0, greenRatioScore: 0, relMomentumScore: 0,
      multiDayMomScore: 0, liquidityBonus: 0, smartMoneyBonus: 0,
      volumeDirectionBonus: 0, breakoutBonus: 0,
      volumeRatio: 0, db20dAvgVol: 0, isBreakout: false,
      high20d: 0, ma20: 0, stabilityPct: 0, valueTraded: 0,
      historyDays, hasRichHistory: false,
      zeroReason: reason,
    },
  };
}

module.exports = {
  calculateAiScore,
  scoreVolume, scoreMomentum, scoreNearHigh,
  scorePriceTrend, scoreGreenRatio, scoreRelMomentum,
  scoreMultiDayMomentum,
  liquidityBonus, smartMoneyBonus, volumeDirectionBonus, breakoutBonus,
  movingAverage,
};
