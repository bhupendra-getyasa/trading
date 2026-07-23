'use strict';
/*
 * The v1 tool set.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO run_sql TOOL
 * ---------------------------------------------------------------------------
 * market_stock_snapshots stores TradingView's scraped strings verbatim:
 * last_price, change_percent, volume and avg_volume are text. Every consumer in
 * this repo parses them in JS afterwards — see live-engine/lib/util.js
 * parseVolume(), which handles 'k'/'m'/'b' suffixes, commas, and the unicode
 * minus (U+2212).
 *
 * So `WHERE volume > 1000000` against that table is a LEXICOGRAPHIC comparison
 * on strings like "1.2M". "950K" > "1.2M" is true. Model-authored SQL against
 * this schema is not "occasionally imprecise", it is reliably absurd — and
 * silently so, with a confident answer attached. Aggregation in SQL would also
 * require reimplementing parseVolume in SQL, which is formula drift from
 * util.js: the agent and the dashboard would then disagree about the same
 * number and someone would spend a day chasing it.
 *
 * Therefore: tools SELECT raw rows and parse with the ENGINE'S OWN parser. One
 * source of truth. Aggregation happens in JS, which is why every tool here is
 * bounded by symbol or by window size.
 * ---------------------------------------------------------------------------
 *
 * NOTE ON IMPORTS: always require @trading/shared SUBMODULES. Requiring
 * '@trading/shared' spreads src/db/postgres and constructs a READ-WRITE pool as
 * an import side effect, which would hand this service exactly the privileges
 * the agent_ro role exists to withhold. radar.service.js already imports sizing
 * this way; we follow that precedent.
 */
const U = require('@trading/shared/src/live-engine/lib/util');
const { suggest } = require('@trading/shared/src/live-engine/sizing');
const ENGINE_CFG = require('@trading/shared/src/live-engine/config');

const db = require('../../db/pool');
const symbols = require('../../catalog/symbols');
const { expected } = require('../executor');

const ENGINE_VERSION = ENGINE_CFG.VERSION;
const TZ_OFFSET = ENGINE_CFG.SESSION.tzOffsetHours;

const DAY_SCHEMA = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description:
    'Trading day as YYYY-MM-DD in Kuwait local time. Boursa Kuwait trades Sunday-Thursday only; ' +
    'Friday and Saturday have no rows and that is not a data gap. Omit for today.',
};

/** Present money to the model as a tagged value, never a bare number. */
const fils = (v) => (v == null ? null : { value: v, unit: 'fils' });
const kd = (v) => (v == null ? null : { value: v, unit: 'kd' });

function todayKuwait() {
  return U.tradingDay(Date.now(), TZ_OFFSET);
}

// ---------------------------------------------------------------------------

