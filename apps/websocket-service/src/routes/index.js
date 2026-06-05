const express = require('express');
const authRoute = require('./auth');
const fibLevelRoute = require('./fibLevel');

const router = express.Router();

const defaultRoutes = [
  {
    path: '/auth',
    route: authRoute,
  },
  {
    path: '/fib-level',
    route: fibLevelRoute,
  }
]

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

module.exports = router;