'use strict';
/*
 * History Scoring Engine — v2  (JavaScript / Node)
 * =================================================
 * Port of the Python v2 engine. Answers one question using HISTORY ONLY
 * (no live market data):
 *
 *     "Based on the last ~3 months, how good is this stock for intraday trading?"
 *
 * Pipeline:
 *   daily metrics + 1-minute bars
 *     -> clean, convert fils -> % of price, derive metrics
 *     -> recency-weighted aggregate per stock per metric
 *     -> 5 base scores (Liquidity, Opportunity, Probability, Risk/Safety, Execution)
 *     -> x Consistency multiplier  = FINAL HISTORY SCORE (0-100, ranked)
 *     -> + Confidence label (High/Med/Low): trust indicator, does NOT affect rank
 *
 * Everything tunable lives in the CONFIG block. No magic numbers in the logic.
 *
 * Core functions (runHistoryEngine, etc.) are pure — they take arrays of row
 * objects, so they run in the browser too. The CLI at the bottom is the only
 * part that touches the filesystem.
 */


// ==========================================================================
// CONFIG  — tune everything here.
// ==========================================================================
const PRICE_REF = 'day_open';

// fils-denominated columns -> converted to % of price before scoring
const FILS_METRICS = [
  'day_range', 'largest_bull_swing', 'largest_bear_swing', 'avg_swing_size',
  'auto_target_fils', 'avg_profit_fib', 'avg_loss_fib', 'oc_margin',
];

// Recency weighting: [mostRecentNDays, weight]; null = "everything older".
// Weights renormalise per stock if some tiers have no data.
const RECENCY_TIERS = [[10, 0.50], [20, 0.30], [null, 0.20]];

// metric -> [weight, direction, transform]
//   direction: +1 higher better / -1 lower better ;  transform: 'log' | 'raw'
const SCORES = {
  liquidity: {
    total_volume:         [5, +1, 'log'],
    avg_vol_min:          [5, +1, 'log'],
    vol_spike_count:      [4, +1, 'raw'],
    highest_volume:       [3, +1, 'log'],
    buyer_pct:            [4, +1, 'raw'],
    liq_stability:        [4, +1, 'raw'],   // intraday volume stability
  },
  opportunity: {
    tradable_bull_swings: [5, +1, 'raw'],
    largest_bull_swing:   [5, +1, 'raw'],   // % of price
    avg_swing_size:       [5, +1, 'raw'],   // % of price
    swing_efficiency:     [5, +1, 'raw'],   // tradable / bull
    bull_swings:          [4, +1, 'raw'],
    day_range:            [4, +1, 'raw'],   // % of price
    total_swings:         [3, +1, 'raw'],
  },
  probability: {
    fib_win_pct:          [5, +1, 'raw'],
    successful_fib:       [4, +1, 'raw'],
    longest_bull_run:     [4, +1, 'raw'],
    avg_profit_fib:       [4, +1, 'raw'],   // % of price
    auto_target_fils:     [2, +1, 'raw'],   // % of price; down-weighted
  },
  risk: { // high score = SAFE
    largest_bear_swing:   [5, -1, 'raw'],
    avg_loss_fib:         [5, -1, 'raw'],
    bear_swings:          [4, -1, 'raw'],
    longest_bear_run:     [4, -1, 'raw'],
    oc_margin:            [3, +1, 'raw'],
  },
  execution: {
    execution_margin:     [5, +1, 'raw'],   // time_btwn - time_to_target
    avg_vol_min:          [3, +1, 'log'],
  },
};

// between-score weights — change freely to retune the blend
const BASE_BLEND = {
  liquidity: 1, opportunity: 1, probability: 1, risk: 1, execution: 1,
};

const MULT_FLOOR = 0.70;            // consistency multiplier floor
const LADDER_PCT = [0.5, 1.0, 2.0]; // price-relative reach ladder (% of price)

// Confidence indicator thresholds (data trust — does NOT affect ranking)
const CONF_HIGH = { minDays: 80, minCompleteness: 0.95, minActive: 0.70 };
const CONF_MED  = { minDays: 40, minCompleteness: 0.85, minActive: 0.50 };

