'use strict';
/*
 * ============================================================================
 *  LIVE ENGINE — SINGLE CONFIG FILE  (everything tunable; nothing hard-coded)
 * ============================================================================
 * All numbers below are PROVISIONAL — validated only on a down/flat market on
 * paper. They are starting points; tune from real paper-trading results. The
 * code reads every threshold from here.
 * ============================================================================
 */
module.exports = {
  VERSION: 'live-engine v1.0',

  SESSION: { tzOffsetHours: 3, openHour: 9, closeHour: 13 },   // Asia/Kuwait, Sun–Thu 09:00–13:00
  WINDOW:  { snapshots: 20 },           // how many recent 1-min snapshots to analyse
  ELIGIBILITY: { stalenessMin: 5 },     // ignore symbols with no fresh snapshot

  // ---- Commission: real KSE formula, configurable per broker --------------
  COMMISSION: {
    mode: 'percentage',        // 'percentage' (real KSE) | 'fixed'
    pctPerSide: 0.0015,        // 0.15% of trade value per side
    minKdPerSide: 0.5,         // 0.5 KD minimum per side
    filsPerShare: 2,           // used only when mode = 'fixed'
  },

  // ---- Swing / Fibonacci detection (Gate 1) — PROVISIONAL, tune with tick data
  SWING: {
    minSwingFils: 3,                    // a move must be >= this to count as a swing
    pivotReversalFils: 2,               // reversal needed to confirm a pivot (zigzag)
    // ZONE WIDTH: these two are the ONLY knobs that set the entry-zone width. They flow to
    // swings.js (zoneHigh = H - range*fibEntryLow, zoneLow = H - range*fibEntryHigh) and
    // nowhere else — no 0.25/0.75 is hardcoded downstream. Retrace fraction [fibEntryLow,
    // fibEntryHigh] maps to price band [zoneLow, zoneHigh]. 0.25-0.75 is deliberately WIDE
    // (see note below) so almost any pullback qualifies. INTENDED TIGHTENING TARGET ~0.38/0.62
    // once live pullback_pct data (logged on every 2nd-swing opportunity row) shows where
    // entries actually land — do NOT tighten before then. Left at 0.25/0.75 for now.
    fibEntryLow: 0.25,                  // healthy pullback zone (widened for whole-fil ticks)
    fibEntryHigh: 0.75,                 // 3-fil swing: 1f=33% & 2f=67% now both valid
    defaultEntry: 'second',             // 'second' = wait for 2nd swing (default)
    firstSwingIfWarming: true,          // a WARMING SWING may take the 1st swing
    entryTolFils: 2,                    // on a confirmed 2nd swing, SKIP if price already ran
                                        // > zoneHigh + this (fils) — don't chase the peak
  },

  // ---- Order-book liquidity (Gate 1b) — reads public.stock_quotes -------------
  // Answers "can we actually TRADE this right now?", which price+volume cannot.
  // MEASURE ALWAYS, BLOCK OPTIONALLY: metrics are computed and stored on every
  // symbol every cycle whatever the mode. Ships in 'warn' so we accumulate real
  // evidence for these thresholds WITHOUT changing selection behaviour; flip to
  // 'gate' only once the replay harness shows the numbers hold.
  LIQUIDITY: {
    enabled: true,
    mode: 'warn',                // 'warn' = record only | 'gate' = also block the radar
    window: 20,                  // quote rows per symbol per cycle (matches WINDOW.snapshots)
    quoteStalenessMin: 5,        // newest quote older than this -> unknown, fail OPEN
    minSamples: 5,               // fewer rows than this -> unknown, fail OPEN
    depthVsSizePct: 0.5,         // median bid depth must cover >= this x intended shares
    minTradesPerMin: 2,          // must actually trade, not just display a book
    minActivePct: 25,            // % of window minutes with >0 trades (catches frozen quotes)
    minRangeFils: 8,             // session-to-date high-low; needs room to clear commission
    maxSpreadFils: 3,            // crossing cost must not eat the target
  },

  // ---- Radar predicate (Gate 1 gating signals) — PROVISIONAL & configurable ---
  RADAR: {
    requireAlive: true,                 // price rising + real volume
    minRvol: 0,                         // volume is a SIZE limit, not a gate — do NOT block radar on it
    minChangePct: 0,                    // must be up on the move
    combine: 'AND',                     // 'AND' | 'OR' | 'NofM'
    minMatch: 2,
  },

  // ---- History gate (Gate 2) ------------------------------------------------
  HISTORY: {
    qualifyLanes: ['A'],                // only Lane A qualifies (SWING / WATCH / liquid RUNNER)
    blockTrends: [],                    // COOLING no longer blocks (decision b)...
    warnTrends: ['COOLING'],            // ...it shows as a WARNING on the opportunity, user decides
  },

  // ---- Sizing SUGGESTION (never restricts the radar) ------------------------
  SIZING: {
    riskPctByProfile: { SWING: 0.25, RUNNER: 0.15, WATCH: 0.15, WILD: 0.05, MARGINAL: 0.05, DEAD: 0 },
    defaultBudgetKd: 2000,             // FIX: never let a null budget remove the risk cap
    volumeCapPct: 0.005,               // never own > 0.5% of daily volume (exit safety)
    useBookDepth: true,                // prefer the ORDER BOOK over the volume proxy for the
                                       // exit-safety cap. Volume says how much traded all day;
                                       // the bid says how much you can sell into RIGHT NOW.
                                       // Both caps are computed and recorded either way.
    bookDepthPct: 0.5,                 // never size above this x median bid depth
    lotSize: 1000,                     // round to this; keeps commission at the floor
    minLot: 500,
    maxContracts: 4,
    wildMaxShares: 200,                // Finding 7: hard tiny-size cap for WILD / Lane B (lottery money)
    wildLotSize: 100,                  // WILD uses a smaller lot step
  },

  // ---- Budget → suggested price band (SUGGESTION ONLY — never hides a stock) --
  BUDGET_BANDS: [
    { maxBudgetKd: 1500, suggestBands: ['Penny', 'Low'] },
    { maxBudgetKd: 2500, suggestBands: ['Penny', 'Low', 'Medium'] },
    { maxBudgetKd: 3500, suggestBands: ['Penny', 'Low', 'Medium', 'Upper Medium'] },
    { maxBudgetKd: Infinity, suggestBands: ['Penny', 'Low', 'Medium', 'Upper Medium', 'High', 'Premium'] },
  ],

  // ---- Budget allocation across qualified stocks (Option B) ------------------
  PORTFOLIO: { rankBy: 'est_profit_kd' },   // est_profit_kd | net_fils | swing1_fils

  LOGGING: { logAllSignals: true },     // log every stock's panel each cycle (tuning data)
};
