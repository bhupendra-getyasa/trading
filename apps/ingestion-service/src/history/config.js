// =============================================================================
// KSE Signal Engine — Step 2: Config & Volume Parser
// =============================================================================

'use strict';

// ---------------------------------------------------------------------------
// Default strategy config (mirrors strategy_config DB table)
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  targetProfitFils:    2.0,
  minSwingFils:        2.0,
  volSpikeMultiplier:  2.0,
  sharesPerContract:   1000,
  swingsToWait:        3,
  priceMaxFils:        500.0,
  minDailyVolume:      5_000_000,
  minWinPct:           20.0,
  minTradableSwings:   4,
  fibLevels:           [0.236, 0.382, 0.500, 0.618, 0.786],
};

/**
 * Load strategy config from DB, falling back to defaults if not found.
 * @param {import('pg').Pool} pool
 * @returns {Promise<typeof DEFAULT_CONFIG>}
 */
async function loadConfig(pool) {
  try {
    const { rows } = await pool.query(
      'SELECT key, value FROM public.strategy_config;'
    );

    const map = {};
    for (const row of rows) {
      map[row.key] = parseFloat(row.value);
    }

    const cfg = {
      targetProfitFils:   map.target_profit_fils   ?? DEFAULT_CONFIG.targetProfitFils,
      minSwingFils:       map.min_swing_fils        ?? DEFAULT_CONFIG.minSwingFils,
      volSpikeMultiplier: map.vol_spike_multiplier  ?? DEFAULT_CONFIG.volSpikeMultiplier,
      sharesPerContract:  Math.round(map.shares_per_contract ?? DEFAULT_CONFIG.sharesPerContract),
      swingsToWait:       Math.round(map.swings_to_wait      ?? DEFAULT_CONFIG.swingsToWait),
      priceMaxFils:       map.price_max_fils        ?? DEFAULT_CONFIG.priceMaxFils,
      minDailyVolume:     Math.round(map.min_daily_volume    ?? DEFAULT_CONFIG.minDailyVolume),
      minWinPct:          map.min_win_pct           ?? DEFAULT_CONFIG.minWinPct,
      minTradableSwings:  Math.round(map.min_tradable_swings ?? DEFAULT_CONFIG.minTradableSwings),
      fibLevels: [
        map.fib_level_236 ?? 0.236,
        map.fib_level_382 ?? 0.382,
        map.fib_level_500 ?? 0.500,
        map.fib_level_618 ?? 0.618,
        map.fib_level_786 ?? 0.786,
      ],
    };

    console.log(
      `[config] Loaded from DB — target=${cfg.targetProfitFils} fils | ` +
      `swings_wait=${cfg.swingsToWait} | shares=${cfg.sharesPerContract} | ` +
      `price_max=${cfg.priceMaxFils} fils`
    );
    return cfg;

  } catch (err) {
    console.warn('[config] Could not load from DB, using defaults:', err.message);
    return { ...DEFAULT_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// FIX #1 — Volume parser  (handles "630.16 K", "1.87 M", plain integers)
// ---------------------------------------------------------------------------

/**
 * Convert TradingView-style volume strings to integer.
 *
 * "630.16 K"  → 630160
 * "1.87 M"    → 1870000
 * "50000"     → 50000
 * "−3 (−0.38%)" → 0   (change-column noise)
 *
 * @param {string|number|null} raw
 * @returns {number}
 */
function parseVolume(raw) {
  if (raw === null || raw === undefined) return 0;

  const str = String(raw)
    .trim()
    .replace(/,/g, '')            // remove commas
    .replace(/\s+/g, '')          // remove internal spaces
    .toUpperCase();

  // Reject anything that looks like a price-change column
  if (str.includes('(') || str.includes('%')) return 0;

  try {
    if (str.endsWith('M')) return Math.round(parseFloat(str.slice(0, -1)) * 1_000_000);
    if (str.endsWith('K')) return Math.round(parseFloat(str.slice(0, -1)) * 1_000);
    const n = parseFloat(str);
    return isNaN(n) ? 0 : Math.round(n);
  } catch {
    return 0;
  }
}

module.exports = { DEFAULT_CONFIG, loadConfig, parseVolume };