'use strict';

const express = require('express');
const cron = require('node-cron');

const {
  listClients, getSetting, logEvent,
  listMaintenanceWindows, insertMaintenanceWindow, deleteMaintenanceWindow,
  listAdmins, getAdminByUsername, insertAdmin, deleteAdmin, countAdmins,
} = require('../db');
const { hashPassword } = require('./auth');
const { sendWakeOnLan } = require('../services/wol');

function createFleetOpsRouter(ctx) {
  const router = express.Router();
  const { db } = ctx;

  // ---- wake-all (item 28) --------------------------------------------------
  // WoL is inherently fire-and-forget and non-destructive, so unlike resets
  // there is no per-machine confirmation or DRY_RUN gate — it mutates
  // nothing, on TrueNAS or otherwise.
  router.post('/api/clients/wake-all', async (req, res) => {
    try {
      const broadcastAddress = getSetting(db, 'wol_broadcast', '255.255.255.255');
      const clients = listClients(db).filter((c) => c.mac);
      let sent = 0, failed = 0;
      for (const c of clients) {
        try {
          await sendWakeOnLan(c.mac, { broadcastAddress });
          sent += 1;
        } catch (err) {
          failed += 1;
        }
      }
      logEvent(db, { action: 'fleet.wake_all', actor: req.adminUser || 'system', after: { sent, failed } });
      return res.status(200).json({ sent, failed });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- maintenance windows (item 29) ---------------------------------------

  router.get('/api/maintenance-windows', (req, res) => {
    try {
      return res.status(200).json(listMaintenanceWindows(db));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/maintenance-windows', (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.cron !== 'string' || !cron.validate(body.cron)) {
        return res.status(400).json({ error: 'cron must be a valid 5-field cron expression' });
      }
      if (!['reset', 'wake'].includes(body.action)) {
        return res.status(400).json({ error: 'action must be "reset" or "wake"' });
      }
      const tag = typeof body.tag === 'string' ? body.tag.trim() : '';
      const id = insertMaintenanceWindow(db, { tag, cron: body.cron, action: body.action });
      logEvent(db, { action: 'maintenance_window.created', actor: req.adminUser || 'system', after: { id, tag, cron: body.cron, action: body.action } });
      // Scheduler re-reads window definitions (same live-reschedule pattern
      // as nightly_reset_cron edits).
      if (ctx.rescheduleWindows) ctx.rescheduleWindows();
      return res.status(201).json({ id });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/maintenance-windows/:id', (req, res) => {
    try {
      deleteMaintenanceWindow(db, req.params.id);
      logEvent(db, { action: 'maintenance_window.deleted', actor: req.adminUser || 'system', after: { id: req.params.id } });
      if (ctx.rescheduleWindows) ctx.rescheduleWindows();
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- admin accounts (item 38) ---------------------------------------------

  router.get('/api/admins', (req, res) => {
    try {
      // Hashes never leave the server; the list is names + metadata only.
      return res.status(200).json(listAdmins(db));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admins', (req, res) => {
    try {
      const body = req.body || {};
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) {
        return res.status(400).json({ error: 'username must be 2-32 chars of letters/digits/_.-' });
      }
      if (typeof body.password !== 'string' || body.password.length < 8) {
        return res.status(400).json({ error: 'password must be at least 8 characters' });
      }
      if (getAdminByUsername(db, username)) {
        return res.status(409).json({ error: `admin "${username}" already exists` });
      }
      const id = insertAdmin(db, { username, passwordHash: hashPassword(body.password) });
      logEvent(db, { action: 'admin.created', actor: req.adminUser || 'system', after: { username } });
      return res.status(201).json({ id, username });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/admins/:id', (req, res) => {
    try {
      // Refuse deleting the last named account: with the table non-empty the
      // env password is disabled, so removing the final row would otherwise
      // lock everyone out until a restart-with-env dance.
      const admins = listAdmins(db);
      const target = admins.find((a) => String(a.id) === String(req.params.id));
      if (!target) return res.status(404).json({ error: 'Not found' });
      if (countAdmins(db) === 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin account (it would lock everyone out)' });
      }
      deleteAdmin(db, req.params.id);
      logEvent(db, { action: 'admin.deleted', actor: req.adminUser || 'system', after: { username: target.username } });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createFleetOpsRouter };
