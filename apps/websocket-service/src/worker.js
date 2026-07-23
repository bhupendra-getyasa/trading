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
  broadcastWatchListToUser,
  broadcastRadar,
  broadcastTmi,
  emitRadarNew,
} = require('./socket');

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

      // TMI ticks right after the radar, on the same snapshot the radar just used.
      // Its failure is swallowed on purpose: the execution layer must never be able to
      // take down the radar the user actually relies on every day.
      case 'tmi-tick':
        return broadcastTmi(job.data && job.data.date).catch((e) =>
          console.warn('[tmi] tick failed:', e.message));

      case 'radar-update':
        return broadcastRadar();

      case 'radar-new':
        return emitRadarNew(job.data.date, job.data.symbols);

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