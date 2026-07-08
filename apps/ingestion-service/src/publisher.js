const {
    socketQueue,
    stockUpdateQueue
} = require('@trading/shared');

async function publishStock(data) {

    await socketQueue.add('stock-update', data, {
        removeOnComplete: true,
        removeOnFail: true
    });

    await stockUpdateQueue.add('stock-update', data, {
        removeOnComplete: true,
        removeOnFail: { count: 500 },
    });

}

async function publishRadar() {
  await socketQueue.add('radar-update', {}, { removeOnComplete: true, removeOnFail: true });
}

module.exports = {
    publishStock,
    publishRadar
};