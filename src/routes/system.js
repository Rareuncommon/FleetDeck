'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const pkg = require('../../package.json');
const {
  listClients, listPoolHistory, logEvent, getSetting,
  latestErrorPerClient, getAdminByUsername, setAdminLastSeenVersion,
} = require('../db');
const { runDiagnostics } = require('../services/setupWizard');
const { tftpFetch } = require('../services/tftp');
const { KNOWN_EVENTS } = require('../services/webhook');

// Recommended-but-optional configuration that isn't wrong to leave unset but
// is worth surfacing (item 47). Evaluated live against current settings/env.
function configWarnings(ctx) {
  const warn = [];
  const s = (k, d = '') => getSetting(ctx.db, k, d);
  if (!s('webhook_url')) warn.push({ key: 'webhook_url', text: 'No webhook configured — pool/reset/nightly alerts are only in the audit log.' });
  if (!s('api_key_created_at')) warn.push({ key: 'api_key_created_at', text: 'API-key age tracking is off (set api_key_created_at to enable the rotation reminder).' });
  if (s('wol_enabled', '0') === '1' && s('wol_broadcast', '255.255.255.255') === '255.255.255.255') {
    warn.push({ key: 'wol_broadcast', text: 'WoL is enabled but wol_broadcast is the limited broadcast — on bridge networking this never reaches the LAN.' });
  }
  if (!s('golden_snapshot')) warn.push({ key: 'golden_snapshot', text: 'No default golden snapshot set — new clients use the highest gold-vN found at runtime.' });
  if (ctx.config.dryRun) warn.push({ key: 'DRY_RUN', text: 'DRY_RUN=1 — TrueNAS mutations are disabled. Arm the system by setting DRY_RUN=0 once introspection looks right.' });
  return warn;
}

// CHANGELOG.md is bundled with the app; parse the "## <version>" sections into
// entries for the Settings "what's new" panel (item 50).
function parseChangelog() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
    const entries = [];
    const re = /^##\s+(.+?)\s*$/gm;
    let m; const marks = [];
    while ((m = re.exec(raw)) !== null) marks.push({ version: m[1].trim(), start: m.index, bodyStart: re.lastIndex });
    for (let i = 0; i < marks.length; i += 1) {
      const end = i + 1 < marks.length ? marks[i + 1].start : raw.length;
      entries.push({ version: marks[i].version, body: raw.slice(marks[i].bodyStart, end).trim() });
    }
    return entries;
  } catch (_) {
    return [];
  }
}

// Tables a restore copies, in dependency order. Older backups may lack the
// newer tables (initDb migrations recreate them empty) — only CORE_TABLES
// are required for a backup to be considered compatible at all.
const RESTORE_TABLES = [
  'clients', 'settings', 'events', 'discovered', 'safety_snapshots',
  'golden_build_sessions', 'sessions', 'discovered_hardware_gaps',
  'maintenance_windows', 'admins', 'pool_history',
];
const CORE_TABLES = ['clients', 'settings', 'events'];
const RESTORE_CONFIRM_PHRASE = 'RESTORE FLEETDECK';

