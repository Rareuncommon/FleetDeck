'use strict';

const express = require('express');
const { armGoldenBuild, endGoldenBuild, DEFAULT_DURATION_MINUTES } = require('../services/goldenBuild');
const { getActiveGoldenBuildSession, getSetting } = require('../db');

function createGoldenBuildRouter(ctx) {
  const router = express.Router();
  const { db } = ctx;

  // POST /api/golden-build/arm — arm a MAC for direct golden-image write access.
  //
  // Intentionally NOT gated by DRY_RUN. This is a control-plane change: it
  // touches only FleetDeck's own DB and what boot.js serves, performing no
  // TrueNAS mutation, so it sits in the same category as boot-script serving
  // (also never DRY_RUN gated) rather than the mutating actions in
  // clientOps.js. The stakes are still real — an armed machine can write to
  // the live golden image on its next PXE boot even when DRY_RUN=1 — which is
  // why the guards here are the single-active-session invariant, the
  // golden-target iSCSI session check, and the UI's explicit confirmation,
  // NOT DRY_RUN. See services/goldenBuild.js and the PR description.
  router.post('/api/golden-build/arm', async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.mac !== 'string' || !body.mac.trim()) {
        return res.status(400).json({ error: 'mac is required' });
      }
      let durationMinutes = parseInt(body.duration_minutes, 10);
      if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
        const def = parseInt(getSetting(db, 'golden_build_default_minutes', String(DEFAULT_DURATION_MINUTES)), 10);
        durationMinutes = Number.isInteger(def) && def > 0 ? def : DEFAULT_DURATION_MINUTES;
      }
      const session = await armGoldenBuild(ctx, { mac: body.mac.trim(), durationMinutes });
      return res.status(201).json(session);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/api/golden-build/end', (req, res) => {
    try {
      // Idempotent: ending when nothing is active returns { ended: null }, 200.
      const ended = endGoldenBuild(ctx, { reason: 'manual' });
      return res.status(200).json({ ended: ended || null });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/golden-build/status', (req, res) => {
    try {
      return res.status(200).json({ active: getActiveGoldenBuildSession(db) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createGoldenBuildRouter };
