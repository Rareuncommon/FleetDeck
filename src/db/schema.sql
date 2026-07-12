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

CREATE TABLE IF NOT EXISTS safety_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER,
  zvol TEXT NOT NULL,              -- the quarantine dataset path holding pre-wipe data
  reason TEXT NOT NULL,            -- 'reset' | 'rebase' | 'retire'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- Golden Build Mode sessions: a MAC armed here boots directly into the live
-- win-golden zvol (sanhook, no clone), so anything it writes lands on the
-- golden image permanently. Only ONE row may have ended_at IS NULL at a time
-- across the whole table; that invariant is enforced in the application layer
-- (see db/index.js insertGoldenBuildSession) rather than by a DB constraint,
-- because the same "is one already active?" query also drives the UI's
-- disabled state. ended_reason is 'expired' | 'manual' | NULL while active.
-- phase: 'install' serves sanhook+WinPE (imaging); 'boot_installed' serves a
-- plain sanboot of the golden target (first boot of the installed OS). The
-- operator switches phase from the Golden tab after the image is applied —
-- this replaces the manual static-file override the old flow needed the
-- moment the install finished. checklist_json persists the guided-workflow
-- step states for the session.
CREATE TABLE IF NOT EXISTS golden_build_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mac TEXT NOT NULL,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT,
  phase TEXT NOT NULL DEFAULT 'install',
  checklist_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_golden_build_sessions_active ON golden_build_sessions(mac, ended_at);

-- Per-client iSCSI session history, populated by the session poller's
-- offline->booted / booted->offline transitions. idle_reset_at marks that the
-- guest-idle-timeout enforcement already fired for this session (the iSCSI
-- session can outlive a forced reset, so without this marker the poller
-- would re-reset every tick).
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT,
  duration_seconds INTEGER,
  idle_reset_at TEXT,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_client ON sessions(client_id, ended_at);

-- Per-tag maintenance schedules (instead of overloading the single global
-- nightly_reset_cron): scheduler.js runs every window's cron; action is
-- applied to clients carrying the tag ('' = every client).
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL DEFAULT '',
  cron TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'reset',  -- 'reset' | 'wake'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Named local admin accounts (scrypt password hashes). When this table is
-- empty, login falls back to the single ADMIN_PASSWORD env var (username
-- "admin") so existing deployments keep working untouched.
-- last_seen_version powers the per-admin "what's new" unread indicator.
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- scrypt: salt:hex
  last_seen_version TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Pool-capacity time series for the dashboard sparkline. poolMonitor only
-- logged threshold-crossing WARNING events before (debounced hourly), which
-- is not a usable trend — this records one point per interval, pruned.
CREATE TABLE IF NOT EXISTS pool_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  used_percent REAL NOT NULL
);

-- Driver/hardware gaps in the current golden image, reported manually from
-- the UI (or later by an extended heartbeat payload). Surfaced on the Golden
-- tab as "known gaps in current golden image".
CREATE TABLE IF NOT EXISTS discovered_hardware_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER,
  mac TEXT,
  description TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'heartbeat'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
