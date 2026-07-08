'use strict';
/*
 * history/classificationStep.js  — HISTORY-SIDE (runs in the History engine).
 *
 * A daily, READ-ONLY step over the existing daily metrics table. It does NOT
 * change that table. For each symbol it aggregates two windows (63 & 21 trading
 * days), classifies profile/lane/trend, tags price_band + cap_tier, and UPSERTS
 * one row per symbol into public.stock_classification (which the Live engine reads).
 *
 * Run once per day, right after the daily metrics are computed (e.g. 08:30 cron).
 *
 * Assumes the daily table has: symbol, trade_date, day_close, total_volume,
 * auto_target_fils, fib_win_pct, tradable_bull_swings, largest_bull_swing,
 * and a market cap column (adjust DAILY_TABLE / column names to your schema).
 */
const { classifyProfile, classifyLane, classifyTrend, CLASSIFY } = require('../classification');

const DAILY_TABLE = process.env.DAILY_TABLE || 'public.stock_prices_daily';
const CLASS_TABLE = process.env.CLASSIFICATION_TABLE || 'public.stock_classification';
const PRICE_CAT   = process.env.PRICE_CATEGORY_TABLE || 'public.price_category';
const CAP_CAT     = process.env.CAP_CATEGORY_TABLE || 'public.market_cap_category';
const W3 = 63, W1 = 21;   // trading days (config)

// median over the last N daily rows per symbol, for the metrics we classify on
const AGG_SQL = `
WITH ranked AS (
  SELECT symbol, trade_date,
    day_close                 AS price,
    total_volume              AS volume,
    auto_target_fils          AS target,
    fib_win_pct               AS win,
    tradable_bull_swings      AS tsw,
    largest_bull_swing        AS largest,
    row_number() OVER (PARTITION BY symbol ORDER BY trade_date DESC) AS rn
  FROM ${DAILY_TABLE}
)
SELECT symbol,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY price)  FILTER (WHERE rn <= $1) AS price_3m,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY volume) FILTER (WHERE rn <= $1) AS volume_3m,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY target) FILTER (WHERE rn <= $1) AS target_3m,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY win)    FILTER (WHERE rn <= $1) AS win_3m,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY tsw)    FILTER (WHERE rn <= $1) AS tsw_3m,
  100.0*count(*) FILTER (WHERE rn <= $1 AND largest >= 3)/NULLIF(count(*) FILTER (WHERE rn <= $1),0) AS hit3_3m,
  100.0*count(*) FILTER (WHERE rn <= $1 AND largest >= 5)/NULLIF(count(*) FILTER (WHERE rn <= $1),0) AS hit5_3m,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY target) FILTER (WHERE rn <= $2) AS target_1m,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY volume) FILTER (WHERE rn <= $2) AS volume_1m,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY win)    FILTER (WHERE rn <= $2) AS win_1m,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY tsw)    FILTER (WHERE rn <= $2) AS tsw_1m,
  100.0*count(*) FILTER (WHERE rn <= $2 AND largest >= 3)/NULLIF(count(*) FILTER (WHERE rn <= $2),0) AS hit3_1m,
  100.0*count(*) FILTER (WHERE rn <= $2 AND largest >= 5)/NULLIF(count(*) FILTER (WHERE rn <= $2),0) AS hit5_1m
FROM ranked GROUP BY symbol;`;

const num = (x) => (x == null ? null : Number(x));

async function runClassificationStep(pool, { now = Date.now() } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  const { rows } = await pool.query(AGG_SQL, [W3, W1]);
  const priceCat = (await pool.query(`SELECT category, min_price, max_price FROM ${PRICE_CAT} ORDER BY id;`)).rows;
  const bandOf = (priceFils) => {
    const p = priceFils / 1000; // table is in KD (numeric 10,3); price is fils
    for (const c of priceCat) {
      const lo = c.min_price == null ? -Infinity : Number(c.min_price);
      const hi = c.max_price == null ? Infinity : Number(c.max_price);
      if (p >= lo && p < hi) return c.category;
    }
    return null;
  };

  let written = 0;
  for (const r of rows) {
    const m3 = { price: num(r.price_3m), volume: num(r.volume_3m), target: num(r.target_3m), win: num(r.win_3m), tradableSwings: num(r.tsw_3m), hit3: num(r.hit3_3m), hit5: num(r.hit5_3m) };
    const m1 = { price: num(r.price_3m), volume: num(r.volume_1m), target: num(r.target_1m), win: num(r.win_1m), tradableSwings: num(r.tsw_1m), hit3: num(r.hit3_1m), hit5: num(r.hit5_1m) };
    if (m3.price == null) continue;
    const profile = classifyProfile(m3);
    const profile1m = classifyProfile(m1);
    const lane = classifyLane(profile, m3.volume);
    const trend = classifyTrend(profile, profile1m);
    const net = (m3.target ?? 0) - CLASSIFY.commissionFils;
    const band = bandOf(m3.price);

    await pool.query(
      `INSERT INTO ${CLASS_TABLE} (symbol,profile,lane,trend,profile_1m,price,price_band,cap_tier,volume,
         target_fils,net_fils,win_pct,tradable_swings,hit3,hit5,computed_date,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
       ON CONFLICT (symbol) DO UPDATE SET profile=EXCLUDED.profile,lane=EXCLUDED.lane,trend=EXCLUDED.trend,
         profile_1m=EXCLUDED.profile_1m,price=EXCLUDED.price,price_band=EXCLUDED.price_band,cap_tier=EXCLUDED.cap_tier,
         volume=EXCLUDED.volume,target_fils=EXCLUDED.target_fils,net_fils=EXCLUDED.net_fils,win_pct=EXCLUDED.win_pct,
         tradable_swings=EXCLUDED.tradable_swings,hit3=EXCLUDED.hit3,hit5=EXCLUDED.hit5,computed_date=EXCLUDED.computed_date,updated_at=now();`,
      [r.symbol, profile, lane, trend, profile1m, m3.price, band, null, m3.volume, m3.target, net,
       m3.win, m3.tradableSwings, m3.hit3, m3.hit5, day]);
    written++;
  }
  return { written, computed_date: day };
}
module.exports = { runClassificationStep, AGG_SQL };
