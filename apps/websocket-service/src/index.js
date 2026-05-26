const express = require('express');
const http = require('http');
const cors = require('cors');
require('dotenv').config();

const { init } = require('./socket');
require('./worker');

const allowedOrigins = [
  'http://192.168.1.2:3000',
  'https://jk-traders-5c752.web.app',
  'https://jk-traders-5c752.firebaseapp.com',
  'https://carola-stylish-tasia.ngrok-free.dev'
];

const app = express();

app.use((req, res, next) => {
  console.log("Incoming request:", req.method, req.url, req.headers.origin);
  next();
});

app.use(cors({
  origin: function (origin, callback) {
    console.log("Origin:", origin);

    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  }
}));

app.get('/hii', async (req, res) => res.send('hii, User'));

const server = http.createServer(app);

const port = process.env.PORT || 4000;

init(server);

server.listen(port, () => {
  console.log(`WebSocket server running on port ${port}`);
});