require('dotenv').config();
const { broadcast } = require('index.js');

const { Worker } = require('bullmq');

const { connection } = require('@trading/shared');

const worker = new Worker(
  'socket-queue',
  async (job) => {

    if (job.name === 'socket-update') {
        const trades = job.data; // array of trade objects
        broadcast(trades);
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