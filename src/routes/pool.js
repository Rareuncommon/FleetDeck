'use strict';
const express = require('express');

function createPoolRouter(ctx) {
  const router = express.Router();

  router.get('/api/pool/status', (req, res) => {
    try {
      // ctx.poolMonitor is attached by the integrator's server.js after calling startPoolMonitor(ctx);
      // read it live per-request (don't destructure at router-construction time) since it's attached
      // to ctx AFTER this router is created during server startup.
      if (!ctx.poolMonitor) {
        return res.status(200).json({ status: null, poolName: ctx.config.poolName || null });
      }
      const status = ctx.poolMonitor.getStatus();
      return res.status(200).json({ status, poolName: ctx.config.poolName || null });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createPoolRouter };
