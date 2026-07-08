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
    fibEntryLow: 0.25,                  // healthy pullback zone (widened for whole-fil ticks)
    fibEntryHigh: 0.75,                 // 3-fil swing: 1f=33% & 2f=67% now both valid
    defaultEntry: 'second',             // 'second' = wait for 2nd swing (default)
    firstSwingIfWarming: true,          // a WARMING SWING may take the 1st swing
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
    volumeCapPct: 0.005,               // never own > 0.5% of daily volume (exit safety)
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
