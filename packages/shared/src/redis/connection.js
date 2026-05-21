const IORedis = require('ioredis');
require('dotenv').config();

const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6379;

console.log('REDIS_HOST: ', REDIS_HOST);
console.log('REDIS_PORT: ', REDIS_PORT);

const connection = new IORedis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
});

connection.on('connect', () => {
    console.log('Redis connected');
});

connection.on('error', (err) => {
    console.error('Redis error:', err);
});

module.exports = {
    connection
} 