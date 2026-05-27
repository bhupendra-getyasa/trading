const express = require('express');
const http = require('http');
const cors = require('cors');
const routes = require('./routes');
// const cookieParser = require("cookie-parser");
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

// parse json request body
app.use(express.json());

// parse urlencoded request body
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: function (origin, callback) {

    console.log("Origin:", origin);

    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true
}));

// enable cors
// app.use(cors());
// app.options('*', cors());
// app.use(cookieParser());

app.use('/', routes);

app.use((req, res, next) => {
  console.log("Incoming request:", req.method, req.url, req.headers.origin);
  next();
});

const errorHandler = (err, req, res, next) => {
  console.log('err: ', err);

  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
};

app.use(errorHandler);

app.get('/hii', async (req, res) => res.send('hii, User'));

const server = http.createServer(app);

const port = process.env.PORT || 4000;

init(server);

server.listen(port, () => {
  console.log(`WebSocket server running on port ${port}`);
});