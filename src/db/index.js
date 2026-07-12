const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const Database = require('better-sqlite3');

// Change feed for the WebSocket push channel (services/push.js). Emitting from
// inside the db helpers — rather than threading a broadcast callback through
// every route/service — means no call site changes and nothing can mutate
// state without the UI hearing about it. Module-level is fine here: the app is
// a single process with a single live DB (tests open :memory: copies, but
// nothing subscribes in tests, so stray emits are inert).
const changes = new EventEmitter();
// A push channel that is slow to attach must never crash a mutation path.
changes.setMaxListeners(20);

const CLIENT_COLUMNS = [
  'name', 'mac', 'zvol', 'target_name', 'golden_snapshot', 'raw_override',
  'boot_golden_once', 'nightly_reset', 'status', 'space_used_bytes',
  'notes', 'last_boot_at', 'gpu_vendor', 'last_heartbeat_at', 'tags',
];

function initDb(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  // Minimal in-place migrations: CREATE TABLE IF NOT EXISTS never alters an
  // existing table, so columns added after a table shipped must be ALTERed
  // in for databases created before them. ADD COLUMN with a DEFAULT is safe
  // and instant in SQLite; guarded by a pragma check so it's idempotent.
  const gbCols = new Set(db.pragma('table_info(golden_build_sessions)').map((c) => c.name));
  if (!gbCols.has('phase')) {
    db.exec("ALTER TABLE golden_build_sessions ADD COLUMN phase TEXT NOT NULL DEFAULT 'install'");
  }
  if (!gbCols.has('checklist_json')) {
    db.exec('ALTER TABLE golden_build_sessions ADD COLUMN checklist_json TEXT');
  }
  const clientCols = new Set(db.pragma('table_info(clients)').map((c) => c.name));
  // gpu_vendor: 'amd' | 'nvidia' | 'intel' | 'unknown' | NULL. Set manually
  // in the detail drawer for now; auto-detection would need the heartbeat
  // payload extended with GPU info — deliberately not built until wanted.
  if (!clientCols.has('gpu_vendor')) {
    db.exec('ALTER TABLE clients ADD COLUMN gpu_vendor TEXT');
  }
  // Last time the golden image's safety-script heartbeat POSTed for this MAC;
  // a booted client without a recent heartbeat gets a warning badge (the
  // disk-offline safety script may not have run).
  if (!clientCols.has('last_heartbeat_at')) {
    db.exec('ALTER TABLE clients ADD COLUMN last_heartbeat_at TEXT');
  }
  // tags: comma-separated TEXT rather than a join table — least disruptive
  // to the existing queries (everything reads whole client rows), and fleet
  // sizes here make LIKE-free in-app filtering trivial.
  if (!clientCols.has('tags')) {
    db.exec('ALTER TABLE clients ADD COLUMN tags TEXT');
  }
  return db;
}

function listClients(db) {
  return db.prepare('SELECT * FROM clients ORDER BY id').all();
}

