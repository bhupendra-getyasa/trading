const {
    socketQueue,
    stockQueue,
    analyticsQueue,
    aiQueue,
} = require('@trading/shared');

async function publishStock(data) {

    await socketQueue.add('stock-update', data, {
        removeOnComplete: true,
        removeOnFail: true
    });

    await stockQueue.add('stock-update', data, {
        removeOnComplete: true,
        removeOnFail: { count: 500 },
    });

    // await analyticsQueue.add('analytics-job', data);

    // await aiQueue.add('ai-signal-job', data);
}

module.exports = {
    publishStock,
};