const { Server } = require('socket.io');
const { pool, connection } = require('@trading/shared');

const { loadFormulas }         = require('@trading/shared/src/formula-engine/loadFormulas.js');
const { processTopPerformers } = require('@trading/shared/src/rankings/processTopPerformers.js');

let io;

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://192.168.1.2:3000',
  'https://jk-traders-5c752.web.app',
  'https://jk-traders-5c752.firebaseapp.com',
  'https://carola-stylish-tasia.ngrok-free.dev'
];

function init(server) {
  io = new Server(server, {
    cors: { origin: '*', credentials: true },
  });

  io.on('connection', async (socket) => {
    console.log('[socket] Client connected:', socket.id);

    // ── Send top performers ────────────────────────────────────────────────
    try {
      const cached = await connection.get('top_performers');

      if (cached) {
        // Fast path: already scored, send immediately
        socket.emit('top-performers', JSON.parse(cached));
        console.log('[socket] Sent cached top performers to', socket.id);
      } else {
        // BUG FIX: fallback path now SAVES result to Redis so future
        // connections get the cached version and don't re-score from scratch.
        console.log('[socket] No cache — scoring now for', socket.id);

        const { rows: stocks } = await pool.query(`
          SELECT s.*
          FROM public.market_stock_snapshots s
          JOIN (
            SELECT MAX(created_at) AS created_at
            FROM public.market_stock_snapshots
          ) latest ON s.created_at = latest.created_at
          ORDER BY s.symbol
        `);

        const { rows: todayIntradayRows } = await pool.query(`
          SELECT symbol, last_price, volume, change_percent, created_at
          FROM public.market_stock_snapshots
          WHERE created_at >= CURRENT_DATE AT TIME ZONE 'Asia/Kuwait'
          ORDER BY created_at ASC
        `);

        
        if (stocks.length > 0) {
          const { rows: closingRows } = await pool.query(`
            SELECT symbol, change_percent, DATE(created_at AT TIME ZONE 'Asia/Kuwait') AS trade_date
            FROM (
              SELECT symbol, change_percent, created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY symbol, DATE(created_at AT TIME ZONE 'Asia/Kuwait')
                  ORDER BY created_at DESC
                ) AS rn
              FROM public.market_stock_snapshots
              WHERE created_at >= NOW() - INTERVAL '4 days'
            ) ranked
            WHERE rn = 1
            ORDER BY symbol, trade_date DESC
          `);
  
          // Now build the Map
          const recentClosingMap = new Map();
          for (const row of closingRows) {
            const pct = parseFloat(String(row.change_percent).replace('%','').replace('−','-')) || 0;
            if (!recentClosingMap.has(row.symbol)) recentClosingMap.set(row.symbol, []);
            recentClosingMap.get(row.symbol).push(pct); // pushes newest first: [today, yesterday, dayBefore]
          }
          const formulas = await loadFormulas(pool);
          const top10    = await processTopPerformers(stocks, formulas, pool, todayIntradayRows, recentClosingMap);
          // Save so next connection doesn't re-score
          await connection.set('top_performers', JSON.stringify(top10));
          socket.emit('top-performers', top10);
          console.log(`[socket] Scored and sent ${top10.length} top performers`);
        } else {
          console.warn('[socket] No stock data in DB yet');
          socket.emit('top-performers', []);
        }
      }
    } catch (err) {
      console.error('[socket] top-performers error:', err.message);
      socket.emit('top-performers', []);
    }

    // ── Send fib signals ───────────────────────────────────────────────────
    try {
      const cachedFib = await connection.get('fib_signals');
      if (cachedFib) {
        socket.emit('fib-signals', JSON.parse(cachedFib));
      } else {
        const signals = await getFibSignals();
        socket.emit('fib-signals', signals || []);
      }
    } catch (err) {
      console.error('[socket] fib-signals error:', err.message);
    }

    // ── Send most active (gainers / losers / top value) ───────────────────
    try {
      const cachedMostActive = await connection.get('most_active');
      if (cachedMostActive) {
        socket.emit('most-active', JSON.parse(cachedMostActive));
        console.log('[socket] Sent cached most-active to', socket.id);
      } else {
        // Fallback: compute from latest snapshot in DB
        const { rows: latestStocks } = await pool.query(`
          SELECT s.*
          FROM public.market_stock_snapshots s
          JOIN (
            SELECT MAX(created_at) AS created_at
            FROM public.market_stock_snapshots
          ) latest ON s.created_at = latest.created_at
          ORDER BY s.symbol
        `);
        const { computeMostActive } = require('@trading/shared/src/rankings/mostActive.js');
        const mostActive = computeMostActive(latestStocks);
        await connection.set('most_active', JSON.stringify(mostActive));
        socket.emit('most-active', mostActive);
        console.log('[socket] Computed and sent most-active to', socket.id);
      }
    } catch (err) {
      console.error('[socket] most-active error:', err.message);
      socket.emit('most-active', { gainers: [], losers: [], topValue: [] });
    }

    // ── Watchlist subscription ─────────────────────────────────────────────
    socket.on('watchlist:subscribe', async ({ userId, date }) => {
      socket.data.userId = userId;
      socket.data.date   = date;

      await connection.set(
        `watchlist_subscription:${socket.id}`,
        JSON.stringify({ userId, date })
      );

      const data = await getWatchList(userId, date);
      socket.emit('watchlist', data);
    });

    socket.on('disconnect', async () => {
      console.log('[socket] Client disconnected:', socket.id);
      await connection.del(`watchlist_subscription:${socket.id}`);
    });
  });

  return io;
}

