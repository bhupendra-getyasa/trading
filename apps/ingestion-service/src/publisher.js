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

// Push ONLY the symbols that just entered the radar this cycle, so the websocket service
// can emit a `radar:new` pop-up per new stock instead of re-broadcasting the whole list.
async function publishRadarNew(date, symbols) {
  if (!date || !symbols || !symbols.length) return;
  await socketQueue.add('radar-new', { date, symbols }, { removeOnComplete: true, removeOnFail: true });
}

// TMI ticks EVERY minute on the snapshot the live scan just processed — not only when
// something newly qualifies, because open positions need managing on quiet minutes too
// (the quiet-tape exit exists precisely for minutes where nothing else happens).
// Queued separately so a slow or failing execution layer can never delay the radar.
async function publishTmiTick(date) {
  await socketQueue.add('tmi-tick', { date }, { removeOnComplete: true, removeOnFail: true });
}

module.exports = {
    publishStock,
    publishRadar,
    publishRadarNew,
    publishTmiTick
};