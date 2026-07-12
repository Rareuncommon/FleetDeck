'use strict';

const express = require('express');
const {
  armGoldenBuild, endGoldenBuild, setGoldenBuildPhase, setChecklistStep,
  CHECKLIST, DEFAULT_DURATION_MINUTES,
} = require('../services/goldenBuild');
const { writeGeneratedScripts } = require('../services/deployScript');
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
      // Snapshot the generated deploy.cmd + safety.ps1 into the HTTP dir so
      // the SMB share (WinPE's guaranteed transport) carries fresh copies.
      try {
        writeGeneratedScripts(ctx, `http://${req.get('host')}`);
      } catch (err) {
        console.error('[goldenBuild] writing generated scripts failed:', err.message);
      }
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
      return res.status(200).json({
        active: getActiveGoldenBuildSession(db),
        checklist: CHECKLIST,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Phase switch (install <-> boot_installed). Like arm/end this changes
  // only what boot.js serves next — no TrueNAS mutation, not DRY_RUN gated.
  router.post('/api/golden-build/phase', (req, res) => {
    try {
      const phase = req.body && req.body.phase;
      const session = setGoldenBuildPhase(ctx, phase);
      return res.status(200).json(session);
    } catch (err) {
      const status = /Unknown|No active/.test(err.message) ? 400 : 500;
      return res.status(status).json({ error: err.message });
    }
  });

  router.post('/api/golden-build/checklist', (req, res) => {
    try {
      const { step, done } = req.body || {};
      const session = setChecklistStep(ctx, step, done);
      return res.status(200).json(session);
    } catch (err) {
      const status = /Unknown|No active/.test(err.message) ? 400 : 500;
      return res.status(status).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createGoldenBuildRouter };
