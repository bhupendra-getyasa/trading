const { Pool } = require('pg');
require('dotenv').config();


const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    // host: 'trading-db.cip64s8oy79k.us-east-1.rds.amazonaws.com',
    // port: 5432,
    // user: 'postgres',
    // password: 'QwerPoiu12',
    // database: 'trading',

    max: 10,
    // idleTimeoutMillis: 30000,
    // connectionTimeoutMillis: 2000,

    ssl: {
        rejectUnauthorized: false
    }
});

pool.on('connect', () => {
    console.log('PostgreSQL Connected');
});

pool.on('error', (err) => {
    console.error('PostgreSQL Error:', err);
});

module.exports = {
    pool
};