const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const CLIENT_COLUMNS = [
  'name', 'mac', 'zvol', 'target_name', 'golden_snapshot', 'raw_override',
  'boot_golden_once', 'nightly_reset', 'status', 'space_used_bytes',
  'notes', 'last_boot_at',
];

function initDb(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
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
  return info.lastInsertRowid;
}

function updateClient(db, id, fields) {
  const keys = Object.keys(fields).filter((k) => CLIENT_COLUMNS.includes(k));
  if (keys.length === 0) return;
  const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
  const params = { id };
  for (const k of keys) params[k] = fields[k];
  db.prepare(`UPDATE clients SET ${assignments} WHERE id = @id`).run(params);
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
  db.prepare(
    `INSERT INTO events (action, client_id, actor, before_json, after_json)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    action,
    clientId,
    actor,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after)
  );
}

function listEvents(db, { limit = 100 } = {}) {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
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

module.exports = {
  initDb, listClients, getClient, getClientByMac, insertClient, updateClient, deleteClient,
  getSetting, setSetting, getAllSettings, logEvent, listEvents, pruneEvents,
  upsertDiscovered, listDiscovered, removeDiscovered,
  insertSafetySnapshot, listExpiredSafetySnapshots, deleteSafetySnapshotRecord,
};