function getClient(db, id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

function getClientByMac(db, mac) {
  return db.prepare('SELECT * FROM clients WHERE mac = ?').get(mac);
}

function insertClient(db, client) {
  const stmt = db.prepare(
    `INSERT INTO clients (name, mac, zvol, target_name, golden_snapshot, notes)
     VALUES (@name, @mac, @zvol, @target_name, @golden_snapshot, @notes)`
  );
  const info = stmt.run({
    name: client.name,
    mac: client.mac,
    zvol: client.zvol,
    target_name: client.target_name,
    golden_snapshot: client.golden_snapshot,
    notes: client.notes ?? null,
  });
  changes.emit('clients_changed', { op: 'insert', id: info.lastInsertRowid });
  return info.lastInsertRowid;
}

function updateClient(db, id, fields) {
  const keys = Object.keys(fields).filter((k) => CLIENT_COLUMNS.includes(k));
  if (keys.length === 0) return;
  const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
  const params = { id };
  for (const k of keys) params[k] = fields[k];
  db.prepare(`UPDATE clients SET ${assignments} WHERE id = @id`).run(params);
  changes.emit('clients_changed', { op: 'update', id, fields: keys });
}

function deleteClient(db, id) {
  // better-sqlite3 enforces foreign keys by default, and events /
  // safety_snapshots reference clients(id) with no ON DELETE clause — so
  // deleting a client that has any audit or quarantine row (every client
  // does, from client.create) would throw SQLITE_CONSTRAINT_FOREIGNKEY.
  // Detach the references instead of deleting them: audit history and
  // quarantine tracking must outlive the client row (events keep the full
  // client in before_json/after_json, and the safety-snapshot purge works
  // off the zvol path alone).
  const detachAndDelete = db.transaction((cid) => {
    db.prepare('UPDATE events SET client_id = NULL WHERE client_id = ?').run(cid);
    db.prepare('UPDATE safety_snapshots SET client_id = NULL WHERE client_id = ?').run(cid);
    db.prepare('DELETE FROM clients WHERE id = ?').run(cid);
  });
  detachAndDelete(id);
  changes.emit('clients_changed', { op: 'delete', id });
}

function getSetting(db, key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

function getAllSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

function logEvent(db, { action, clientId = null, before = null, after = null, actor = 'system' }) {
  const info = db.prepare(
    `INSERT INTO events (action, client_id, actor, before_json, after_json)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    action,
    clientId,
    actor,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after)
  );
  // Emit the row as the API serves it (before/after re-stringified) so the
  // push channel and GET /api/events agree on shape and the frontend needs
  // exactly one rendering path for both.
  changes.emit('event', {
    id: info.lastInsertRowid,
    ts: new Date().toISOString(),
    action,
    client_id: clientId,
    actor,
    before_json: before === null ? null : JSON.stringify(before),
    after_json: after === null ? null : JSON.stringify(after),
  });
}

// clientId filter powers the per-client audit history in the dashboard's
// detail drawer; the other filters power the Audit tab's server-side query
// (item 44) since audit history can grow past what's sane to filter client-
// side. `action` matches a prefix ("client." catches all client events);
// from/to are ISO timestamps compared against the ts column.
function listEvents(db, { limit = 100, clientId = null, action = null, from = null, to = null } = {}) {
  const where = [];
  const params = [];
  if (clientId != null) { where.push('client_id = ?'); params.push(clientId); }
  if (action) { where.push('action LIKE ?'); params.push(`${action}%`); }
  if (from) { where.push('ts >= ?'); params.push(from); }
  if (to) { where.push('ts <= ?'); params.push(to); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);
  return db.prepare(`SELECT * FROM events ${clause} ORDER BY id DESC LIMIT ?`).all(...params);
}

// Most recent failure-ish audit event per client, for the inline last-error
// icon on each dashboard row (item 45). "Failure-ish" = action contains
// fail/error/rollback. One row per client via a correlated MAX(id).
function latestErrorPerClient(db) {
  const rows = db.prepare(
    `SELECT e.client_id, e.action, e.ts, e.after_json
       FROM events e
       WHERE e.client_id IS NOT NULL
         AND (e.action LIKE '%fail%' OR e.action LIKE '%error%' OR e.action LIKE '%rollback%')
         AND e.id = (
           SELECT MAX(e2.id) FROM events e2
           WHERE e2.client_id = e.client_id
             AND (e2.action LIKE '%fail%' OR e2.action LIKE '%error%' OR e2.action LIKE '%rollback%')
         )`
  ).all();
  const out = {};
  for (const r of rows) out[r.client_id] = { action: r.action, ts: r.ts, after: r.after_json };
  return out;
}

// The events table has no other retention policy and /boot/* (unauthenticated,
// on-LAN) can grow it indefinitely just from unknown-MAC boot attempts.
function pruneEvents(db, keep = 5000) {
  db.prepare(
    'DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)'
  ).run(keep);
}

function upsertDiscovered(db, mac) {
  db.prepare(
    `INSERT INTO discovered (mac) VALUES (?)
     ON CONFLICT(mac) DO UPDATE SET
       request_count = request_count + 1,
       last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(mac);
}

function listDiscovered(db) {
  return db.prepare('SELECT * FROM discovered ORDER BY last_seen_at DESC').all();
}

function removeDiscovered(db, mac) {
  db.prepare('DELETE FROM discovered WHERE mac = ?').run(mac);
}

function insertSafetySnapshot(db, { clientId = null, zvol, reason }) {
  const info = db.prepare(
    'INSERT INTO safety_snapshots (client_id, zvol, reason) VALUES (?, ?, ?)'
  ).run(clientId, zvol, reason);
  return info.lastInsertRowid;
}

function listExpiredSafetySnapshots(db, olderThanDays) {
  return db.prepare(
    `SELECT * FROM safety_snapshots
     WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' days')`
  ).all(olderThanDays);
}

function deleteSafetySnapshotRecord(db, id) {
  db.prepare('DELETE FROM safety_snapshots WHERE id = ?').run(id);
}

// --- Client iSCSI session history -------------------------------------------

function getOpenSession(db, clientId) {
  return db.prepare(
    'SELECT * FROM sessions WHERE client_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1'
  ).get(clientId) || null;
}

function openSession(db, clientId) {
  const info = db.prepare('INSERT INTO sessions (client_id) VALUES (?)').run(clientId);
  return info.lastInsertRowid;
}

function closeSession(db, sessionId) {
  // duration computed in SQL from the row's own started_at so clock math
  // stays in one place and one timezone (UTC ISO strings throughout).
  db.prepare(
    `UPDATE sessions SET
       ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       duration_seconds = CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER)
     WHERE id = ? AND ended_at IS NULL`
  ).run(sessionId);
}

function markSessionIdleReset(db, sessionId) {
  db.prepare(
    "UPDATE sessions SET idle_reset_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(sessionId);
}

function listClientSessions(db, clientId, { limit = 50 } = {}) {
  return db.prepare(
    'SELECT * FROM sessions WHERE client_id = ? ORDER BY id DESC LIMIT ?'
  ).all(clientId, limit);
}

// --- Maintenance windows -------------------------------------------------------

function listMaintenanceWindows(db) {
  return db.prepare('SELECT * FROM maintenance_windows ORDER BY id').all();
}

function insertMaintenanceWindow(db, { tag = '', cron, action = 'reset' }) {
  const info = db.prepare(
    'INSERT INTO maintenance_windows (tag, cron, action) VALUES (?, ?, ?)'
  ).run(tag, cron, action);
  return info.lastInsertRowid;
}

function deleteMaintenanceWindow(db, id) {
  db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(id);
}

// --- Admin accounts --------------------------------------------------------------

function listAdmins(db) {
  return db.prepare('SELECT id, username, last_seen_version, created_at FROM admins ORDER BY id').all();
}

function getAdminByUsername(db, username) {
  return db.prepare('SELECT * FROM admins WHERE username = ?').get(username) || null;
}

function insertAdmin(db, { username, passwordHash }) {
  const info = db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
  return info.lastInsertRowid;
}

function deleteAdmin(db, id) {
  db.prepare('DELETE FROM admins WHERE id = ?').run(id);
}

function countAdmins(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
}

function setAdminLastSeenVersion(db, username, version) {
  db.prepare('UPDATE admins SET last_seen_version = ? WHERE username = ?').run(version, username);
}

// --- Pool capacity history --------------------------------------------------------

function insertPoolHistory(db, usedPercent) {
  db.prepare('INSERT INTO pool_history (used_percent) VALUES (?)').run(usedPercent);
  // Bounded: ~2000 points ≈ a week at 5-minute intervals; prune the tail so
  // the table can't grow without limit on a box that runs for years.
  db.prepare(
    'DELETE FROM pool_history WHERE id <= (SELECT MAX(id) FROM pool_history) - 2000'
  ).run();
}

function lastPoolHistoryAt(db) {
  const row = db.prepare('SELECT ts FROM pool_history ORDER BY id DESC LIMIT 1').get();
  return row ? row.ts : null;
}

function listPoolHistory(db, { limit = 288 } = {}) {
  return db.prepare(
    'SELECT ts, used_percent FROM (SELECT * FROM pool_history ORDER BY id DESC LIMIT ?) ORDER BY id'
  ).all(limit);
}

// --- Hardware gap reports -----------------------------------------------------

function insertHardwareGap(db, { clientId = null, mac = null, description, source = 'manual' }) {
  const info = db.prepare(
    'INSERT INTO discovered_hardware_gaps (client_id, mac, description, source) VALUES (?, ?, ?, ?)'
  ).run(clientId, mac, description, source);
  return info.lastInsertRowid;
}

function listHardwareGaps(db) {
  return db.prepare('SELECT * FROM discovered_hardware_gaps ORDER BY id DESC').all();
}

function deleteHardwareGap(db, id) {
  db.prepare('DELETE FROM discovered_hardware_gaps WHERE id = ?').run(id);
}

// --- Golden Build Mode sessions -------------------------------------------
// Invariant: at most one row with ended_at IS NULL, ever. Enforced here (not
// by a DB constraint) so the same query can drive the UI's disabled state.

function getActiveGoldenBuildSession(db) {
  return db.prepare(
    'SELECT * FROM golden_build_sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1'
  ).get() || null;
}

// Atomic check-then-insert. better-sqlite3 is synchronous, so wrapping the
// "is one already active?" check and the insert in a single transaction means
// two concurrent arm requests cannot both observe "none active" and both
// insert — the single-active invariant holds without a DB constraint. Throws
// an error tagged GOLDEN_BUILD_ACTIVE if one is already active (the caller
// has already produced a friendlier message from its own pre-check, but this
// is the real race guard).
function insertGoldenBuildSession(db, { mac, startedAt, expiresAt }) {
  const tx = db.transaction(() => {
    const active = db.prepare(
      'SELECT id FROM golden_build_sessions WHERE ended_at IS NULL'
    ).get();
    if (active) {
      const err = new Error('An active golden build session already exists');
      err.code = 'GOLDEN_BUILD_ACTIVE';
      throw err;
    }
    const info = db.prepare(
      'INSERT INTO golden_build_sessions (mac, started_at, expires_at) VALUES (?, ?, ?)'
    ).run(mac, startedAt, expiresAt);
    return db.prepare('SELECT * FROM golden_build_sessions WHERE id = ?').get(info.lastInsertRowid);
  });
  return tx();
}

// Column-whitelisted update for the active-session workflow fields (phase
// switches, checklist progress). Only ever touches the given row.
const GOLDEN_BUILD_MUTABLE = ['phase', 'checklist_json'];

function updateGoldenBuildSession(db, id, fields) {
  const keys = Object.keys(fields).filter((k) => GOLDEN_BUILD_MUTABLE.includes(k));
  if (keys.length === 0) return;
  const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
  const params = { id };
  for (const k of keys) params[k] = fields[k];
  db.prepare(`UPDATE golden_build_sessions SET ${assignments} WHERE id = @id`).run(params);
}

// Ends the current active session (if any). Idempotent: returns null and does
// nothing when none is active, so double-ending is a harmless no-op.
function closeActiveGoldenBuildSession(db, reason) {
  const active = getActiveGoldenBuildSession(db);
  if (!active) return null;
  const endedAt = new Date().toISOString();
  db.prepare(
    'UPDATE golden_build_sessions SET ended_at = ?, ended_reason = ? WHERE id = ?'
  ).run(endedAt, reason, active.id);
  return { ...active, ended_at: endedAt, ended_reason: reason };
}

// Closes any active session whose expires_at has passed (reason 'expired').
// Returns the rows that were closed so the caller can log them.
function closeExpiredGoldenBuildSessions(db, nowIso) {
  const expired = db.prepare(
    'SELECT * FROM golden_build_sessions WHERE ended_at IS NULL AND expires_at <= ?'
  ).all(nowIso);
  if (expired.length === 0) return [];
  const endedAt = new Date().toISOString();
  const upd = db.prepare(
    'UPDATE golden_build_sessions SET ended_at = ?, ended_reason = ? WHERE id = ?'
  );
  db.transaction(() => {
    for (const s of expired) upd.run(endedAt, 'expired', s.id);
  })();
  return expired.map((s) => ({ ...s, ended_at: endedAt, ended_reason: 'expired' }));
}

module.exports = {
  initDb, listClients, getClient, getClientByMac, insertClient, updateClient, deleteClient,
  getSetting, setSetting, getAllSettings, logEvent, listEvents, pruneEvents,
  upsertDiscovered, listDiscovered, removeDiscovered,
  insertSafetySnapshot, listExpiredSafetySnapshots, deleteSafetySnapshotRecord,
  getActiveGoldenBuildSession, insertGoldenBuildSession,
  updateGoldenBuildSession,
  closeActiveGoldenBuildSession, closeExpiredGoldenBuildSessions,
  getOpenSession, openSession, closeSession, markSessionIdleReset, listClientSessions,
  insertHardwareGap, listHardwareGaps, deleteHardwareGap,
  listMaintenanceWindows, insertMaintenanceWindow, deleteMaintenanceWindow,
  listAdmins, getAdminByUsername, insertAdmin, deleteAdmin, countAdmins, setAdminLastSeenVersion,
  insertPoolHistory, lastPoolHistoryAt, listPoolHistory,
  latestErrorPerClient,
  changes,
};
