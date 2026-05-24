const { Server } = require('socket.io');
const { connection } = require('@trading/shared');

let io;

function init(server) {
  io = new Server(server, {
    cors: {
      origin: '*',
    },
  });

  io.on('connection', async (socket) => {
    console.log('Client connected', socket.id);

    const stocks = await connection.get('latest_trades')
    const topPerformers = await connection.get('top_performers')

    if (stocks) {
        socket.emit('stock-update', JSON.parse(stocks));
    }

    if (topPerformers) {
        socket.emit('top-performers', JSON.parse(topPerformers));
    }

    socket.on('disconnect', () => {
      console.log('Client disconnected', socket.id);
    });
  });

  return io;
}

function broadcast(data) {
  if (io) {
    io.emit('stock-update', data);
  }
}

function top10Performers(data) {
  if (io) {
    io.emit('top-performers', data);
  }
}

module.exports = {
  init,
  broadcast,
  top10Performers,
};