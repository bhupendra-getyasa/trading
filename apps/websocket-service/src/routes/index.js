const express = require('express');
const authRoute = require('./auth');
const fibLevelRoute = require('./fibLevel');
const stockDetail = require('./stockDetail');
const watchList = require('./watchList');
const tmiExport = require('./tmiExport');

const router = express.Router();

const defaultRoutes = [
  {
    path: '/auth',
    route: authRoute,
  },
  {
    path: '/fib-level',
    route: fibLevelRoute,
  },
  {
    path: '/stock-detail',
    route: stockDetail,
  },
  {
    path: '/watch-list',
    route: watchList,
  },
  {
    path: '/tmi/export',
    route: tmiExport,
  },
]

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

module.exports = router;