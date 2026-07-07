'use strict';

const express = require('express');
const {
  listClients, getClient, updateClient,
  listDiscovered, removeDiscovered,
} = require('../db');
const { normalizeMac } = require('../services/mac');
const {
  createClient, resetClient, rebaseClient, retireClient,
} = require('../services/clientOps');

function opErrorStatus(message) {
  const m = String(message || '').toLowerCase();
  if (m.includes('already exists') || m.includes('collision')) return 409;
  if (m.includes('session') || m.includes('force')) return 409;
  return 500;
}

function createClientsRouter(ctx) {
  const router = express.Router();
  const { db } = ctx;

  router.get('/api/clients', (req, res) => {
    try {
      return res.status(200).json(listClients(db));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/clients/:id', (req, res) => {
    try {
      const client = getClient(db, req.params.id);
      if (!client) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(client);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/clients', async (req, res) => {
    try {
      const body = req.body || {};
      const { name } = body;
      if (typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'name is required' });
      }
      let mac;
      try {
        mac = normalizeMac(body.mac);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const client = await createClient(ctx, { name, mac });
      return res.status(201).json(client);
    } catch (err) {
      return res.status(opErrorStatus(err.message)).json({ error: err.message });
    }
  });

  router.post('/api/clients/:id/reset', async (req, res) => {
    try {
      const id = req.params.id;
      if (!getClient(db, id)) return res.status(404).json({ error: 'Not found' });
      const force = !!(req.body && req.body.force);
      const client = await resetClient(ctx, id, { force });
      return res.status(200).json(client);
    } catch (err) {
      return res.status(opErrorStatus(err.message)).json({ error: err.message });
    }
  });

  router.post('/api/clients/:id/rebase', async (req, res) => {
    try {
      const id = req.params.id;
      const body = req.body || {};
      if (!body.goldenSnapshot) {
        return res.status(400).json({ error: 'goldenSnapshot is required' });
      }
      if (!getClient(db, id)) return res.status(404).json({ error: 'Not found' });
      const client = await rebaseClient(ctx, id, {
        goldenSnapshot: body.goldenSnapshot,
        force: !!body.force,
      });
      return res.status(200).json(client);
    } catch (err) {
      return res.status(opErrorStatus(err.message)).json({ error: err.message });
    }
  });

  router.delete('/api/clients/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (!getClient(db, id)) return res.status(404).json({ error: 'Not found' });
      await retireClient(ctx, id);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/clients/:id/boot-golden-once', (req, res) => {
    try {
      const id = req.params.id;
      if (!getClient(db, id)) return res.status(404).json({ error: 'Not found' });
      updateClient(db, id, { boot_golden_once: 1 });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/clients/:id/nightly-reset', (req, res) => {
    try {
      const id = req.params.id;
      if (!getClient(db, id)) return res.status(404).json({ error: 'Not found' });
      const enabled = !!(req.body && req.body.enabled);
      updateClient(db, id, { nightly_reset: enabled ? 1 : 0 });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/discovered/:mac/adopt', async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return res.status(400).json({ error: 'name is required' });
      }
      let mac;
      try {
        mac = normalizeMac(req.params.mac);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const client = await createClient(ctx, { name: body.name, mac });
      // In DRY_RUN, createClient returns a fake row (id: null) without
      // inserting anything — clearing the discovered record here would make
      // the machine vanish from both lists until it boots again.
      if (client && client.id != null) {
        removeDiscovered(db, mac);
      }
      return res.status(201).json(client);
    } catch (err) {
      return res.status(opErrorStatus(err.message)).json({ error: err.message });
    }
  });

  router.get('/api/discovered', (req, res) => {
    try {
      return res.status(200).json(listDiscovered(db));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createClientsRouter };
