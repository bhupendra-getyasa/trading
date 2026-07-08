// =============================================================================
// apps/signal-engine/src/writer.js
//
// BUG FIXED: Previous writer.js was an exact copy of loader.js.
// It had fetchSymbols/fetchRawRows — zero INSERT logic.
// This is the correct writer with real upsert into stock_prices_daily.
// =============================================================================

'use strict';

const COLUMNS = [
  'symbol', 'trade_date',
  'day_open', 'day_close', 'oc_margin',
  'day_high', 'day_low', 'day_range',
  'total_volume', 'avg_vol_min', 'highest_volume', 'vol_spike_count',
  'bull_swings', 'bear_swings', 'total_swings',
  'tradable_bull_swings',
  'largest_bull_swing', 'largest_bear_swing',
  'avg_swing_size', 'avg_time_btwn_swings',
  'longest_bull_run', 'longest_bear_run',
  'fib_signals', 'successful_fib', 'fib_win_pct',
  'auto_target_fils',
  'avg_profit_fib', 'avg_loss_fib',
  'avg_time_to_target', 'best_earning_time', 'false_signal_pct',
  'est_buyer_vol', 'est_seller_vol', 'buyer_pct', 'seller_pct',
];

const KEY_MAP = {
  symbol:             'symbol',
  tradeDate:          'trade_date',
  dayOpen:            'day_open',
  dayClose:           'day_close',
  ocMargin:           'oc_margin',
  dayHigh:            'day_high',
  dayLow:             'day_low',
  dayRange:           'day_range',
  totalVolume:        'total_volume',
  avgVolMin:          'avg_vol_min',
  highestVolume:      'highest_volume',
  volSpikeCount:      'vol_spike_count',
  bullSwings:         'bull_swings',
  bearSwings:         'bear_swings',
  totalSwings:        'total_swings',
  tradableBullSwings: 'tradable_bull_swings',
  largestBullSwing:   'largest_bull_swing',
  largestBearSwing:   'largest_bear_swing',
  avgSwingSize:       'avg_swing_size',
  avgTimeBtwnSwings:  'avg_time_btwn_swings',
  longestBullRun:     'longest_bull_run',
  longestBearRun:     'longest_bear_run',
  fibSignals:         'fib_signals',
  successfulFib:      'successful_fib',
  fibWinPct:          'fib_win_pct',
  autoTargetFils:     'auto_target_fils',
  avgProfitFib:       'avg_profit_fib',
  avgLossFib:         'avg_loss_fib',
  avgTimeToTarget:    'avg_time_to_target',
  bestEarningTime:    'best_earning_time',
  falseSignalPct:     'false_signal_pct',
  estBuyerVol:        'est_buyer_vol',
  estSellerVol:       'est_seller_vol',
  buyerPct:           'buyer_pct',
  sellerPct:          'seller_pct',
};

const UPDATE_COLS = COLUMNS.filter(c => c !== 'symbol' && c !== 'trade_date');

function buildInsertSql() {
  const placeholders = COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
  const updateSet    = UPDATE_COLS.map(c => `${c} = EXCLUDED.${c}`).join(',\n      ');
  return `
    INSERT INTO public.stock_prices_daily
      (${COLUMNS.join(', ')}, created_at)
    VALUES
      (${placeholders}, now())
    ON CONFLICT (symbol, trade_date) DO UPDATE SET
      ${updateSet},
      updated_at = now();
  `;
}

const INSERT_SQL = buildInsertSql();

function recordToValues(record) {
  const snake = {};
  for (const [camel, col] of Object.entries(KEY_MAP)) {
    snake[col] = record[camel] ?? null;
  }
  return COLUMNS.map(col => snake[col] ?? null);
}

async function upsertOne(pool, record) {
  await pool.query(INSERT_SQL, recordToValues(record));
  console.log(`[writer] Upserted — ${record.symbol} ${record.tradeDate}`);
}

async function upsertBatch(pool, records, batchSize = 100) {
  if (!records.length) return 0;

  let total  = 0;
  const client = await pool.connect();

  try {
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      try {
        await client.query('BEGIN');
        for (const rec of batch) {
          await client.query(INSERT_SQL, recordToValues(rec));
        }
        await client.query('COMMIT');
        total += batch.length;
        console.log(
          `[writer] ✓ Batch ${Math.floor(i / batchSize) + 1} committed — ` +
          `rows ${i + 1}–${i + batch.length} (${total} total)`
        );
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[writer] ✗ Batch ${Math.floor(i / batchSize) + 1} rolled back:`, err.message);
        throw err;
      }
    }
  } finally {
    client.release();
  }

  return total;
}

module.exports = { upsertOne, upsertBatch, COLUMNS, KEY_MAP };
