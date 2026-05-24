require('dotenv').config();

const { Worker } = require('bullmq');
const { connection } = require('@trading/shared');

const {
  broadcast,
  top10Performers,
} = require('./socket');

const worker = new Worker(
  'socket-queue',
  async (job) => {
    console.log(job.name, job.data);

    if (job.name === 'stock-update') {
      broadcast(job.data);
    }

    if (job.name === 'top-performers') {
      top10Performers(job.data);
    }
  },
  {
    connection,
    concurrency: 5,
  }
);

worker.on('completed', (job) =>
  console.log('Job completed:', job.id)
);

worker.on('failed', (job, err) =>
  console.error('Job failed:', job?.id, err)
);

module.exports = worker;