CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mac TEXT NOT NULL UNIQUE,            -- normalized aa:bb:cc:dd:ee:ff
  zvol TEXT NOT NULL UNIQUE,           -- e.g. Main_pool/iscsi/client01
  target_name TEXT NOT NULL UNIQUE,
  golden_snapshot TEXT NOT NULL,       -- e.g. gold-v2
  raw_override TEXT,                   -- optional per-client raw ipxe template override
  boot_golden_once INTEGER NOT NULL DEFAULT 0, -- toggle: serve win-golden target next boot, then auto-revert
  nightly_reset INTEGER NOT NULL DEFAULT 0,    -- opt-in flag for scheduled nightly reset
  status TEXT NOT NULL DEFAULT 'unknown',      -- 'booted' | 'offline' | 'unknown', updated by session poller
  space_used_bytes INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_boot_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  action TEXT NOT NULL,          -- e.g. 'client.create', 'client.reset', 'boot.serve'
  client_id INTEGER,
  actor TEXT NOT NULL DEFAULT 'system',
  before_json TEXT,
  after_json TEXT,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS discovered (
  mac TEXT PRIMARY KEY,          -- normalized MAC seen on an unknown /boot/ request
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  request_count INTEGER NOT NULL DEFAULT 1
);
