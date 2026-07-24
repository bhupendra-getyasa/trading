'use strict';
/*
 * ============================================================================
 *  TMI — EXECUTION CONFIG. Every rule is a value here; none is hard-coded.
 * ============================================================================
 * The Live Engine SELECTS (which symbols are worth watching). TMI EXECUTES
 * (whether to enter one, at what size, when to exit, when to stop). No overlap.
 *
 * STATUS TAGS below are honest grades from forward-testing on 14-21 July, not
 * decoration. A rule marked FAILED is in this file because it is the current
 * behaviour and removing it silently would hide a known problem — not because
 * it works.
 *
 *   PROVEN   — held on every day tested
 *   HOLDING  — looked right on 2+ days, not yet enough
 *   FAILED   — broke on fresh data; needs replacing, tracked openly
 *   UNTESTED — plausible, no evidence either way
 *
 * Nothing here may be tightened on the strength of one good day. The replay
 * harness exists precisely because both of us have already been fooled by
 * hindsight once: the same 20-July tape read +212 KD as a backtest and −2.3 KD
 * walk-forward. Changes get validated against stored days before they go live.
 * ============================================================================
 */
module.exports = {
  VERSION: 'tmi v0.1',

  MODE: 'paper',                 // 'paper' = fills simulated at signal price | 'live' = user confirms real fills

  BUDGET: {
    defaultKd: 5000,
    reservePct: 0.30,            // PROVEN — held back so a mid-session breakout is not locked out.
                                 // 13-Jul: the over-budget pile out-earned the taken pile 2.1x
                                 // purely because budget filled at the open on mediocre stocks.
  },

  SELECTION: {
    maxConcurrentStocks: 2,      // PROVEN — 2 beat 3 beat 4 on every single day tested.
                                 // 15-Jul: 2 stocks +114 KD, 3 stocks +86, 4 stocks +49.
    // THE STANDARD STRATEGY. When on, decision.js decides the day's tone (trade / trade
    // one / sit out) and scores every radar candidate on today's tape. History becomes a
    // weighted input, not a veto.
    useDecisionFramework: true,

    requireRadarQualified: false,// Was true, and that was wrong. It let a 3-month
                                 // classification veto what a stock is doing TODAY, and
                                 // the classifier rejected the best stock of the day twice
                                 // in one week (SPEC 21-Jul +9f, EMIRATES 22-Jul — widest
                                 // range, most active, most signals). The score's history
                                 // modifier (-8) now carries that caution instead, so a
                                 // rejected stock must be clearly better today to qualify.
                                 // Set true to restore the old hard veto.
    allowWarmingRejects: false,  // UNTESTED — SPEC was history_rejected AND trend=WARMING on
                                 // 21-Jul and moved +9f. ONE example. Do not enable without replay.
    rankBy: 'session_range_fils',// est_profit_kd is a ceiling, not a forecast (THURAYA card said
                                 // +115.5, reality ~+7), so it must not order the queue.

    // OPENING LOCKOUT — UNTESTED, off by default. 4-5 qualified nominations fire in the
    // first 15 minutes of every day tested, so both slots are gone by ~m10 to whatever
    // happened to fire first, and every later nomination is locked out. This is the same
    // failure as 13-Jul (over-budget pile out-earned the taken pile 2.1x) — but the 30%
    // cash reserve does NOT prevent it, because the binding constraint is SLOTS, not cash.
    openingWindowMinutes: 0,     // 0 = off
    maxStocksInOpeningWindow: 1,
    // NO-TRADE WINDOW. The first 30 minutes are measurably the worst entries of the day:
    // n=116, avg -0.66f, and only 3% ever reach +5f versus 15% across the session. This
    // corroborates the slot-exhaustion finding from an independent direction — the opening
    // is not merely crowded, the entries there are genuinely worse.
    noTradeBeforeMinute: 0,      // 0 = off
  },

  SIZING: {
    bookDepthPct: 0.5,           // PROVEN — never take more than half the resting bid. The bid is
                                 // the exit; daily volume is only a proxy for it.
    lotSize: 100,
    minLot: 100,
    maxContractsPerStock: null,  // null = TMI decides while the gate stays green
  },

  ENTRY: {
    source: 'radar',             // 'radar' = the engine's fib second-swing fires the entry.
                                 // TMI does not re-implement selection; it times and gates it.

    // ENTRY MODEL — the thing walk-forward says matters most.
    //   'confirmation' : current behaviour. Wait for the turn-up to confirm, then buy.
    //                    Safe against falling knives, but the confirmation price is
    //                    already back near the swing high (ALDEERA: zone 549-556,
    //                    pullback low 550, entry logged at 560). Measured cost across
    //                    5 days: avg MFE 3.6f against a 6.1f target, 17% ever reached
    //                    target, and the worst entries had MFE of literally 0 fils.
    //   'zone'         : buy while price is INSIDE the fib pullback zone, before the
    //                    turn-up confirms. Better price, but accepts the falling-knife
    //                    risk the confirmation was there to avoid. Untested until now.
    model: 'zone',               // MEASURED BETTER on every day tested. 'confirmation'
                                 // waits for the turn-up and buys near the swing high;
                                 // across 6 days it totalled -275.6 KD against zone's
                                 // -211.3 on identical rules, and forward-return analysis
                                 // put it statistically level with a RANDOM entry
                                 // (494 samples: -0.51f vs random -0.15f).
    zoneMaxWaitMinutes: 10,      // abandon a zone setup that has not turned up in this long

    // SWING-SIZE BAND. Measured on 1,463 zone signals across 5 days:
    //   swing1 3-4f  (n=1041) avg +0.52f, only 10% ever reach +5f  <- most signals, too small
    //   swing1 5-7f  (n= 271) avg +1.39f, 53% up, 18% reach +5f    <- the useful band
    //   swing1 8-12f (n= 102) avg +0.77f, 59% up, 39% reach +5f
    //   swing1 >=13f (n=  49) avg -0.90f, MAE -6.18f               <- big swings mean-revert
    // The 3-4f band is 71% of all signals and cannot clear commission; the >=13f band is
    // actively harmful. DERIVED FROM THE SAME 5 DAYS IT IS TESTED ON — circular until it
    // survives days this analysis never saw.
    minSwing1Fils: 0,            // 0 = off
    maxSwing1Fils: null,
    requireLiquidityPass: true,  // the Gate-1b verdict must be a pass at entry, not just at signal
    maxChaseFils: 2,             // skip if price already ran this far past the signalled entry
  },

  EXIT: {
    targetMethod: 'avg_swing_5f',// HOLDING — average of session swings >= 5f, NOT the 3-month
                                 // all-swing average, which is diluted by 2-3f noise and understated
                                 // real targets by 2-4x (ALDEERA history 3.2f vs actual 15.0f).
    targetFallbackFils: 5,
    stopMethod: 'session_range_pct', // FAILED — 15% of range broke twice: RASIYAT 19-Jul got a 3f
                                 // stop and was shaken out 3x (−41); EMIRATES 20-Jul got 4f and
                                 // took two −80 stops. Kept as current behaviour and flagged, NOT
                                 // endorsed. Replacement candidate: ATR or prior-day range.
                                 // Note: session range is now knowable live from the broker H/L,
                                 // which at least removes the look-ahead the old version had.
    stopRangePct: 0.15,
    // The session range is TINY at the open (it has barely any session in it yet), so a
    // pure range stop is tightest exactly when we know least — 19-Jul gave every morning
    // entry a 3f stop and they were all shaken out. A price-percentage floor keeps risk
    // comparable across price bands: a flat 3f is 0.47% on a 632f stock and 1.8% on a
    // 168f one, which is not one rule, it is two.
    stopPricePct: 0.006,         // 0.6% of price as the floor (UNTESTED — sweep it)
    stopMinFils: 3,
    stopMaxFils: 12,             // NEW — a hard ceiling the old rule lacked. EMIRATES' two −80 KD
                                 // stops were large size x a stop that scaled with no upper bound.
    trailGiveBackFils: 3,        // give back this much from the peak once the target is cleared
    // TIME EXIT — UNTESTED, off by default. A position that has gone nowhere for this
    // long is holding a slot hostage: 21-Jul MARAKEZ sat from m49 to the bell for
    // -52.12 KD, never touching stop, target or quiet. There is currently no rule
    // that says "this isn't working, leave".
    maxHoldMinutes: null,        // null = off
    minProgressFils: 3,          // ...unless the peak got at least this far above entry

    quietMinutes: 3,             // HOLDING (2/2 days) — a dead tape means a dead move. Sell while
                                 // green rather than drift into the stop. OULAFUEL 16-Jul: this one
                                 // rule swung a single contract from −56.8 to +24.1.
    quietMaxTradesPerMin: 1,
  },

  REENTRY: {
    minDipFils: 4,               // PROVEN-ish (one walk-forward day, large effect) — after selling,
                                 // require a real pullback below the exit before re-entering.
    cooldownMinutes: 5,          // Root cause it fixes: the engine sold the top of a swing and
    failBanMinutes: 15,          // instantly re-bought that same top. 5 of 8 losses on 20-Jul were
                                 // self-inflicted re-entries; adding these turned −2.3 into +57.5.
                                 // Insensitive to exact values (dip 3-5 / cool 3-10 / ban 10-20 all
                                 // gave the same result) — that is what makes it structural rather
                                 // than a fitted number.
  },

  RISK: {
    perStockMaxLossKd: -8,       // stock is done for the day at this realised net
    maxFailedSetups: 2,          // ...or after this many stop-outs
    dayMaxLossKd: null,          // UNTESTED — no evidence for a day-level halt yet
  },

  BREADTH: {
    enabled: false,              // UNTESTED — 19-Jul (55% red) said "sit out", but 20-Jul (60% red)
                                 // held the best stock of the week (+212). So breadth means "be
    minPctUp: 35,                // selective", never "don't trade", and it stays off until replay
    maxStocksOnDownDay: 1,       // shows what it actually buys us.
  },

  // ---- WAKE-UP DETECTOR - selection --------------------------------------------
  // Answers "which stocks are today offering a move big enough to be worth its own
  // cost?" One metric does the work:
  //
  //     rangeOverCost = (session range %) / (spread % + commission %)
  //
  // Derived by hand from two stocks on 23-Jul, then confirmed on 735 stock-days:
  //   DIGITUS 1628f, spread 23f (1.41%), range 6.1%  -> 3.6x  NOT tradeable
  //   KHOT     188f, spread  6f (3.19%), range 20.6% -> 5.9x  tradeable
  // KHOT's spread is WORSE in percent and it is still the better stock. Only the
  // ratio means anything; neither number does alone.
  //
  // Correlation with the best trade actually available afterwards (m45, 735 samples):
  //   rangeOverCost +0.455 | range% +0.303 | trades +0.255
  //   move% +0.115  <- direction barely matters
  //   depth  -0.035 <- depth predicts NOTHING alone; it is a constraint, not a signal
  //
  // Result: the average stock-day offers 6.7 KD; stocks passing this offered 63.7 KD,
  // 75% of them above 20 KD. Roughly 9x better than picking at random.
  //
  // THE METRIC is grounded in mechanism. THE THRESHOLDS are not yet evidence - they
  // were chosen on the same 7 days they were tested on, and this has never been run
  // on a day it was not derived from.
  WAKEUP: {
    enabled: true,
    decideAtMinute: 45,          // when to rank. Correlation strengthens through the day
                                 // (+0.355 at m20, +0.412 at m30, +0.455 at m45) but
                                 // waiting costs opportunity. 45 is the compromise.
    minRangeOverCost: 4.0,       // roc>=2.5 gives 31 KD avg; >=4.0 gives 63.7 KD but only
                                 // ~2.9 picks/day. Loosen this first if it finds nothing.
    minRangeFils: 5,             // absolute floor. A 1.2-fil range on a 0.1-fil spread
                                 // scores brilliantly and cannot be traded (EKTTITAB).
    minSellableKd: 1000,         // must be able to EXIT, not merely enter
    minTrades: 20,               // in the window so far - is anyone actually here
    minSamples: 15,
    maxPicks: 2,                 // how many to hold at once
  },

  // ── the standard strategy: when to trade at all, and what ────────────────────
  TONE: {
    // Day-level verdict. RED means SIT OUT — a real answer, not a failure to choose.
    // 21-Jul lost money in every configuration tested purely because the system kept
    // trading a day that had nothing in it.
    minTradesPerMin: 2,
    minRangeFils: 8,
    goodMedRangeFils: 12,
    weakBreadthPct: 35,
    goodBreadthPct: 50,
    goodLiquidCount: 4,
    greenScore: 5,               // of 6
    amberScore: 3,
  },

  SCORE: {
    // History is a MODIFIER, not a veto. Measured: SPEC (21-Jul) and EMIRATES (22-Jul)
    // were both history_rejected AND the most tradeable stocks of their day. A stock
    // the classifier dislikes must be clearly better on today's tape to overcome the
    // penalty — but it must be ABLE to.
    historyBonus: 8,
    rejectedPenalty: -8,
    deadPenalty: -25,
    // minScore is DISPLAY ONLY — it gates nothing, and that is a measured fact, not an
    // opinion. Tested at 0, 55 and 75 across 6 days: byte-identical results, same 13
    // trades. The edge floor below is so restrictive that every candidate clearing it
    // scores highly anyway, so the score never binds. Kept on screen because it explains
    // WHY a stock looks good, which helps when deciding whether to follow a call — but
    // the 30/25/25/20 weights are my guesses and the data says they are inert.
    minScore: 0,
    // THE RULE THAT WORKS. The expected move must beat commission AND spread by this
    // much. Measured across 6 days: 2f -> -170.8 KD, 3f -> -87.2, 4f -> -35.7,
    // 5f -> +26.4, 6f -> +45.8. Five consecutive improvements in one direction, not a
    // lucky value with bad neighbours — and it is economically grounded, since the
    // measured gross edge was roughly half the round-trip cost.
    // SANAM 22-Jul is the case it exists to refuse: moved the right way, WON its trade,
    // and still lost money — 4.9 KD gross against 5.2 KD commission.
    // A KD-DENOMINATED FLOOR WAS TRIED AND REJECTED. Left here, off, with its result,
    // so it does not get re-invented six weeks from now.
    //
    // The reasoning was sound: profit is fils x shares, and on 22-Jul a 5-fil move on
    // EMIRATES (23,000 shares affordable) was worth +115 KD gross against +14.4 KD for a
    // 12-fil move on ASC (1,200 shares). A fils-only floor refused that EMIRATES trade.
    //
    // Tested on the real exported day it made things WORSE:
    //   fils 6f only   3 trips  +14.17 KD   commission  42% of gross
    //   KD 8 only      6 trips   +5.75 KD   commission  83% of gross
    //   KD 15 only     2 trips  -19.12 KD   commission 120% of gross
    // A KD floor admits low-fils / high-share trades, and a move that small sits inside
    // the noise — it gets scratched or stopped before it travels. Size cannot rescue a
    // move too small to survive its own volatility.
    minNetEdgeKd: null,          // off

    // THE FLOOR THAT WORKS. Over 6 days: 2f -> -170.8 KD, 3f -> -87.2, 4f -> -35.7,
    // 5f -> +26.4, 6f -> +45.8 — five consecutive improvements in one direction. It also
    // held on the real exported day (+14.17, best of every variant tried). Economically
    // grounded: measured gross edge is roughly half the round-trip cost, so the move must
    // clear that cost by a real margin before it is worth taking.
    minNetEdgeFils: 6,
  },

  FILLS: {
    slippageFils: 0,             // paper mode only. 0 is optimistic ON PURPOSE: it keeps paper and
                                 // live comparable, so the gap between them measures real slippage
                                 // instead of hiding it inside an assumption.
  },
};