function broadcast(data) {
  if (io) io.emit('stock-update', data);
}

function top10Performers(data) {
  if (io) io.emit('top-performers', data);
}

async function broadcastFibSignals() {
  if (!io) return;
  const signals = await getFibSignals();
  await connection.set('fib_signals', JSON.stringify(signals));
  io.emit('fib-signals', signals);
}

function broadcastFibSignal(signal = {}) {
  if (!io) return;
  io.emit('fib-signal', signal);
  if (signal.signal_type === 'STRONG_BUY') {
    console.log(`[socket] STRONG_BUY: ${signal.symbol}`);
  }
}

/**
 * broadcastMostActive
 * Called by the socket queue worker whenever the ingestion service
 * publishes a fresh 'most-active' job.  Sends to all connected clients.
 */
function broadcastMostActive(data) {
  if (!io) return;
  io.emit('most-active', data);
  console.log(
    `[socket] Broadcast most-active: ` +
    `${data?.gainers?.length ?? 0} gainers, ` +
    `${data?.losers?.length ?? 0} losers, ` +
    `${data?.topValue?.length ?? 0} top value`
  );
}

async function getFibSignals() {
  try {
    const { rows: signals } = await pool.query(`
      SELECT
        fs.*,
        sw.current_price,
        sw.change_percent,
        fst.id AS signal_type_id,
        COALESCE(fl.levels, '[]'::json) AS fibonacci_levels
      FROM fibonacci_signals fs
      LEFT JOIN fibonacci_signal_types fst ON fst.signal_code = fs.signal_type
      LEFT JOIN LATERAL (
        SELECT * FROM fibonacci_swings
        WHERE symbol = fs.symbol AND id = fs.swing_id
        LIMIT 1
      ) sw ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', id, 'level_percent', level_percent, 'level_price', level_price,
            'trend_direction', trend_direction, 'signal_id', signal_id,
            'color', color, 'is_active', is_active
          ) ORDER BY level_percent
        ) AS levels
        FROM fibonacci_levels
        WHERE symbol = fs.symbol AND is_deleted = false
      ) fl ON true
      WHERE fs.created_at::date = CURRENT_DATE
    `);

    signals.sort((a, b) => {
      if (a.signal_type_id !== b.signal_type_id) return a.signal_type_id - b.signal_type_id;
      return b.deviation_pct - a.deviation_pct;
    });

    return signals;
  } catch (err) {
    console.error('[getFibSignals]', err.message);
    return [];
  }
}

