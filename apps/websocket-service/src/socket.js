const { Server } = require('socket.io');
const { connection } = require('@trading/shared');

let io;

const allowedOrigins = [
  'http://192.168.1.2:3000',
  'https://jk-traders-5c752.web.app',
  'https://jk-traders-5c752.firebaseapp.com',
  'https://carola-stylish-tasia.ngrok-free.dev'
];


function init(server) {
  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      credentials: true
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
  allowedOrigins
};