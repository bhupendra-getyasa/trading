require('dotenv').config();

const { Worker } = require('bullmq');

const { connection, pool, socketQueue } = require('@trading/shared');
const { loadFormulas } = require("@trading/shared/src/formula-engine/loadFormulas.js");
const { saveTopPerformers } = require("@trading/shared/src/rankings/saveRankings.js");
const { processTopPerformers } = require("@trading/shared/src/rankings/processTopPerformers.js");

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

        // Store latest trades in Redis under a key "latest_trades"
        await connection.set('latest_trades', JSON.stringify(trades));

        // console.log(await connection.get('latest_trades'))
        console.log('Updated Redis with latest trades');
    
        // Generate bulk insert query
        const values = [];
        const createdAt = new Date().toISOString();
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
            createdAt
          );
    
          return `(
            $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5},
            $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10}
          )`;
        }).join(',');
    
        const query = `
          INSERT INTO market_stock_snapshots
          (
            symbol, company_name, stock_url, last_price, change_percent,
            change, volume, avg_volume, market_cap, created_at
          )
          VALUES ${placeholders}
          ON CONFLICT (id) DO NOTHING
          RETURNING *;
        `;
    
        try {
          const { rows: stocks } = await pool.query(query, values);
          console.log(`Inserted ${trades.length} trades into DB`);
    
          // await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY latest_market_view;`);
          // console.log("latest_market_view refreshed");

          // const { rows: stocks } =
          // await pool.query(`
          //   SELECT *
          //   FROM latest_market_view
          // `);

          const formulas = await loadFormulas(pool);
            
          const top10 =
          await processTopPerformers(
            stocks,
            formulas
          );

          await connection.set('top_performers', JSON.stringify(top10));

          await socketQueue.add('top-performers', top10);
          
          // await saveTopPerformers(
          //   pool,
          //   top10
          // );

          // console.log(
          //   "Top performers updated"
          // );

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