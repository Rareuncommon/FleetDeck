'use strict';

const express = require('express');
const { listClients } = require('../db');
const { promoteGolden, rebaseClient } = require('../services/clientOps');

function nextVersionLabel(snapshots) {
  let max = 0;
  for (const snap of snapshots) {
    const m = /^gold-v(\d+)$/.exec(snap.name || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `v${max + 1}`;
}

function createGoldenRouter(ctx) {
  const router = express.Router();
  // db/config never change after startup, but ctx.adapter can be replaced by
  // a reconnect after a TrueNAS disconnect — read it fresh per request rather
  // than destructuring it once here, or a reconnect would never be seen.
  const { db, config } = ctx;

  router.get('/api/golden/snapshots', async (req, res) => {
    try {
      if (!ctx.adapter) return res.status(500).json({ error: 'TrueNAS adapter unavailable' });
      const snapshots = await ctx.adapter.listGoldenSnapshots(config.goldenZvol);
      const clients = listClients(db);
      const annotated = snapshots.map((snap) => ({
        ...snap,
        clients: clients
          .filter((c) => c.golden_snapshot === snap.name)
          .map((c) => ({ id: c.id, name: c.name })),
      }));
      return res.status(200).json(annotated);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/golden/promote', async (req, res) => {
    try {
      const body = req.body || {};
      let label = body.versionLabel;
      if (!label) {
        if (!ctx.adapter) return res.status(500).json({ error: 'TrueNAS adapter unavailable' });
        const snapshots = await ctx.adapter.listGoldenSnapshots(config.goldenZvol);
        label = nextVersionLabel(snapshots);
      }
      const versionLabel = String(label).startsWith('gold-') ? String(label) : `gold-${label}`;
      const snapshotName = await promoteGolden(ctx, { versionLabel });
      return res.status(200).json({ snapshot: snapshotName });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/golden/bulk-rebase', async (req, res) => {
    try {
      const body = req.body || {};
      const clientIds = Array.isArray(body.clientIds) ? body.clientIds : [];
      const force = !!body.force;
      const results = [];
      for (const id of clientIds) {
        try {
          await rebaseClient(ctx, id, { goldenSnapshot: body.goldenSnapshot, force });
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.message });
        }
      }
      return res.status(200).json({ results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createGoldenRouter };
