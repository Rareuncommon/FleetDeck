'use strict';
const express = require('express');
const { TrueNASClient } = require('../truenas/client');
const { TrueNASAdapter } = require('../truenas/adapter');

const TEST_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // clearTimeout in a finally so the losing timer never keeps the event loop
  // alive after the race settles (a leaked timer per request otherwise).
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createTrueNasStatusRouter(ctx) {
  const router = express.Router();

  router.post('/api/truenas/test-connection', async (req, res) => {
    // Read ctx.config live (not destructured at router-construction time) in case the
    // integrator's server.js ever supports reloading config without a full restart.
    const { truenasUrl, truenasApiKey } = ctx.config;
    let client = null;
    try {
      client = new TrueNASClient({ url: truenasUrl, apiKey: truenasApiKey });
      await withTimeout(client.connect(), TEST_TIMEOUT_MS, `Connection timed out after ${TEST_TIMEOUT_MS}ms`);
      const adapter = new TrueNASAdapter(client);
      const methods = await withTimeout(adapter.introspect(), TEST_TIMEOUT_MS, `Introspection timed out after ${TEST_TIMEOUT_MS}ms`);
      return res.status(200).json({ ok: true, methodsResolved: Object.keys(methods || {}).length });
    } catch (err) {
      // A failed connectivity test is an expected, valid outcome for this endpoint, not a
      // server error — always 200, let the body's `ok` field carry the result.
      return res.status(200).json({ ok: false, error: err.message });
    } finally {
      if (client) {
        try { await client.close(); } catch (_) { /* already closed/closing */ }
      }
    }
  });

  return router;
}

module.exports = { createTrueNasStatusRouter };
