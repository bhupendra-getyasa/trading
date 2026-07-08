const { Queue } = require('bullmq');
const { connection } = require('../redis/connection');

const socketQueue = new Queue('socket-queue', {
    connection,
});

const stockQueue = new Queue('stock-queue', {
    connection,
});

const analyticsQueue = new Queue('analytics-queue', {
    connection,
});

const aiQueue = new Queue('ai-queue', {
    connection,
});

const notificationQueue = new Queue('notification-queue', {
    connection,
});

const fibQueue = new Queue('fib-queue', {
    connection,
});

const transformQueue = new Queue('signal-transform', {
  connection: connection,
  defaultJobOptions: {
    attempts:    2,
    backoff:     { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 20 },   // keep last 20 completed jobs
    removeOnFail:     { count: 10 },
  },
});

module.exports = {
    socketQueue,
    stockQueue,
    analyticsQueue,
    aiQueue,
    notificationQueue,
    fibQueue,
    transformQueue
};