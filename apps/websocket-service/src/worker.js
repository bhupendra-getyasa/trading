require('dotenv').config();

const { Worker } = require('bullmq');
const { connection, sendSMS } = require('@trading/shared');

const {
  broadcast,
  top10Performers,
} = require('./socket');

const worker = new Worker(
  'socket-queue',
  async (job) => {

    if (job.name === 'stock-update') {
      broadcast(job.data);
    } else if (job.name === 'top-performers') {
      top10Performers(job.data);
    } else if (job.name === 'send-sms') {
      // console.log('job: ', job.data);
      // await sendSMS(job.data.mobile, job.data.dialcode, job.data.otp);
    }
  },
  {
    connection,
    concurrency: 1,
  }
);

worker.on('completed', (job) =>
  console.log('Job completed:', job.id)
);

worker.on('failed', (job, err) =>
  console.error('Job failed:', job?.id, err)
);

module.exports = worker;