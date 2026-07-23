'use strict';
const express = require('express');
const agentRoute = require('./agent');

const router = express.Router();

const defaultRoutes = [
  {
    path: '/agent',
    route: agentRoute,
  },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

module.exports = router;