// columns that are NOT numeric (everything else gets coerced to a number)
const STRING_COLS = new Set([
  'symbol', 'trade_date', 'best_earning_time', 'created_at', 'updated_at',
]);

// ==========================================================================
// STATS HELPERS
// ==========================================================================
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function median(arr) {
  const a = arr.filter(isNum).sort((x, y) => x - y);
  const n = a.length;
  if (n === 0) return null;
  const m = n >> 1;
  return n % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// numpy-style linear-interpolation percentile; expects a SORTED numeric array
function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank), frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

// IQR / |median| — outlier-resistant coefficient of variation
function robustCV(arr) {
  const a = arr.filter(isNum);
  if (a.length < 3) return null;
  const med = median(a);
  if (med === 0) return null;
  const s = a.slice().sort((x, y) => x - y);
  const q1 = percentile(s, 25), q3 = percentile(s, 75);
  return (q3 - q1) / Math.abs(med);
}

// pandas rank(pct=True)*100 with average-rank ties; nulls stay null
function pctRank(values) {
  const idx = values.map((v, i) => [v, i]).filter((p) => isNum(p[0]));
  const n = idx.length;
  const out = values.map(() => null);
  if (n === 0) return out;
  idx.sort((a, b) => a[0] - b[0]);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const avgRank = ((i + 1) + (j + 1)) / 2; // average of 1-based positions
    for (let k = i; k <= j; k++) out[idx[k][1]] = (avgRank / n) * 100;
    i = j + 1;
  }
  return out;
}

const round1 = (x) => (isNum(x) ? Math.round(x * 10) / 10 : null);

// ==========================================================================
// PARSING
// ==========================================================================
function parseVolume(v) {
  if (v == null || v === '') return null;
  let s = String(v).trim().replace(/,/g, '');
  let mult = 1;
  const last = s.slice(-1).toLowerCase();
  if (last === 'k') { mult = 1e3; s = s.slice(0, -1); }
  else if (last === 'm') { mult = 1e6; s = s.slice(0, -1); }
  else if (last === 'b') { mult = 1e9; s = s.slice(0, -1); }
  const f = parseFloat(s.trim());
  return Number.isFinite(f) ? f * mult : null;
}

// minimal CSV parser (handles quoted fields with embedded commas)
function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, k) => [h, r[k]])));
}

function coerceNumeric(rows) {
  return rows.map((r) => {
    const o = {};
    for (const k in r) {
      if (STRING_COLS.has(k)) { o[k] = r[k]; }
      else { const f = parseFloat(r[k]); o[k] = Number.isFinite(f) ? f : null; }
    }
    return o;
  });
}

