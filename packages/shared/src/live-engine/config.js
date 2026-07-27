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

  // ---- Commission: real KSE formula, DATE-SCHEDULED per market segment -----
  // Read ONLY through packages/shared/src/live-engine/commission.js. Nothing may
  // hard-code a rate. A cost for date D must use the schedule active on date D,
  // otherwise every backtest spanning 01-Oct-2026 is silently wrong.
  //
  // Source: Boursa Kuwait disclosure 23-Jul-2026 (CMA approved), effective 01-Oct-2026.
  // Main Market is our universe: the RATE DOES NOT CHANGE (15 bps both sides of the
  // date). What changes is the 0.500 KD settlement fee being abolished, which makes
  // October CHEAPER at every size.
  //
  // NOTE ON filsPerShare: only ever used when mode === 'fixed'. It is NOT the real
  // model and must never leak into classification (that was the flat-2-fil bug).
  COMMISSION: {
    referenceNotionalKd: 500,   // notional used to price a stock we are only classifying
    schedule: [
      {
        id: 'pre-oct-2026',
        effectiveFrom: null,           // open-ended start
        effectiveTo: '2026-09-30',
        mode: 'percentage',            // 'percentage' (real KSE) | 'fixed'
        bpsBySegment: { PREMIER: 10, MAIN: 15, FUND: 10 },
        minKdPerSide: 0.250,
        minAppliesBelowKd: null,       // minimum applies at any size in this regime
        settlementKdPerOrder: 0.500,   // per EXECUTED ORDER over the threshold
        settlementAppliesAboveKd: 50,
        filsPerShare: 2,               // ONLY if mode === 'fixed'
      },
      {
        id: 'post-oct-2026',
        effectiveFrom: '2026-10-01',
        effectiveTo: null,             // open-ended end
        mode: 'percentage',
        bpsBySegment: { PREMIER: 15, MAIN: 15, FUND: 15 },
        minKdPerSide: 0.500,
        minAppliesBelowKd: 333.33,     // minimum only bites on trades <= this
        settlementKdPerOrder: 0,       // ABOLISHED
        settlementAppliesAboveKd: 0,
        filsPerShare: 2,
      },
    ],
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
  // symbol every cycle whatever the mode.
  //
  // 27-Jul: flipped 'warn' -> 'gate'. It shipped in 'warn' to accumulate evidence
  // without changing behaviour. The evidence arrived and it is unambiguous: on
  // 26-Jul, IFAHR (150 KD median bid depth) and FTI (547 KD) both sat in the live
  // watchlist all session. Neither could have been exited at size. The gate was
  // measuring correctly and being ignored — that is worse than not measuring.
  LIQUIDITY: {
    enabled: true,
    mode: 'gate',                // 'warn' = record only | 'gate' = also block the radar
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

  // ---- TRADING: budget & how many stocks (USER-EDITABLE, no deploy) ----------
  // Both values are set by the user in the front end and may change often
  // (500 KD single-stock R&D one week, 5000 KD across several the next).
  // Nothing downstream may hard-code either.
  //
  // THE SLOT FLOOR IS NOT A PREFERENCE — IT IS ARITHMETIC.
  // Commission has a fixed component (the KD minimum, plus the 0.500 settlement
  // fee until 01-Oct). Split a budget too many ways and that fixed cost exceeds
  // the spread you are trying to capture. Measured on a 150f stock, 1-fil spread:
  //
  //   slot 250 KD  ->  1,600 sh  ->  cost 1.72 KD  ->  net -0.12  (LOSS)
  //   slot 500 KD  ->  3,300 sh  ->  cost 2.49 KD  ->  net +0.81
  //   slot 1000 KD ->  6,600 sh  ->  cost 3.97 KD  ->  net +2.63
  //   slot 2500 KD -> 16,600 sh  ->  cost 8.47 KD  ->  net +8.13
  //
  // Max stocks by budget (current regime; roughly DOUBLES from 01-Oct when the
  // settlement fee dies and the floor drops to ~350 KD):
  //   500 KD -> 1 | 1000 -> 2 | 2000 -> 4 | 3000 -> 6 | 5000 -> 10
  TRADING: {
    budgetKd: 5000,              // user-set: 500 .. 50000
    maxStocks: 2,                // user-set: 1 .. 10
    minSlotKd: null,             // null = derive from the active commission schedule
    minSlotKdByRegime: { 'pre-oct-2026': 500, 'post-oct-2026': 350 },
    minNetPerRoundTripKd: 1.0,   // reject any stock that cannot clear this at THIS slot size
    // Validation is enforced in code, not documentation: if budgetKd / maxStocks
    // falls below the floor the call must FAIL LOUDLY with the max supported count,
    // never silently size down into a losing trade.
    enforceSlotFloor: true,
  },

  // ---- Budget allocation across qualified stocks (Option B) ------------------
  PORTFOLIO: { rankBy: 'est_profit_kd' },   // est_profit_kd | net_fils | swing1_fils

  LOGGING: { logAllSignals: true },     // log every stock's panel each cycle (tuning data)
};
