const { Server } = require('socket.io');
const { pool, connection } = require('@trading/shared');

const { loadFormulas } = require("@trading/shared/src/formula-engine/loadFormulas.js");
const { processTopPerformers } = require("@trading/shared/src/rankings/processTopPerformers.js");

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
    cors: {
      origin: '*',
      credentials: true
    },
  });

  io.on('connection', async (socket) => {
    console.log('Client connected', socket.id);

    const stocks = await connection.get('latest_trades')
    const topPerformers = await connection.get('top_performers')
    const watchlist = await connection.get('watch_list');
    const fibSignals = await connection.get('fib_signals');

    socket.on('watchlist:subscribe', async ({ userId, date }) => {
      socket.data.userId = userId;
      socket.data.date = date;

      await connection.set(
        `watchlist_subscription:${socket.id}`,
        JSON.stringify({
          userId,
          date
        })
      );

      const data = await getWatchList(userId, date);
      socket.emit('watchlist', data);
    });

    // const query = `
    //   SELECT *
    //   FROM public.market_stock_snapshots
    //   WHERE created_at >= date_trunc('day', NOW()) + INTERVAL '8 hour'
    //     AND created_at <  date_trunc('day', NOW()) + INTERVAL '9 hour'
    //   ORDER BY created_at, symbol;`;

    // const { rows: trades } = await pool.query(query);

    // socket.emit('stocks', trades);

    // if (stocks) {
    //   socket.emit('stock-update', JSON.parse(stocks));
    // }

    if (topPerformers) {
      socket.emit('top-performers', JSON.parse(topPerformers));
    } else {
      const { rows: stocks } = await pool.query(`
        SELECT *
          FROM public.market_stock_snapshots
          WHERE created_at = (
            SELECT MAX(created_at)
            FROM public.market_stock_snapshots
          )
        `)

      const formulas = await loadFormulas(pool);
            
      const top10 =
        await processTopPerformers(
          stocks,
          formulas
        );
        
      socket.emit('top-performers', top10);
    }

    if (fibSignals) {
      socket.emit('fib-signals', JSON.parse(fibSignals));
    } else {
      const signals = await getFibSignals();
      socket.emit('fib_signals', signals);
    }

    socket.on('disconnect', async () => {
      console.log('Client disconnected', socket.id);
      await connection.del(`watchlist_subscription:${socket.id}`);
    });
  });

  return io;
}

function broadcast(data) {
  if (io) {
    io.emit('stock-update', data);
  }
}

function top10Performers(data) {
  if (io) {
    io.emit('top-performers', data);
  }
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
    console.log(`[socket] 🟢 STRONG_BUY broadcast: ${signal.symbol}`);
  }
}

async function getFibSignals() {
  try {

    const query = `
      SELECT
      fs.*,
      sw.current_price,
      sw.change_percent,
      fst.id AS signal_type_id,
      COALESCE(fl.levels, '[]'::json) AS fibonacci_levels
      FROM fibonacci_signals fs
      LEFT JOIN fibonacci_signal_types fst
        ON fst.signal_code = fs.signal_type
      LEFT JOIN LATERAL (
        SELECT *
        FROM fibonacci_swings
        WHERE symbol = fs.symbol
          AND id = fs.swing_id
        LIMIT 1
      ) sw ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', id,
            'level_percent', level_percent,
            'level_price', level_price,
            'trend_direction', trend_direction,
            'signal_id', signal_id,
            'color', color,
            'is_active', is_active
          )
          ORDER BY level_percent
        ) AS levels
        FROM fibonacci_levels
        WHERE symbol = fs.symbol
          AND is_deleted = false
      ) fl ON true
      WHERE fs.created_at::date = CURRENT_DATE;
    `
    const { rows: signals } = await pool.query(query);

    signals.sort((a, b) => {
      if (a.signal_type_id !== b.signal_type_id) {
        return a.signal_type_id - b.signal_type_id;
      }

      return b.deviation_pct - a.deviation_pct;
    });

    return signals

  } catch (err) {
    console.error(err);
  }
}