function getSignal({ entryPrice, targetPercent, exitTarget, currentPrice, previousPrice, quantity, status, dropCount, exitAfterDrops = 3 }) {
  const exitPrice = entryPrice - exitTarget;
  if (exitPrice >= currentPrice) return { signal: 'EXIT', dropCount: 0 };

  const targetPrice = entryPrice + targetPercent;

  if (status === 'WATCH') {
    if (currentPrice >= targetPrice) return { signal: 'SELL', dropCount: 0 };
    return { signal: 'WATCH', dropCount: 0 };
  }

  if (status === 'EXIT') {
    let updatedDropCount = dropCount;
    if (currentPrice < previousPrice) updatedDropCount += 1;
    else if (currentPrice > previousPrice) return { signal: 'WATCH', dropCount: 0 };
    return { signal: 'EXIT', dropCount: updatedDropCount };
  }

  if (status === 'SELL') {
    let updatedDropCount = dropCount;
    if (currentPrice < previousPrice) updatedDropCount += 1;
    else updatedDropCount = 0;
    if (updatedDropCount >= exitAfterDrops) return { signal: 'EXIT', dropCount: updatedDropCount };
    return { signal: 'SELL', dropCount: updatedDropCount };
  }

  return { signal: status, dropCount };
}

async function getWatchList(userId = 1, date = new Date().toISOString().split('T')[0]) {
  try {
    const watchlist = await pool.query(`
      SELECT wl.*,
        mss.company_name,
        mss.last_price AS current_price,
        mss.volume AS current_volume,
        COALESCE(wlt.targets, '[]'::json) AS targets
      FROM watchlists wl
      LEFT JOIN LATERAL (
        SELECT * FROM market_stock_snapshots
        WHERE symbol = wl.symbol ORDER BY created_at DESC LIMIT 1
      ) mss ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', id, 'watchlist_id', watchlist_id, 'target_percent', target_percent,
            'is_active', is_active, 'is_sell', is_sell
          ) ORDER BY target_percent
        ) AS targets
        FROM watchlist_targets wlt
        WHERE wl.id = wlt.watchlist_id AND wlt.is_deleted = false
      ) wlt ON true
      WHERE wl.user_id = $1 AND wl.created_at::date = $2
        AND wl.is_active = true AND wl.is_deleted = false
    `, [userId, date]);

    const finalResult = [];

    for (const stock of watchlist.rows) {
      const snapshots = await pool.query(
        `SELECT last_price AS price FROM market_stock_snapshots
         WHERE symbol = $1 ORDER BY created_at DESC LIMIT 2`,
        [stock.symbol]
      );

      if (snapshots.rows.length < 2) continue;

      if (!stock.sell_price && !stock.sell_volume) {
        const currentPrice  = (parseFloat(snapshots.rows[0].price) / 1000) * stock.quantity;
        const previousPrice = (parseFloat(snapshots.rows[1].price) / 1000) * stock.quantity;
        const targetPercent = Array.isArray(stock.targets) && stock.targets.length > 0
          ? Math.min(...stock.targets.filter(t => t.is_sell).map(t => parseFloat(t.target_percent)))
          : 0;
        const exitTarget = Array.isArray(stock.targets) && stock.targets.length > 0
          ? Math.min(...stock.targets.filter(t => !t.is_sell).map(t => parseFloat(t.target_percent)))
          : 5;

        const result = getSignal({
          entryPrice: (parseFloat(stock.buy_price) / 1000) * stock.quantity,
          targetPercent, exitTarget, currentPrice, previousPrice,
          quantity: stock.quantity, status: stock.status,
          dropCount: stock.drop_count, exitAfterDrops: 3,
        });

        finalResult.push({ ...stock, drop_count: result.dropCount, signal: result.signal });

        await pool.query(
          `UPDATE watchlists SET drop_count = $2, status = $3 WHERE id = $1`,
          [stock.id, result.dropCount, result.signal]
        );
      } else {
        finalResult.push(stock);
      }
    }

    return finalResult;
  } catch (err) {
    console.error('[getWatchList]', err.message);
    return [];
  }
}

async function broadcastWatchList() {
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    const sub = await connection.get(`watchlist_subscription:${socket.id}`);
    if (!sub) continue;
    const { userId, date } = JSON.parse(sub);
    const data = await getWatchList(userId, date);
    socket.emit('watchlist', data);
  }
}

async function broadcastWatchListToUser(userId, date) {
  const data = await getWatchList(userId, date);
  io.to(`user:${userId}`).emit('watchlist', data);
}

module.exports = {
  init,
  broadcast,
  top10Performers,
  broadcastFibSignal,
  broadcastFibSignals,
  broadcastMostActive,
  broadcastWatchList,
  broadcastWatchListToUser,
  allowedOrigins,
};