const getMarketSnapshot = {
  name: 'get_market_snapshot',
  version: '1.0.0',
  description:
    'Latest 1-minute market snapshot for ONE symbol: price, percent change, volume, average volume, ' +
    'market cap and how stale the reading is. Use this for "what is X trading at now" or a single ' +
    'point-in-time question. NOT for history or trends over time — use get_symbol_window for that. ' +
    'NOT for whether a stock is worth trading — use get_classification.',
  input_schema: {
    type: 'object',
    properties: { symbol: symbols.schema('The Boursa Kuwait ticker.') },
    required: ['symbol'],
    additionalProperties: false,
  },
  async execute({ symbol }) {
    const r = await db.query(
      'tool.get_market_snapshot',
      `SELECT symbol, company_name, last_price, change_percent, change,
              volume, avg_volume, market_cap, created_at
         FROM public.market_stock_snapshots
        WHERE symbol = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [symbol]
    );
    if (r.rows.length === 0) throw expected('NO_DATA', `No snapshot has ever been recorded for ${symbol}.`);

    const row = r.rows[0];
    const s = U.parseSnapshot(row);
    const ageMin = U.round1((Date.now() - U.toMs(row.created_at)) / 60000);

    return {
      symbol: s.symbol,
      company_name: row.company_name,
      price: fils(s.price),
      change_pct: s.changePct,
      volume: s.volume,
      avg_volume: s.avgVolume,
      market_cap_raw: row.market_cap,
      observed_at: new Date(U.toMs(row.created_at)).toISOString(),
      age_minutes: ageMin,
      // The engine ignores symbols with no fresh snapshot; say so rather than
      // let the model present a two-hour-old price as "now".
      is_stale: ageMin > ENGINE_CFG.ELIGIBILITY.stalenessMin,
      as_of: r.asOf,
    };
  },
};

// ---------------------------------------------------------------------------

const getSymbolWindow = {
  name: 'get_symbol_window',
  version: '1.0.0',
  description:
    'The recent sequence of 1-minute snapshots for ONE symbol, oldest first, with a summary of the ' +
    'move (high, low, first, last, total volume). Use this for intraday trend, momentum, or "how has ' +
    'X moved today" questions. NOT for a single current price — use get_market_snapshot. This reads ' +
    'only the most recent snapshots, not full daily history.',
  input_schema: {
    type: 'object',
    properties: {
      symbol: symbols.schema('The Boursa Kuwait ticker.'),
      snapshots: {
        type: 'integer',
        minimum: 2,
        maximum: 120,
        default: ENGINE_CFG.WINDOW.snapshots,
        description: `How many recent 1-minute snapshots to read. The live engine uses ${ENGINE_CFG.WINDOW.snapshots}.`,
      },
    },
    required: ['symbol'],
    additionalProperties: false,
  },
  async execute({ symbol, snapshots }) {
    const n = snapshots || ENGINE_CFG.WINDOW.snapshots;
    // LATERAL + LIMIT so the (symbol, created_at DESC) index reads only n rows —
    // same shape as live-engine/repository.js loadWindows().
    const r = await db.query(
      'tool.get_symbol_window',
      `SELECT w.symbol, w.last_price, w.change_percent, w.volume, w.avg_volume, w.created_at
         FROM (SELECT $1::text AS symbol) q
         JOIN LATERAL (
           SELECT s.symbol, s.last_price, s.change_percent, s.volume, s.avg_volume, s.created_at
             FROM public.market_stock_snapshots s
            WHERE s.symbol = q.symbol
            ORDER BY s.created_at DESC
            LIMIT $2
         ) w ON true
        ORDER BY w.created_at ASC`,
      [symbol, n]
    );
    if (r.rows.length === 0) throw expected('NO_DATA', `No snapshots for ${symbol}.`);

    const bars = r.rows.map((row) => {
      const s = U.parseSnapshot(row);
      return {
        ts: new Date(U.toMs(row.created_at)).toISOString(),
        price: fils(s.price),
        change_pct: s.changePct,
        volume: s.volume,
      };
    });

    const prices = bars.map((b) => b.price && b.price.value).filter((p) => p != null);
    const first = bars[0];
    const last = bars[bars.length - 1];

    return {
      symbol,
      snapshot_count: bars.length,
      window_start: first.ts,
      window_end: last.ts,
      summary: {
        first_price: first.price,
        last_price: last.price,
        high: fils(prices.length ? Math.max(...prices) : null),
        low: fils(prices.length ? Math.min(...prices) : null),
        move_fils: fils(
          first.price && last.price ? U.round1(last.price.value - first.price.value) : null
        ),
        last_change_pct: last.change_pct,
      },
      bars,
      as_of: r.asOf,
    };
  },
};

// ---------------------------------------------------------------------------

const getClassification = {
  name: 'get_classification',
  version: '1.0.0',
  description:
    "The History engine's daily verdict on ONE symbol: profile, trend, lane, target fils, net fils, " +
    'tradable swings and price band, plus whether it qualifies for the live engine and any warnings. ' +
    'Use this for "is X worth trading", "what kind of stock is X", or anything about character, ' +
    'quality or eligibility. NOT for current price or volume — use get_market_snapshot.',
  input_schema: {
    type: 'object',
    properties: { symbol: symbols.schema('The Boursa Kuwait ticker.') },
    required: ['symbol'],
    additionalProperties: false,
  },
  async execute({ symbol }) {
    // stock_classification is the one numeric table in this set, but we still
    // read it through the same shape the engine uses so the qualifies/warnings
    // logic can never drift from live-engine/historyService.js.
    const r = await db.query(
      'tool.get_classification',
      `SELECT symbol, profile, trend, lane, target_fils, net_fils, tradable_swings, price_band
         FROM public.stock_classification
        WHERE symbol = $1`,
      [symbol]
    );
    if (r.rows.length === 0) {
      throw expected(
        'NO_DATA',
        `${symbol} has no classification row. The History engine has not scored it — that is not the same as it scoring badly.`
      );
    }
    const c = r.rows[0];
    const cfg = ENGINE_CFG.HISTORY;
    const qualifies = cfg.qualifyLanes.includes(c.lane) && !cfg.blockTrends.includes(c.trend);

    const warnings = [];
    if ((cfg.warnTrends || []).includes(c.trend)) warnings.push('COOLING: character fading recently');
    if (c.profile === 'WATCH') warnings.push('WATCH: normally small swings');
    if (c.profile === 'WILD' || c.lane === 'B') warnings.push('ILLIQUID: thin volume, exit risk');

    return {
      symbol: c.symbol,
      profile: c.profile,
      trend: c.trend,
      lane: c.lane,
      price_band: c.price_band,
      target_fils: fils(c.target_fils == null ? null : Number(c.target_fils)),
      net_fils: fils(c.net_fils == null ? null : Number(c.net_fils)),
      tradable_swings: c.tradable_swings == null ? null : Number(c.tradable_swings),
      qualifies_for_live_engine: qualifies,
      warnings,
      engine_version: ENGINE_VERSION,
      as_of: r.asOf,
    };
  },
};

// ---------------------------------------------------------------------------

const getRadar = {
  name: 'get_radar',
  version: '1.0.0',
  description:
    'The live engine\'s opportunities for a trading day from opportunity_list: which symbols triggered, ' +
    'entry type, entry price, expected and net fils, suggested size, and why. Use this for "what did ' +
    'the radar find", "what triggered today", or questions about the scanner\'s output. NOT for a ' +
    "symbol's own price or history.",
  input_schema: {
    type: 'object',
    properties: {
      trading_day: DAY_SCHEMA,
      status: {
        type: 'string',
        enum: ['OPEN', 'ALL'],
        default: 'ALL',
        description: 'OPEN = still-live opportunities only. ALL = everything the engine raised that day.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Max rows.' },
    },
    required: [],
    additionalProperties: false,
  },
  async execute({ trading_day, status, limit }) {
    const day = trading_day || todayKuwait();
    const lim = limit || 20;
    const params = [day, lim];
    const statusClause = status === 'OPEN' ? "AND status = 'OPEN'" : '';

    const r = await db.query(
      'tool.get_radar',
      `SELECT symbol, trigger_ts, trading_day, profile, trend, lane, entry_type,
              entry_price, swing1_fils, swings_so_far, expected_fils, net_fils,
              price_band, rvol, change_pct, suggested_shares, kd_needed,
              est_profit_kd, size_tag, warnings, reasons, fib_level_hit,
              pullback_pct, status
         FROM public.opportunity_list
        WHERE trading_day = $1 ${statusClause}
        ORDER BY est_profit_kd DESC NULLS LAST, trigger_ts DESC
        LIMIT $2`,
      params
    );

    if (r.rows.length === 0) {
      // An empty result is an ANSWER, not an error. Fri/Sat has no session; a
      // quiet day has no triggers. Say which.
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
      const weekend = dow === 5 || dow === 6;
      return {
        trading_day: day,
        opportunity_count: 0,
        opportunities: [],
        note: weekend
          ? `${day} is a Friday/Saturday. Boursa Kuwait trades Sunday-Thursday, so there is no session and no data.`
          : `The engine raised no opportunities on ${day}.`,
        as_of: r.asOf,
      };
    }

    return {
      trading_day: day,
      opportunity_count: r.rows.length,
      opportunities: r.rows.map((o) => ({
        symbol: o.symbol,
        triggered_at: o.trigger_ts,
        status: o.status,
        profile: o.profile,
        trend: o.trend,
        lane: o.lane,
        entry_type: o.entry_type,
        entry_price: fils(o.entry_price == null ? null : Number(o.entry_price)),
        expected_fils: fils(o.expected_fils == null ? null : Number(o.expected_fils)),
        net_fils: fils(o.net_fils == null ? null : Number(o.net_fils)),
        swings_so_far: o.swings_so_far,
        rvol: o.rvol == null ? null : Number(o.rvol),
        change_pct: o.change_pct == null ? null : Number(o.change_pct),
        suggested_shares: o.suggested_shares,
        kd_needed: kd(o.kd_needed == null ? null : Number(o.kd_needed)),
        est_profit_kd: kd(o.est_profit_kd == null ? null : Number(o.est_profit_kd)),
        size_tag: o.size_tag,
        warnings: o.warnings,
        reasons: o.reasons,
        fib_level_hit: o.fib_level_hit,
      })),
      engine_version: ENGINE_VERSION,
      as_of: r.asOf,
    };
  },
};

// ---------------------------------------------------------------------------

const getSizing = {
  name: 'get_sizing',
  version: '1.0.0',
  description:
    'How many shares the engine would suggest for ONE symbol at a given budget, with the KD needed, ' +
    'the round-trip commission per share, and a tag (TRADABLE / OVER-BUDGET / OVER-RISK / ILLIQUID-CAP ' +
    '/ TOO-EXPENSIVE). Use this for "how much of X could I buy", position size, or affordability. ' +
    'This is a SIZING CALCULATION, not a recommendation to trade.',
  input_schema: {
    type: 'object',
    properties: {
      symbol: symbols.schema('The Boursa Kuwait ticker.'),
      budget_kd: {
        type: 'number',
        minimum: 1,
        maximum: 1000000,
        description: "Budget in KD. Omit to use today's session_settings budget, or the engine default.",
      },
    },
    required: ['symbol'],
    additionalProperties: false,
  },
  async execute({ symbol, budget_kd }) {
    const snap = await db.query(
      'tool.get_sizing.snapshot',
      `SELECT symbol, last_price, change_percent, volume, avg_volume, created_at
         FROM public.market_stock_snapshots
        WHERE symbol = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [symbol]
    );
    if (snap.rows.length === 0) throw expected('NO_DATA', `No snapshot for ${symbol}, so it cannot be sized.`);
    const s = U.parseSnapshot(snap.rows[0]);
    if (s.price == null || s.price <= 0) {
      throw expected('NO_DATA', `${symbol} has no usable price in its latest snapshot.`);
    }

    const cls = await db.query(
      'tool.get_sizing.classification',
      `SELECT profile, lane, target_fils, tradable_swings
         FROM public.stock_classification
        WHERE symbol = $1`,
      [symbol]
    );
    const c = cls.rows[0] || {};

    let budget = budget_kd;
    let budgetSource = 'caller';
    if (budget == null) {
      const day = todayKuwait();
      const b = await db.query(
        'tool.get_sizing.budget',
        'SELECT budget_kd FROM public.session_settings WHERE trading_day = $1',
        [day]
      );
      if (b.rows.length > 0 && b.rows[0].budget_kd != null) {
        budget = Number(b.rows[0].budget_kd);
        budgetSource = `session_settings for ${day}`;
      } else {
        budget = ENGINE_CFG.SIZING && ENGINE_CFG.SIZING.defaultBudgetKd;
        budgetSource = 'engine default';
      }
    }

    // The engine's own function. Never reimplemented here: if this service
    // computed its own size, the agent and the dashboard would quote different
    // numbers for the same stock and there would be no way to tell which was right.
    const out = suggest(
      {
        profile: c.profile,
        price: s.price,
        volume: s.volume,
        avgVolume: s.avgVolume,
        tradableSwings: c.tradable_swings == null ? null : Number(c.tradable_swings),
        targetFils: c.target_fils == null ? null : Number(c.target_fils),
        lane: c.lane,
      },
      budget,
      ENGINE_CFG.SIZING,
      ENGINE_CFG.COMMISSION
    );

    return {
      symbol,
      price: fils(s.price),
      budget_kd: kd(budget),
      budget_source: budgetSource,
      profile: c.profile || null,
      lane: c.lane || null,
      suggested_shares: out.suggested_shares,
      kd_needed: kd(out.kd_needed),
      commission_fils_per_share: fils(out.commission_fils_per_share),
      est_roundtrips: out.est_roundtrips,
      size_tag: out.tag,
      engine_version: ENGINE_VERSION,
      as_of: snap.asOf,
    };
  },
};

module.exports = [getMarketSnapshot, getSymbolWindow, getClassification, getRadar, getSizing];
