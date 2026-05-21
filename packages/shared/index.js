module.exports = {
    ...require('./src/db/postgres'),
    ...require('./src/redis/connection'),
    ...require('./src/bullmq/queues'),
};
