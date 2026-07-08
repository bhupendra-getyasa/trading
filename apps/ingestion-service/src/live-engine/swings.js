'use strict';
/*
 * swings.js — live swing + Fibonacci detection over a window of 1-minute prices.
 *
 * Model (matches the strategy):
 *   swing1  = the most recent up-move (low L -> high H) that clears minSwingFils
 *   pullback= the retrace after H; "held" if the pullback low sits in the Fib zone
 *   swing2  = price turning back up from the pullback low
 * Entry logic (radar) uses: firstSwingActive (still in swing1) vs secondSwingStarting.
 *
 * Prices in fils. `series` = parsed snapshots oldest -> newest. Config = config.SWING.
 */
const U = require('./lib/util');

// zigzag pivots with a minimum reversal; SEEDS the opening pivot correctly.
function findPivots(prices, rev) {
  const n = prices.length;
  if (n < 2) return [];
  const piv = [];
  let extIdx = 0, extPrice = prices[0], dir = 0;   // dir: 0 unknown, 1 up, -1 down
  for (let i = 1; i < n; i++) {
    const p = prices[i];
    if (dir === 0) {
      if (p - extPrice >= rev) { piv.push({ idx: extIdx, price: extPrice, kind: 'low' }); dir = 1; extIdx = i; extPrice = p; }
      else if (extPrice - p >= rev) { piv.push({ idx: extIdx, price: extPrice, kind: 'high' }); dir = -1; extIdx = i; extPrice = p; }
      // else: hold the opening reference until the first rev-sized move
    } else if (dir > 0) {
      if (p > extPrice) { extPrice = p; extIdx = i; }
      else if (extPrice - p >= rev) { piv.push({ idx: extIdx, price: extPrice, kind: 'high' }); dir = -1; extIdx = i; extPrice = p; }
    } else {
      if (p < extPrice) { extPrice = p; extIdx = i; }
      else if (p - extPrice >= rev) { piv.push({ idx: extIdx, price: extPrice, kind: 'low' }); dir = 1; extIdx = i; extPrice = p; }
    }
  }
  piv.push({ idx: extIdx, price: extPrice, kind: dir > 0 ? 'high' : dir < 0 ? 'low' : (extPrice >= prices[0] ? 'high' : 'low') });
  return piv;
}

function detectSwings(series, cfg) {
  const prices = series.map((s) => s.price).filter(U.isNum);
  const out = { swingCount: 0, swing1Fils: null, inPullback: false, pullbackHeldFib: false,
    secondSwingStarting: false, firstSwingActive: false, fib: null, lastPrice: prices[prices.length - 1] ?? null };
  if (prices.length < 3) return out;

  const piv = findPivots(prices, cfg.pivotReversalFils);
  const price = prices[prices.length - 1];

  // count up-swings that clear minSwingFils
  for (let i = 1; i < piv.length; i++)
    if (piv[i - 1].kind === 'low' && piv[i].kind === 'high' && piv[i].price - piv[i - 1].price >= cfg.minSwingFils) out.swingCount++;

  const precedingLow = (j) => { for (let k = j - 1; k >= 0; k--) if (piv[k].kind === 'low') return piv[k]; return null; };

  // Pass 1 — a COMPLETED swing1 (low L -> high H) that already has a pullback low after it.
  let L = null, H = null, pbLow = null;
  for (let j = piv.length - 1; j >= 1 && !H; j--) {
    if (piv[j].kind !== 'high') continue;
    const Lc = precedingLow(j);
    if (!Lc || piv[j].price - Lc.price < cfg.minSwingFils) continue;
    let pb = null;
    for (let m = j + 1; m < piv.length; m++) if (piv[m].kind === 'low') pb = piv[m];
    if (pb) { H = piv[j]; L = Lc; pbLow = pb; }
  }
  // Pass 2 — no completed pullback yet: latest high with a preceding low = first swing still active.
  let firstOnly = false;
  if (!H) {
    for (let j = piv.length - 1; j >= 1 && !H; j--) {
      if (piv[j].kind !== 'high') continue;
      const Lc = precedingLow(j);
      if (Lc && piv[j].price - Lc.price >= cfg.minSwingFils) { H = piv[j]; L = Lc; firstOnly = true; }
    }
  }
  if (!H) return out;

  const range = H.price - L.price;
  out.swing1Fils = U.round1(range);
  const fib = { low: L.price, high: H.price,
    f382: U.round1(H.price - range * 0.382), f500: U.round1(H.price - range * 0.5), f618: U.round1(H.price - range * 0.618),
    zoneHigh: U.round1(H.price - range * cfg.fibEntryLow), zoneLow: U.round1(H.price - range * cfg.fibEntryHigh) };
  out.fib = fib;

  if (firstOnly || !pbLow) {
    out.firstSwingActive = true;
    out.inPullback = price < H.price;
    out.pullbackHeldFib = price >= fib.zoneLow && price <= H.price;
  } else {
    out.inPullback = true;
    out.pullbackHeldFib = pbLow.price >= fib.zoneLow && pbLow.price <= fib.zoneHigh;   // held inside entry zone
    if (price > pbLow.price && out.pullbackHeldFib) out.secondSwingStarting = true;    // turning up = swing 2
  }
  return out;
}
module.exports = { detectSwings, findPivots };
