const {
    socketQueue,
    stockQueue,
    analyticsQueue,
    aiQueue,
} = require('@trading/shared');

async function publishStock(data) {

    await socketQueue.add('stock-update', data);

    await stockQueue.add('stock-update', data);

    // await analyticsQueue.add('analytics-job', data);

    // await aiQueue.add('ai-signal-job', data);
}

module.exports = {
    publishStock,
};