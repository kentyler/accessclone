/**
 * Access Import routes — thin router that mounts sub-modules.
 */

const express = require('express');
const router = express.Router();

module.exports = function(pool, secrets) {
  // Mount each route group onto the shared router
  require('./scan')(router, pool);
  require('./export')(router, pool);
  require('./import-table')(router, pool);
  require('./import-query')(router, pool, secrets);
  require('./import-images')(router, pool);
  require('./import-attachments')(router, pool);
  require('./completeness')(router, pool);
  require('./assess')(router, pool);
  require('./apply-fixes')(router, pool);
  require('./run')(router, pool);
  require('./repair-pass')(router, pool);
  require('./validation-pass')(router, pool);
  require('./autofix-pass')(router, pool, secrets);
  require('./property-catalog')(router, pool);
  require('./translate-modules')(router, pool, secrets);
  require('./extract-object-intents')(router, pool, secrets);
  require('./wire-events')(router, pool);

  return router;
};
