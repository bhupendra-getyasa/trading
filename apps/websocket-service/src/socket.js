const { Server } = require('socket.io');
const { pool, connection } = require('@trading/shared');

const { loadFormulas } = require("@trading/shared/src/formula-engine/loadFormulas.js");
const { processTopPerformers } = require("@trading/shared/src/rankings/processTopPerformers.js");

let io;

const allowedOrigins = [
  'http://192.168.1.2:3000',
  'https://jk-traders-5c752.web.app',
  'https://jk-traders-5c752.firebaseapp.com',
  'https://carola-stylish-tasia.ngrok-free.dev'
];


function init(server) {
  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      credentials: true
    },
  });

  io.on('connection', async (socket) => {
    console.log('Client connected', socket.id);

    const stocks = await connection.get('latest_trades')
    const topPerformers = await connection.get('top_performers')

    // const query = `
    //   SELECT *
    //   FROM public.market_stock_snapshots
    //   WHERE created_at >= date_trunc('day', NOW()) + INTERVAL '8 hour'
    //     AND created_at <  date_trunc('day', NOW()) + INTERVAL '9 hour'
    //   ORDER BY created_at, symbol;`;

    // const { rows: trades } = await pool.query(query);

    // socket.emit('stocks', trades);

    if (stocks) {
      socket.emit('stock-update', JSON.parse(stocks));
    }

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

    await broadcastFibSignals();

    socket.on('disconnect', () => {
      console.log('Client disconnected', socket.id);
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

  const query = `
    SELECT
    fs.*,
    sw.current_price,
    sw.change_percent,
    COALESCE(fl.levels, '[]'::json) AS fibonacci_levels
    FROM fibonacci_signals fs
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
          'color', color
        )
        ORDER BY level_percent
      ) AS levels
      FROM fibonacci_levels
      WHERE symbol = fs.symbol
        AND is_active = true
        AND is_deleted = false
    ) fl ON true
    WHERE fs.created_at::date = CURRENT_DATE;
  `

  const { rows: signals } = await pool.query(query);

  io.emit('fib-signals', signals);

  // Cache STRONG_BUY entries for new clients that connect mid-session
  // const strongBuys = signals.filter(s => s.signalType === 'STRONG_BUY');
  // if (strongBuys.length > 0) {
  //   connection.set(
  //     'latest_strong_buys',
  //     JSON.stringify(strongBuys),
  //     'EX',
  //     3600   // expire after 1 hour
  //   ).catch(() => {});
  // }

  // console.log(
  //   `[socket] Broadcast fib-signals | total: ${signals.length} | ` +
  //   `STRONG_BUY: ${strongBuys.length}`
  // );
}

function broadcastFibSignal(signal) {
  if (!io) return;
  io.emit('fib-signal', signal);

  if (signal.signal_type === 'STRONG_BUY') {
    console.log(`[socket] 🟢 STRONG_BUY broadcast: ${signal.symbol}`);
  }
}

module.exports = {
  init,
  broadcast,
  top10Performers,
  broadcastFibSignals,
  allowedOrigins
};