function createSystemRouter(ctx) {
  const router = express.Router();

  // ---- unauthenticated monitoring endpoints -------------------------------
  // Deliberately minimal: external monitors can't log in, and neither route
  // exposes anything beyond coarse fleet counts and connection state — same
  // reasoning as /status (see routes/guest.js).

  router.get('/healthz', (req, res) => {
    return res.status(200).json({
      ok: true,
      truenas: ctx.adapter ? 'connected' : 'disconnected',
      dryRun: !!ctx.config.dryRun,
    });
  });

  router.get('/metrics', (req, res) => {
    try {
      // Hand-rolled Prometheus exposition — five gauges don't justify a
      // metrics library dependency.
      const clients = listClients(ctx.db);
      const booted = clients.filter((c) => c.status === 'booted').length;
      const pool = ctx.poolMonitor && ctx.poolMonitor.getStatus();
      const lines = [
        '# HELP fleetdeck_clients_total Registered clients',
        '# TYPE fleetdeck_clients_total gauge',
        `fleetdeck_clients_total ${clients.length}`,
        '# HELP fleetdeck_clients_booted Clients with an active iSCSI session',
        '# TYPE fleetdeck_clients_booted gauge',
        `fleetdeck_clients_booted ${booted}`,
        '# HELP fleetdeck_truenas_connected 1 when the TrueNAS RPC connection is up',
        '# TYPE fleetdeck_truenas_connected gauge',
        `fleetdeck_truenas_connected ${ctx.adapter ? 1 : 0}`,
        '# HELP fleetdeck_dry_run 1 when DRY_RUN is armed (mutations disabled)',
        '# TYPE fleetdeck_dry_run gauge',
        `fleetdeck_dry_run ${ctx.config.dryRun ? 1 : 0}`,
      ];
      if (pool && pool.usedPercent != null) {
        lines.push(
          '# HELP fleetdeck_pool_used_percent Pool capacity used',
          '# TYPE fleetdeck_pool_used_percent gauge',
          `fleetdeck_pool_used_percent ${pool.usedPercent.toFixed(2)}`
        );
      }
      res.set('Content-Type', 'text/plain; version=0.0.4');
      return res.status(200).send(lines.join('\n') + '\n');
    } catch (err) {
      return res.status(500).send(`# metrics error: ${err.message}\n`);
    }
  });

  // ---- authenticated system API -------------------------------------------

  router.get('/api/system/info', (req, res) => {
    return res.status(200).json({
      version: pkg.version,
      dryRun: !!ctx.config.dryRun,
      truenasConnected: !!ctx.adapter,
      update: ctx.updateInfo || null,
      // Baked in by the Docker build (--build-arg); absent in local dev.
      gitCommit: process.env.GIT_COMMIT || null,
      buildDate: process.env.BUILD_DATE || null,
      adminUser: req.adminUser || null,
    });
  });

  // Live TrueNAS connection state + reconnect progress (items 42/43).
  router.get('/api/system/connection', (req, res) => {
    return res.status(200).json(ctx.connState || { state: ctx.adapter ? 'connected' : 'down', attempt: 0 });
  });

  router.get('/api/system/warnings', (req, res) => {
    try {
      return res.status(200).json(configWarnings(ctx));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // On-demand self-test (item 46): reuses the same checks the Setup-tab
  // diagnostics runs (TrueNAS connectivity, golden zvol/target groups,
  // _safety dataset, boot files, HTTP/TFTP self-fetch) — one source of truth.
  router.get('/api/system/self-test', async (req, res) => {
    try {
      return res.status(200).json({ checks: await runDiagnostics(ctx, { tftpFetch }) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // "What's new" (item 50). unreadSince = the version this admin last saw
  // (stored per-account in the admins table, not browser storage, so it
  // follows the operator across machines). Legacy env-password login has no
  // account row, so it simply always sees the latest as "read".
  router.get('/api/system/changelog', (req, res) => {
    try {
      const entries = parseChangelog();
      let lastSeen = null;
      const admin = req.adminUser ? getAdminByUsername(ctx.db, req.adminUser) : null;
      if (admin) lastSeen = admin.last_seen_version;
      const latest = entries[0] ? entries[0].version : null;
      return res.status(200).json({ entries, lastSeen, latest, unread: !!(latest && lastSeen !== latest) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/system/changelog/seen', (req, res) => {
    try {
      const entries = parseChangelog();
      const latest = entries[0] ? entries[0].version : null;
      if (latest && req.adminUser && getAdminByUsername(ctx.db, req.adminUser)) {
        setAdminLastSeenVersion(ctx.db, req.adminUser, latest);
      }
      return res.status(200).json({ ok: true, latest });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Most-recent failure per client, for the inline last-error row icon.
  // NB: NOT under /api/clients/* — that path is owned by the clients router's
  // /api/clients/:id, which would capture "errors" as an id and 404.
  router.get('/api/client-errors', (req, res) => {
    try {
      return res.status(200).json(latestErrorPerClient(ctx.db));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/pool/history', (req, res) => {
    try {
      return res.status(200).json(listPoolHistory(ctx.db));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Backup: VACUUM INTO writes a consistent, compacted copy — never stream
  // the live WAL-mode file (a torn read is a corrupt backup).
  router.post('/api/backup', (req, res) => {
    const tmp = path.join(os.tmpdir(), `fleetdeck-backup-${Date.now()}.sqlite3`);
    try {
      ctx.db.prepare('VACUUM INTO ?').run(tmp);
      logEvent(ctx.db, { action: 'system.backup', actor: req.adminUser || 'system' });
      return res.download(tmp, `fleetdeck-backup-${new Date().toISOString().slice(0, 10)}.sqlite3`, () => {
        fs.unlink(tmp, () => {});
      });
    } catch (err) {
      fs.unlink(tmp, () => {});
      return res.status(500).json({ error: err.message });
    }
  });

  // Restore: validate the upload is a compatible FleetDeck database, then —
  // inside one transaction on the LIVE connection — wipe and re-copy every
  // known table from the attached upload. Copying via ATTACH keeps ctx.db
  // valid everywhere (routes/services/pollers hold the same handle), which a
  // file swap could not do without a process restart. Destructive enough to
  // demand a typed confirmation phrase.
  router.post('/api/restore',
    express.raw({ type: '*/*', limit: '256mb' }),
    (req, res) => {
      const tmp = path.join(os.tmpdir(), `fleetdeck-restore-${Date.now()}.sqlite3`);
      try {
        if ((req.query.confirm || '') !== RESTORE_CONFIRM_PHRASE) {
          return res.status(400).json({
            error: `Refusing restore without confirm=${RESTORE_CONFIRM_PHRASE} — a bad restore destroys the current state`,
          });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length < 512) {
          return res.status(400).json({ error: 'Upload is not a SQLite database' });
        }
        // SQLite magic: "SQLite format 3\0".
        if (!req.body.subarray(0, 15).equals(Buffer.from('SQLite format 3'))) {
          return res.status(400).json({ error: 'Upload is not a SQLite database (bad magic)' });
        }
        fs.writeFileSync(tmp, req.body);

        // Validate schema compatibility read-only before touching anything.
        const probe = new Database(tmp, { readonly: true });
        try {
          const tables = new Set(
            probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
          );
          const missing = CORE_TABLES.filter((t) => !tables.has(t));
          if (missing.length > 0) {
            return res.status(400).json({ error: `Not a FleetDeck backup: missing table(s) ${missing.join(', ')}` });
          }
        } finally {
          probe.close();
        }

        const present = (t) => {
          const row = ctx.db.prepare(
            "SELECT name FROM restore_src.sqlite_master WHERE type='table' AND name = ?"
          ).get(t);
          return !!row;
        };

        ctx.db.exec(`ATTACH DATABASE '${tmp.replace(/'/g, "''")}' AS restore_src`);
        try {
          ctx.db.exec('PRAGMA defer_foreign_keys = ON');
          const tx = ctx.db.transaction(() => {
            for (const t of RESTORE_TABLES) {
              if (!present(t)) continue; // older backup without this table
              // Column intersection: a backup from an older schema simply
              // leaves newer columns at their defaults.
              const liveCols = ctx.db.pragma(`table_info(${t})`).map((c) => c.name);
              const srcCols = ctx.db.prepare(`SELECT * FROM restore_src.${t} LIMIT 0`).columns().map((c) => c.name);
              const cols = liveCols.filter((c) => srcCols.includes(c));
              if (cols.length === 0) continue;
              ctx.db.prepare(`DELETE FROM ${t}`).run();
              ctx.db.prepare(
                `INSERT INTO ${t} (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM restore_src.${t}`
              ).run();
            }
          });
          tx();
        } finally {
          ctx.db.exec('DETACH DATABASE restore_src');
        }
        logEvent(ctx.db, { action: 'system.restore', actor: req.adminUser || 'system', after: { bytes: req.body.length } });
        return res.status(200).json({ ok: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      } finally {
        fs.unlink(tmp, () => {});
      }
    });

  return router;
}

module.exports = { createSystemRouter, RESTORE_CONFIRM_PHRASE };
