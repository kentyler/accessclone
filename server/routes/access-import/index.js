/**
 * Access Import routes — thin router that mounts sub-modules.
 */

const express = require('express');
const router = express.Router();

module.exports = function(pool) {
  // Mount each route group onto the shared router
  require('./scan')(router, pool);
  require('./export')(router, pool);
  require('./import-table')(router, pool);
  require('./import-query')(router, pool);
  require('./completeness')(router, pool);

  return router;
};
