'use strict';
const express = require('express');
const { scanReconciliation } = require('../services/reconcile');
const { normalizeMac } = require('../services/mac');
const { listClients, getClient, getClientByMac, insertClient, deleteClient, logEvent } = require('../db');

function createReconcileRouter(ctx) {
  const router = express.Router();

  router.get('/api/reconcile/scan', async (req, res) => {
    try {
      if (!ctx.adapter) return res.status(503).json({ error: 'TrueNAS adapter unavailable' });
      const clients = listClients(ctx.db);
      const result = await scanReconciliation(ctx, clients);
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Registers a pre-existing TrueNAS target (found via /scan's trueNasOnly list) as a real
  // FleetDeck client. Does NOT call createClient / clone anything — the zvol/extent/target/
  // targetextent already exist on TrueNAS; this only adds a matching DB row so FleetDeck starts
  // tracking it (boot serving, session polling, reset/rebase/retire all become available for it).
  router.post('/api/reconcile/import', async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return res.status(400).json({ error: 'name is required' });
      }
      let mac;
      try {
        mac = normalizeMac(body.mac);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      if (typeof body.targetName !== 'string' || body.targetName.trim() === '') {
        return res.status(400).json({ error: 'targetName is required' });
      }
      if (getClientByMac(ctx.db, mac)) {
        return res.status(409).json({ error: `A client with mac "${mac}" already exists` });
      }
      if (!ctx.adapter) return res.status(503).json({ error: 'TrueNAS adapter unavailable' });

      // Re-scan to get the current, authoritative zvol path for this target (don't trust a
      // possibly-stale value the client cached from an earlier /scan call).
      const clients = listClients(ctx.db);
      const { trueNasOnly } = await scanReconciliation(ctx, clients);
      const match = trueNasOnly.find((t) => t.targetName === body.targetName);
      if (!match) {
        return res.status(404).json({ error: `TrueNAS target "${body.targetName}" not found among unregistered targets` });
      }
      if (!match.zvol) {
        return res.status(422).json({ error: `Could not resolve a zvol path for target "${body.targetName}"; cannot import` });
      }
      // Every guardrail in clientOps.js (assertSafeToDestroy) requires a client's zvol to
      // live under clientZvolRoot. Importing one that doesn't would silently succeed here
      // but then permanently refuse every future reset/rebase/retire on it — reject up
      // front instead of letting that surprise surface later at operation time.
      const root = `${ctx.config.clientZvolRoot}/`;
      if (!match.zvol.startsWith(root)) {
        return res.status(422).json({
          error: `Target "${body.targetName}" resolves to zvol "${match.zvol}", which is not under ${root}; refusing to import`,
        });
      }

      // We don't actually know what golden snapshot this target was originally cloned from
      // (TrueNAS doesn't record clone lineage in a way this adapter surfaces) — this is a
      // documented, informational-only field. Accept an optional override, else mark unknown.
      const goldenSnapshot = typeof body.goldenSnapshot === 'string' && body.goldenSnapshot ? body.goldenSnapshot : 'unknown';

      const newId = insertClient(ctx.db, {
        name: body.name, mac, zvol: match.zvol, target_name: match.targetName,
        golden_snapshot: goldenSnapshot, notes: 'Imported via reconciliation from existing TrueNAS infrastructure',
      });
      logEvent(ctx.db, {
        action: 'reconcile.import', clientId: newId,
        after: { name: body.name, mac, zvol: match.zvol, target_name: match.targetName },
      });
      return res.status(201).json(getClient(ctx.db, newId));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Removes a stale DB row whose TrueNAS target no longer exists. Deliberately does NOT attempt
  // to recreate/repair the missing TrueNAS infrastructure — fabricating a "repair" for
  // infrastructure that's already gone is riskier than just letting the admin re-create the
  // client fresh via the normal "New client" flow if they still want that machine in the fleet.
  router.post('/api/reconcile/remove-orphan-client', async (req, res) => {
    try {
      const body = req.body || {};
      const id = body.clientId;
      if (id == null) return res.status(400).json({ error: 'clientId is required' });
      const client = getClient(ctx.db, id);
      if (!client) return res.status(404).json({ error: 'Not found' });
      deleteClient(ctx.db, id);
      logEvent(ctx.db, { action: 'reconcile.remove_orphan_client', clientId: id, before: client });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createReconcileRouter };