function getSignal({
  entryPrice,
  targetPercent,
  exitTarget,
  currentPrice,
  previousPrice,
  quantity,
  status,
  dropCount,
  exitAfterDrops = 3
}) {

  const exitPrice = entryPrice - exitTarget;

  if (exitPrice >= currentPrice) {
    return {
      signal: "EXIT",
      dropCount: 0
    };
  }

  // const targetPrice = entryPrice + (entryPrice * targetPercent) / 100;
  const targetPrice = entryPrice + targetPercent;

  // Target not reached yet
  if (status === "WATCH") {

    if (currentPrice >= targetPrice) {
      return {
        signal: "SELL",
        dropCount: 0
      };
    }

    return {
      signal: "WATCH",
      dropCount: 0
    };
  }

  // After exit
  if (status === "EXIT") {

    let updatedDropCount = dropCount;

    if (currentPrice < previousPrice) {
      updatedDropCount += 1;
     
    } else if (currentPrice > previousPrice) {
      updatedDropCount = 0;
      return {
        signal: "WATCH",
        dropCount: updatedDropCount
      };

    }

    return {
      signal: "EXIT",
      dropCount: updatedDropCount
    };
  }

  // After target hit
  if (status === "SELL") {

    let updatedDropCount = dropCount;

    if (currentPrice < previousPrice) {
      updatedDropCount += 1;
    } else {
      updatedDropCount = 0;
    }

    if (updatedDropCount >= exitAfterDrops) {
      return {
        signal: "EXIT",
        dropCount: updatedDropCount
      };
    }

    return {
      signal: "SELL",
      dropCount: updatedDropCount
    };
  }

  return {
    signal: status,
    dropCount
  };
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
        SELECT * 
        FROM market_stock_snapshots
        WHERE symbol = wl.symbol
        ORDER BY created_at DESC
        LIMIT 1
      ) mss ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', id,
            'watchlist_id', watchlist_id,
            'target_percent', target_percent,
            'is_active', is_active,
            'is_sell', is_sell
          )
          ORDER BY target_percent
        ) AS targets
        FROM watchlist_targets wlt
        WHERE wl.id = wlt.watchlist_id
          AND wlt.is_deleted = false
      ) wlt ON true
      WHERE wl.user_id = $1
        AND wl.created_at::date = $2
        AND wl.is_active = true 
        AND wl.is_deleted = false
    `, [userId, date]);

    const finalResult = [];
    for (const stock of watchlist.rows) {

      const snapshots = await pool.query(
        `SELECT
          last_price AS price
        FROM market_stock_snapshots
        WHERE symbol = $1
        ORDER BY created_at DESC
        LIMIT 2
        `,
        [stock.symbol]
      );

      if (snapshots.rows.length < 2) {
        continue;
      }

      if (!stock.sell_price && !stock.sell_volume) {
        const currentPrice =
          (parseFloat(snapshots.rows[0].price) / 1000) * stock.quantity;
  
        const previousPrice =
          (parseFloat(snapshots.rows[1].price) / 1000) * stock.quantity;
  
        const targetPercent = Array.isArray(stock.targets) && stock.targets.length > 0 ? 
          Math.min(...(stock.targets || []).filter(t => t.is_sell).map(t => parseFloat(t.target_percent))) : 0

        const exitTarget = Array.isArray(stock.targets) && stock.targets.length > 0 ? 
          Math.min(...(stock.targets || []).filter(t => !t.is_sell).map(t => parseFloat(t.target_percent))) : 5;
  
        const result = getSignal({
          entryPrice: (parseFloat(stock.buy_price) / 1000) * stock.quantity,
          targetPercent,
          exitTarget,
          currentPrice,
          previousPrice,
          quantity: stock.quantity,
          status: stock.status,
          dropCount: stock.drop_count,
          exitAfterDrops: 3
        });
  
        finalResult.push({
          ...stock,
          drop_count: result.dropCount,
          signal: result.signal
        })

        await pool.query(`
          UPDATE watchlists
          SET drop_count = $2,
          status = $3
          WHERE id = $1
        `, [stock.id, result.dropCount, result.signal]
        );
  
        console.log(
          `${stock.symbol} => ${result.signal}`
        );
      } else {
        finalResult.push(stock);
      }
    }

    return finalResult;
  } catch (err) {
    console.error(err);
  }
}

async function broadcastWatchList() {
  if (!io) return;

  const sockets = io.sockets.sockets.values();

  for (const socket of sockets) {

    const sub = await connection.get(`watchlist_subscription:${socket.id}`);

    if (!sub) continue;

    const { userId, date } = JSON.parse(sub);

    const data = await getWatchList(userId, date);

    socket.emit('watchlist', data);
  }
}

async function broadcastWatchListToUser(userId, date) {
  console.log('Hello from user: ', userId, date)
  const data = await getWatchList(userId, date);

  io.to(`user:${userId}`)
    .emit('watchlist', data);
}

module.exports = {
  init,
  broadcast,
  top10Performers,
  broadcastFibSignal,
  broadcastFibSignals,
  broadcastWatchList,
  broadcastWatchListToUser,
  allowedOrigins
};