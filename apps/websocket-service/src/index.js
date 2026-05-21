const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { connection } = require('@trading/shared');
require('dotenv').config();



const app = express();

const server = http.createServer(app);

const port = process.env.PORT || 4000

const io = new Server(server, {
    cors: {
        origin: '*',
    },
});

function broadcast(data) {
    io.emit('stock-update', data);
}

io.on('connection', async (socket) => {
    console.log('Client connected', socket.id);

    const stocks = await connection.get('latest_trades')

    if (stocks) {
        socket.emit('stock-update', JSON.parse(stocks));
    }

});

server.listen(port, () => {
    console.log(`WebSocket server running on port ${port}`);
});

module.exports = {
    broadcast,
};