const { Queue } = require('bullmq');
const { connection } = require('../redis/connection');

const socketQueue = new Queue('socket-queue', {
    connection,
});

const stockQueue = new Queue('stock-queue', {
    connection,
});

const scrapeQueue = new Queue('scrape-queue', {
    connection,
});

const stockUpdateQueue = new Queue('stock-update-queue', {
    connection,
});

const watchlistQueue = new Queue('watchlist', {
    connection,
});

const analyticsQueue = new Queue('analytics-queue', {
    connection,
});

const liveQueue = new Queue('live-queue', {
    connection,
});

const notificationQueue = new Queue('notification-queue', {
    connection,
});

module.exports = {
    socketQueue,
    stockQueue,
    scrapeQueue,
    stockUpdateQueue,
    watchlistQueue,
    analyticsQueue,
    liveQueue,
    notificationQueue
};