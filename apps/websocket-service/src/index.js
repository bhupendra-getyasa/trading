const express = require('express');
const http = require('http');
const cors = require('cors');
const routes = require('./routes');
const { pool } = require('@trading/shared');
// const cookieParser = require("cookie-parser");
require('dotenv').config();

const { init } = require('./socket');
require('./worker');

const allowedOrigins = [
  'http:localhost:3000',
  'http:localhost:3001',
  'http://192.168.1.2:3000',
  'https://jk-traders-5c752.web.app',
  'https://jk-traders-5c752.firebaseapp.com',
  'https://carola-stylish-tasia.ngrok-free.dev'
];

const app = express();

// parse json request body
app.use(express.json());

// parse urlencoded request body
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  // origin: function (origin, callback) {

  //   console.log("Origin:", origin);

  //   if (!origin) {
  //     return callback(null, true);
  //   }

  //   if (allowedOrigins.includes(origin)) {
  //     return callback(null, true);
  //   }

  //   return callback(new Error("Not allowed by CORS"));
  // },
  origin: '*',
  credentials: true
}));

// enable cors
// app.use(cors());
// app.options('*', cors());
// app.use(cookieParser());

app.use('/', routes);

app.use((req, res, next) => {
  console.log("Incoming request:", req.method, req.url, req.headers.origin);
  next();
});

const errorHandler = (err, req, res, next) => {
  console.log('err: ', err);

  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
};

app.use(errorHandler);

app.get('/hii', async (req, res) => res.send('hii, User'));

app.get('/stocks/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;

    //
    // Latest snapshot
    //
    const stockResult = await pool.query(`
      SELECT *
      FROM market_stock_snapshots
      WHERE symbol = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [symbol]);

    if (!stockResult.rows.length) {
      return res.status(404).json({
        message: 'Stock not found'
      });
    }

    const stock = stockResult.rows[0];

    //
    // Previous snapshots
    // Used for history + sparkline
    //
    const historyResult = await pool.query(`
      SELECT
          created_at,
          last_price AS price,
          volume AS volume
      FROM market_stock_snapshots
      WHERE symbol = $1
      ORDER BY created_at ASC
      LIMIT 50
    `, [symbol]);

    //
    // Active swing
    //
    const swingResult = await pool.query(`
      SELECT *
      FROM fibonacci_swings
      WHERE symbol = $1
      AND status = 'ACTIVE'
      ORDER BY created_at DESC
      LIMIT 1
    `, [symbol]);

    const swing = swingResult.rows[0];

    //
    // Build history candles
    //

    const uniqueRows = [];
    const seenTimes = new Set();

    for (const row of historyResult.rows) {
      const timestamp = Math.floor(
        new Date(row.created_at).getTime() / 1000
      );

      // Skip duplicates
      if (seenTimes.has(timestamp)) {
        continue;
      }

      seenTimes.add(timestamp);
      uniqueRows.push(row);
    }

    const history = uniqueRows.map((row, index, arr) => {
      const previousPrice =
        index === 0
          ? parseFloat(row.price)
          : parseFloat(arr[index - 1].price);

      const currentPrice = parseFloat(row.price);

      return {
        time: row.created_at,

        displayTime: new Date(row.created_at).toLocaleTimeString(
          'en-US',
          {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          }
        ),

        open: previousPrice,
        high: Math.max(previousPrice, currentPrice),
        low: Math.min(previousPrice, currentPrice),
        close: currentPrice,
        volume: parseFloat(row.volume)
      };
    });

    //
    // Sparkline
    //
    const sparkline = historyResult.rows
      .slice(-20)
      .map(r => parseInt(r.price));

    //
    // Momentum
    //
    const firstPrice =
      parseFloat(historyResult.rows[0]?.price || stock.last_price);

    const lastPrice =
      parseFloat(stock.last_price);

    const momentum =
      ((lastPrice - firstPrice) / firstPrice) * 100;

    //
    // Relative Volume
    //
    const avgVolume =
      historyResult.rows.reduce(
        (sum, row) => sum + parseInt(row.volume),
        0
      ) / historyResult.rows.length;

    const rvol =
      avgVolume > 0
        ? parseFloat(stock.volume) / avgVolume
        : 1;

    //
    // Growth Status
    //
    const growthStatus =
      parseFloat(stock.change_percent) > 0
        ? 'bullish'
        : 'bearish';

    //
    // AI Recommendation
    //
    let aiRecommendation = 'NEUTRAL';

    if (momentum > 5) {
      aiRecommendation = 'MOMENTUM PLAY';
    } else if (momentum > 2) {
      aiRecommendation = 'BUY';
    } else if (momentum < -5) {
      aiRecommendation = 'SELL';
    }

    return res.status(200).json({
      success: true, 
      message: 'Stock fetched successfully',
      data: {
        symbol: stock.symbol,
        name: stock.company_name,
  
        price: parseFloat(stock.last_price),
        change: parseFloat(stock.change),
        changePercent: parseFloat(stock.change_percent),
  
        volume: parseFloat(stock.volume),
        marketCap: parseFloat(stock.market_cap),
  
        momentum,
  
        lastUpdated: stock.created_at,
  
        sector:
          swing?.trend_direction === 'BULLISH'
            ? 'Industrials'
            : 'Financials',
  
        rvol,
  
        growthStatus,
  
        sparkline,
  
        aiRecommendation,
  
        history
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: error.message
    });
  }
});

const server = http.createServer(app);

const port = process.env.PORT || 4000;

init(server);

server.listen(port, () => {
  console.log(`WebSocket server running on port ${port}`);
});