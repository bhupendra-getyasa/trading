require('dotenv').config();

const { Worker } = require('bullmq');

const { connection, pool } = require('@trading/shared');

const { scrapeStocks } = require('./scraper');
const { publishStock } = require('./publisher');



const worker = new Worker(
  'stock-queue',
  async (job) => {

    if (job.name === 'scrape-job') {
      console.log(`[${new Date().toISOString()}] Scraping started`);
      const stocks = await scrapeStocks();
      await publishStock(stocks);

      // Optionally log
      console.log(`[${new Date().toISOString()}] Scraping finished`);
    } else if (job.name === 'stock-update') {
        const trades = job.data; // array of trade objects
    
        if (!trades || trades.length === 0) return;
    
        // Generate bulk insert query
        const values = [];
        const placeholders = trades.map((trade, i) => {
          const idx = i * 10; // 10 columns
          values.push(
            trade.symbol,
            trade.companyName,
            trade.stockUrl,
            trade.lastPrice,
            trade.changePercent,
            trade.change,
            trade.volume,
            trade.avgVolume,
            trade.marketCap,
            trade.createdAt || new Date().toISOString()
          );
    
          return `(
            $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5},
            $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10}
          )`;
        }).join(',');
    
        const query = `
          INSERT INTO trades
          (
            symbol, company_name, stock_url, last_price, change_percent,
            change, volume, avg_volume, market_cap, created_at
          )
          VALUES ${placeholders}
          ON CONFLICT (id) DO NOTHING
        `;
    
        try {
          await pool.query(query, values);
          console.log(`Inserted ${trades.length} trades into DB`);
    
          // Store latest trades in Redis under a key "latest_trades"
          await connection.set('latest_trades', JSON.stringify(trades));

          // console.log(await connection.get('latest_trades'))
    
          console.log('Updated Redis with latest trades');
        } catch (err) {
          console.error('Error inserting trades:', err);
        }
    }
  },
  {
    connection,
    concurrency: 5,
  }
);

worker.on('completed', (job) => console.log('Job completed:', job.id));
worker.on('failed', (job, err) => console.error('Job failed:', job.id, err));

module.exports = worker;