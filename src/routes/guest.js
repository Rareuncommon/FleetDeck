'use strict';

const express = require('express');
const QRCode = require('qrcode');

const {
  listClients, getClient, updateClient, getSetting, logEvent,
  listClientSessions, insertHardwareGap, listHardwareGaps, deleteHardwareGap,
} = require('../db');
const { resetClient } = require('../services/clientOps');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const GPU_VENDORS = ['amd', 'nvidia', 'intel', 'unknown'];

function createGuestRouter(ctx) {
  const router = express.Router();
  const { db } = ctx;

  // ---- PUBLIC, UNAUTHENTICATED: GET /status ------------------------------
  // A genuinely different trust boundary from the rest of the app, and the
  // one intentionally-unauthenticated data-bearing route besides /boot/*.
  // Strictly read-only and strictly minimal BY DESIGN: client display name +
  // booted/offline only. No MACs, no zvol paths, no ids, no timestamps —
  // walk-up guests get "which machines are free", nothing else. Anything
  // richer belongs behind the admin login. guest_motd (a setting) renders as
  // a banner here — the honest scope for a "message of the day", since
  // FleetDeck has no mechanism to display text inside Windows itself.
  router.get('/status', (req, res) => {
    try {
      const motd = getSetting(db, 'guest_motd', '');
      const rows = listClients(db).map((c) => ({
        name: c.name,
        booted: c.status === 'booted',
      }));
      const items = rows.map((r) => `
        <li class="${r.booted ? 'busy' : 'free'}">
          <span class="dot"></span>${esc(r.name)}
          <span class="state">${r.booted ? 'in use' : 'available'}</span>
        </li>`).join('');
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Machine status</title>
<style>
  body { margin:0; background:#111; color:#ddd; font:16px/1.5 system-ui, sans-serif;
    display:flex; flex-direction:column; align-items:center; padding:24px; }
  h1 { font-size:18px; letter-spacing:1px; color:#2fd6c6; }
  .motd { background:rgba(217,164,65,.12); border:1px solid #d9a441; color:#d9a441;
    border-radius:6px; padding:10px 16px; margin-bottom:16px; max-width:480px; text-align:center; }
  ul { list-style:none; padding:0; width:min(480px, 92vw); }
  li { display:flex; align-items:center; gap:10px; background:#1a1a1a; border:1px solid #2c2c2c;
    border-radius:6px; padding:10px 14px; margin-bottom:8px; }
  .dot { width:10px; height:10px; border-radius:50%; }
  .free .dot { background:#4fce6a; } .busy .dot { background:#e0574f; }
  .state { margin-left:auto; color:#888; font-size:13px; }
</style></head><body>
<h1>MACHINE STATUS</h1>
${motd ? `<div class="motd">${esc(motd)}</div>` : ''}
<ul>${items || '<li>No machines registered</li>'}</ul>
</body></html>`);
    } catch (err) {
      return res.status(500).send('status unavailable');
    }
  });

  // ---- authenticated API (auth applied to /api in server.js) --------------

  router.get('/api/clients/:id/sessions', (req, res) => {
    try {
      if (!getClient(db, req.params.id)) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(listClientSessions(db, req.params.id));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Manual metadata edits from the detail drawer (gpu_vendor, notes).
  router.post('/api/clients/:id/meta', (req, res) => {
    try {
      const client = getClient(db, req.params.id);
      if (!client) return res.status(404).json({ error: 'Not found' });
      const body = req.body || {};
      const fields = {};
      if (body.gpu_vendor !== undefined) {
        if (body.gpu_vendor !== null && body.gpu_vendor !== '' && !GPU_VENDORS.includes(body.gpu_vendor)) {
          return res.status(400).json({ error: `gpu_vendor must be one of ${GPU_VENDORS.join(', ')}` });
        }
        fields.gpu_vendor = body.gpu_vendor || null;
      }
      if (body.notes !== undefined) fields.notes = body.notes === null ? null : String(body.notes);
      if (body.tags !== undefined) {
        // Normalize: trim, drop empties, dedupe — stored comma-separated.
        const tags = String(body.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
        fields.tags = tags.length ? [...new Set(tags)].join(',') : null;
      }
      if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'nothing to update' });
      updateClient(db, req.params.id, fields);
      logEvent(db, { action: 'client.meta_updated', clientId: client.id, before: { gpu_vendor: client.gpu_vendor, notes: client.notes }, after: fields });
      return res.status(200).json(getClient(db, req.params.id));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // "Kick" — HONEST LABELING: the TrueNAS API exposes no way to terminate a
  // specific iSCSI session (iscsi.global.* offers listing only; verified
  // against the v25.10 method index — there is no session-terminate RPC).
  // So kick is implemented as, and labeled in the UI as, a FORCED RESET:
  // the zvol is wiped and re-cloned under the live session; the machine
  // keeps running from cache until it reboots. Not a true mid-session
  // disconnect, and we don't pretend otherwise.
  router.post('/api/clients/:id/kick', async (req, res) => {
    try {
      const client = getClient(db, req.params.id);
      if (!client) return res.status(404).json({ error: 'Not found' });
      logEvent(db, { action: 'client.kick', clientId: client.id, after: { mechanism: 'forced_reset' } });
      const result = await resetClient(ctx, req.params.id, { force: true });
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Per-client QR code (SVG) linking to the static troubleshooting page.
  // Server-side via the pure-JS `qrcode` package — no native compilation,
  // per the Dockerfile constraint.
  router.get('/api/clients/:id/qr.svg', async (req, res) => {
    try {
      const client = getClient(db, req.params.id);
      if (!client) return res.status(404).json({ error: 'Not found' });
      const url = `http://${req.get('host')}/troubleshoot.html?m=${encodeURIComponent(client.name)}`;
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240 });
      res.set('Content-Type', 'image/svg+xml');
      return res.status(200).send(svg);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- hardware gap reports (Golden tab: "known gaps in current image") ---

  router.get('/api/hardware-gaps', (req, res) => {
    try {
      return res.status(200).json(listHardwareGaps(db));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/hardware-gaps', (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.description !== 'string' || !body.description.trim()) {
        return res.status(400).json({ error: 'description is required' });
      }
      const id = insertHardwareGap(db, {
        clientId: body.client_id || null,
        mac: body.mac || null,
        description: body.description.trim(),
        source: 'manual',
      });
      logEvent(db, { action: 'hardware_gap.reported', clientId: body.client_id || null, after: { id, description: body.description.trim() } });
      return res.status(201).json({ id });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/hardware-gaps/:id', (req, res) => {
    try {
      deleteHardwareGap(db, req.params.id);
      logEvent(db, { action: 'hardware_gap.resolved', after: { id: req.params.id } });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createGuestRouter, GPU_VENDORS };
