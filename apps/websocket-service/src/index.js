const express = require('express');
const http = require('http');
require('dotenv').config();

const { init } = require('./socket');
require('./worker');

const app = express();

const server = http.createServer(app);

const port = process.env.PORT || 4000;

init(server);

server.listen(port, () => {
  console.log(`WebSocket server running on port ${port}`);
});