// ==========================================================================
// DERIVED: intraday liquidity stability  (needs minute bars)
// ==========================================================================
function intradayStability(minuteRows) {
  const groups = new Map(); // `${sym}|${date}` -> [volumes]
  for (const m of minuteRows) {
    const sym = m.symbol;
    const date = String(m.created_at).slice(0, 10);
    const vol = parseVolume(m.volume);
    if (vol == null) continue;
    const key = `${sym}|${date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(vol);
  }
  const out = new Map(); // key -> stability 0..100
  for (const [key, vols] of groups) {
    if (vols.length < 5) continue;
    const mu = vols.reduce((a, b) => a + b, 0) / vols.length;
    if (mu <= 0) continue;
    const variance = vols.reduce((a, b) => a + (b - mu) ** 2, 0) / (vols.length - 1);
    const cv = Math.sqrt(variance) / mu;
    out.set(key, Math.max(0, Math.min(1, 1 - cv)) * 100);
  }
  return out;
}

// ==========================================================================
// LOAD / CLEAN / DERIVE
// ==========================================================================
function buildDaily(dailyRows, stabilityMap) {
  const rows = coerceNumeric(dailyRows);

  // raw day counts per symbol (before cleaning) for the confidence metric
  const rawCounts = new Map();
  for (const r of rows) rawCounts.set(r.symbol, (rawCounts.get(r.symbol) || 0) + 1);

  // clean obviously invalid days
  const clean = rows.filter(
    (r) => isNum(r[PRICE_REF]) && r[PRICE_REF] > 0 &&
           isNum(r.day_low) && r.day_low > 0 &&
           isNum(r.day_high) && r.day_high > 0,
  );

  const stab = stabilityMap || new Map();

  for (const r of clean) {
    // fils -> % of price
    for (const c of FILS_METRICS) {
      r[c] = isNum(r[c]) ? (r[c] / r[PRICE_REF]) * 100 : null;
    }
    // "no signal" days are not "failed signal" days
    if (r.fib_signals === 0) { r.fib_win_pct = null; r.successful_fib = null; }
    // derived: swing efficiency (needs >=2 bull swings)
    r.swing_efficiency = (isNum(r.bull_swings) && r.bull_swings >= 2 && isNum(r.tradable_bull_swings))
      ? (r.tradable_bull_swings / r.bull_swings) * 100 : null;
    // derived: execution margin
    r.execution_margin = (isNum(r.avg_time_btwn_swings) && isNum(r.avg_time_to_target))
      ? r.avg_time_btwn_swings - r.avg_time_to_target : null;
    // attach intraday stability
    const s = stab.get(`${r.symbol}|${r.trade_date}`);
    r.liq_stability = s == null ? null : s;
  }
  return { rows: clean, rawCounts };
}

function groupBySymbol(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.symbol)) m.set(r.symbol, []);
    m.get(r.symbol).push(r);
  }
  return m;
}

// ==========================================================================
// RECENCY-WEIGHTED AGGREGATION
// ==========================================================================
function recencyValue(valsDesc) {
  let used = 0, wsum = 0, acc = 0;
  for (const [n, w] of RECENCY_TIERS) {
    const seg = n == null ? valsDesc.slice(used) : valsDesc.slice(used, used + n);
    if (n != null) used += n;
    const med = median(seg);
    if (med != null) { acc += med * w; wsum += w; }
  }
  return wsum === 0 ? null : acc / wsum;
}

function aggregate(bySymbol) {
  const needed = [...new Set(Object.values(SCORES).flatMap((s) => Object.keys(s)))];
  const agg = new Map(); // symbol -> { metric: value }
  for (const [sym, rows] of bySymbol) {
    const sorted = rows.slice().sort((a, b) => (a.trade_date < b.trade_date ? 1 : -1));
    const obj = {};
    for (const metric of needed) obj[metric] = recencyValue(sorted.map((r) => r[metric]));
    agg.set(sym, obj);
  }
  return agg;
}

// ==========================================================================
// SCORES
// ==========================================================================
function baseScores(agg) {
  const symbols = [...agg.keys()];
  const result = new Map(symbols.map((s) => [s, {}]));
  const accum = new Map(symbols.map((s) => [s, {}])); // score -> {sum,w}

  for (const [scoreName, metrics] of Object.entries(SCORES)) {
    for (const s of symbols) accum.get(s)[scoreName] = { sum: 0, w: 0 };

    for (const [metric, [w, dir, transform]] of Object.entries(metrics)) {
      const raw = symbols.map((s) => {
        let v = agg.get(s)[metric];
        if (transform === 'log' && isNum(v)) v = Math.log10(Math.max(v, 1));
        return v;
      });
      const ranked = pctRank(raw);
      symbols.forEach((s, i) => {
        let r = ranked[i];
        if (r == null) return;
        if (dir < 0) r = 100 - r;
        const a = accum.get(s)[scoreName];
        a.sum += r * w; a.w += w;
      });
    }
    for (const s of symbols) {
      const a = accum.get(s)[scoreName];
      result.get(s)[scoreName] = a.w ? a.sum / a.w : null;
    }
  }
  return result; // Map symbol -> {liquidity, opportunity, ...}
}

function consistencyScore(bySymbol) {
  const symbols = [...bySymbol.keys()];
  const feats = new Map();
  for (const [sym, rows] of bySymbol) {
    const reach = LADDER_PCT
      .map((t) => rows.filter((r) => isNum(r.largest_bull_swing) && r.largest_bull_swing >= t).length / rows.length)
      .reduce((a, b) => a + b, 0) / LADDER_PCT.length * 100;
    feats.set(sym, {
      cv_volume: robustCV(rows.map((r) => r.total_volume)),
      cv_swing:  robustCV(rows.map((r) => r.avg_swing_size)),
      cv_timing: robustCV(rows.map((r) => r.avg_time_btwn_swings)),
      pct_days_trade: rows.filter((r) => isNum(r.tradable_bull_swings) && r.tradable_bull_swings >= 1).length / rows.length * 100,
      reach_ladder: reach,
    });
  }
  const cols = [
    ['cv_volume', false], ['cv_swing', false], ['cv_timing', false],
    ['pct_days_trade', true], ['reach_ladder', true],
  ];
  const rankedCols = cols.map(([c, higher]) => {
    const r = pctRank(symbols.map((s) => feats.get(s)[c]));
    return r.map((v) => (v == null ? null : (higher ? v : 100 - v)));
  });
  const out = new Map();
  symbols.forEach((s, i) => {
    const vals = rankedCols.map((col) => col[i]).filter(isNum);
    out.set(s, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
  });
  return out;
}

function confidenceLabel(bySymbol, rawCounts) {
  const out = new Map();
  for (const [sym, rows] of bySymbol) {
    const valid = rows.length;
    const raw = rawCounts.get(sym) || valid;
    const completeness = raw ? valid / raw : 0;
    const active = rows.filter((r) => isNum(r.total_swings) && r.total_swings >= 1).length / valid;
    let label;
    if (valid >= CONF_HIGH.minDays && completeness >= CONF_HIGH.minCompleteness && active >= CONF_HIGH.minActive) label = 'High';
    else if (valid >= CONF_MED.minDays && completeness >= CONF_MED.minCompleteness && active >= CONF_MED.minActive) label = 'Medium';
    else label = 'Low';
    out.set(sym, { confidence: label, valid_days: valid, completeness: round1(completeness * 100) / 100, active_ratio: round1(active * 100) / 100 });
  }
  return out;
}

// ==========================================================================
// ASSEMBLY  (pure: takes parsed rows, returns ranked array)
// ==========================================================================
function runHistoryEngine(dailyRows, minuteRowsOrStabilityMap) {
  // Accept either raw minute rows (compute stability here) or a precomputed
  // stability Map (e.g. aggregated in SQL for large universes).
  const stabilityMap = (minuteRowsOrStabilityMap instanceof Map)
    ? minuteRowsOrStabilityMap
    : intradayStability(minuteRowsOrStabilityMap || []);
  const { rows, rawCounts } = buildDaily(dailyRows, stabilityMap);
  const bySymbol = groupBySymbol(rows);

  const agg = aggregate(bySymbol);
  const base = baseScores(agg);
  const cons = consistencyScore(bySymbol);
  const conf = confidenceLabel(bySymbol, rawCounts);

  const blendKeys = Object.keys(BASE_BLEND);
  const blendW = blendKeys.reduce((a, k) => a + BASE_BLEND[k], 0);

  const results = [];
  for (const sym of base.keys()) {
    const b = base.get(sym);
    const baseScore = blendKeys.reduce((a, k) => a + (b[k] ?? 0) * BASE_BLEND[k], 0) / blendW;
    const consistency = cons.get(sym);
    const mult = MULT_FLOOR + (1 - MULT_FLOOR) * ((consistency ?? 0) / 100);
    results.push({
      symbol: sym,
      liquidity: round1(b.liquidity), opportunity: round1(b.opportunity),
      probability: round1(b.probability), risk: round1(b.risk), execution: round1(b.execution),
      consistency: round1(consistency),
      base_score: round1(baseScore),
      mult: Math.round(mult * 1000) / 1000,
      final_score: round1(baseScore * mult),
      ...conf.get(sym),
    });
  }
  results.sort((a, b) => b.final_score - a.final_score);
  return results;
}

module.exports = {
  runHistoryEngine, intradayStability, recencyValue, pctRank, robustCV,
  median, percentile, parseVolume, parseCsv,
  CONFIG: {
    PRICE_REF, FILS_METRICS, RECENCY_TIERS, SCORES, BASE_BLEND,
    MULT_FLOOR, LADDER_PCT, CONF_HIGH, CONF_MED,
  },
};