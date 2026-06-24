require('dotenv').config();

const { Worker } = require('bullmq');
const { connection, sendSMS } = require('@trading/shared');

const {
  broadcast,
  top10Performers,
  broadcastFibSignal,
  broadcastFibSignals,
  broadcastMostActive,
  broadcastWatchList,
  broadcastWatchListToUser
} = require('./socket');

// const worker = new Worker(
//   'socket-queue',
//   async (job) => {

//     if (job.name === 'stock-update') {
//       broadcast(job.data);
//     } else if (job.name === 'top-performers') {
//       top10Performers(job.data);
//     } else if (job.name === 'send-sms') {
//       // console.log('job: ', job.data);
//       // await sendSMS(job.data.mobile, job.data.dialcode, job.data.otp);
//     } else if (job.name === 'fib-signals') {
//       broadcastFibSignals()
//     } else if (job.name === 'watchlist') {
//       broadcastWatchList()
//     }
//   },
//   {
//     connection,
//     concurrency: 1,
//   }
// );

const worker = new Worker(
  'socket-queue',
  async (job) => {
    switch (job.name) {
      case 'stock-update':
        return broadcast(job.data);

      case 'top-performers':
        return top10Performers(job.data);

      // case 'send-sms':
      //   return sendSMS(
      //     job.data.mobile,
      //     job.data.dialcode,
      //     job.data.otp
      //   );

      case 'fib-signal':
        return broadcastFibSignal();

      case 'fib-signals':
        return broadcastFibSignals();

      case 'most-active':
        return broadcastMostActive(job.data);

      case 'watchlist':
        return broadcastWatchList();

      case 'watchlist-updated':
        return broadcastWatchListToUser(
          job.data.userId,
          job.data.date
        );

      default:
        throw new Error(`Unknown job type: ${job.name}`);
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