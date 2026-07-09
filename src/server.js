'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');

const { loadConfig } = require('./config');
const { initDb, listEvents } = require('./db');
const { TrueNASClient } = require('./truenas/client');
const { TrueNASAdapter } = require('./truenas/adapter');
const { requireAuth } = require('./middleware/requireAuth');
const { createAuthRouter } = require('./routes/auth');
const { createClientsRouter } = require('./routes/clients');
const { createGoldenRouter } = require('./routes/golden');
const { createSettingsRouter } = require('./routes/settings');
const { createBootRouter } = require('./routes/boot');
const { createPoolRouter } = require('./routes/pool');
const { createReconcileRouter } = require('./routes/reconcile');
const { createBulkImportRouter } = require('./routes/bulkImport');
const { createTrueNasStatusRouter } = require('./routes/truenas');
const { startSessionPoller } = require('./services/sessionPoller');
const { startScheduler } = require('./services/scheduler');
const { startPoolMonitor } = require('./services/poolMonitor');
const { createPushChannel } = require('./services/push');

// client.connect() has no internal timeout, so an unreachable/slow TrueNAS box
// would otherwise hang server startup indefinitely instead of degrading gracefully.
const CONNECT_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function connectTrueNAS(config) {
  const client = new TrueNASClient({ url: config.truenasUrl, apiKey: config.truenasApiKey });
  try {
    await withTimeout(
      client.connect(),
      CONNECT_TIMEOUT_MS,
      `TrueNAS connect() timed out after ${CONNECT_TIMEOUT_MS}ms`
    );
    const adapter = new TrueNASAdapter(client);
    await withTimeout(
      adapter.introspect(),
      CONNECT_TIMEOUT_MS,
      `TrueNAS introspect() timed out after ${CONNECT_TIMEOUT_MS}ms`
    );
    return { client, adapter };
  } catch (err) {
    // Don't leave a half-open socket retrying in the background after we've
    // given up and decided to run without an adapter.
    try { await client.close(); } catch (_) { /* already closed/closing */ }
    throw err;
  }
}

// Reconnects with exponential backoff whenever there's no live TrueNAS
// connection — both on initial failure and after a later disconnect (the
// client's WebSocket can drop on a TrueNAS reboot or LAN blip at any time,
// and this app is meant to run unattended, including a 4am cron job).
// Mutates `ctx.adapter` in place; routes/services read `ctx.adapter` live
// per-call rather than capturing it once, so this propagates everywhere.
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;

function startReconnectLoop(ctx, holder) {
  let backoffMs = RECONNECT_MIN_MS;
  let stopped = false;
  let timer = null;

  // ctx.push is attached after app.listen(), later than this loop starts —
  // read it live and tolerate its absence (an early state change before the
  // channel exists has no tabs to tell anyway; each new socket is greeted
  // with the current state on connect).
  function pushState(connected) {
    if (ctx.push) ctx.push.broadcast('truenas', { connected });
  }

  function onDisconnected() {
    if (stopped) return;
    console.error('[server] TrueNAS connection dropped; will retry with backoff');
    ctx.adapter = null;
    pushState(false);
    scheduleAttempt();
  }

  async function attempt() {
    if (stopped) return;
    try {
      const { client, adapter } = await connectTrueNAS(ctx.config);
      holder.client = client;
      ctx.adapter = adapter;
      backoffMs = RECONNECT_MIN_MS;
      console.log('[server] TrueNAS (re)connected and resolved RPC methods');
      pushState(true);
      client.on('disconnected', onDisconnected);
    } catch (err) {
      console.error(`[server] TrueNAS reconnect attempt failed: ${err.message}`);
      scheduleAttempt();
    }
  }

  function scheduleAttempt() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(attempt, backoffMs);
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  }

  return {
    onInitialFailure: scheduleAttempt,
    attachTo(client) {
      client.on('disconnected', onDisconnected);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

async function main() {
  const config = loadConfig();
  const db = initDb(config.dbPath);

  const holder = { client: null };
  let adapter = null;
  try {
    const connected = await connectTrueNAS(config);
    holder.client = connected.client;
    adapter = connected.adapter;
    console.log('[server] connected to TrueNAS and resolved RPC methods');
  } catch (err) {
    console.error(
      `[server] TrueNAS connection failed, continuing with adapter unavailable: ${err.message}`
    );
    console.error('[server] routes that depend on TrueNAS will respond 500 until this is resolved');
  }

  const ctx = { db, adapter, config };
  const reconnect = startReconnectLoop(ctx, holder);
  if (holder.client) {
    reconnect.attachTo(holder.client);
  } else {
    reconnect.onInitialFailure();
  }

  const app = express();
  app.use(express.json());

  // Unauthenticated: booting firmware cannot do a login flow.
  app.use(createBootRouter(ctx));

  // Also unauthenticated: you can't require a session cookie to obtain one.
  app.use(createAuthRouter({ adminPassword: config.adminPassword, cookieSecret: config.cookieSecret }));

  // Static frontend shell is served without auth — it's just the SPA's HTML/JS/CSS.
  // The page's own JS hits the API, gets 401, and shows its login form. `app.use`
  // with no path prefix matches every request, so `auth` must be scoped to /api
  // below rather than applied here, or it would also block this static handler.
  app.use(express.static(path.join(__dirname, 'public')));

  const auth = requireAuth(config.cookieSecret);
  app.use('/api', auth);
  app.use(createClientsRouter(ctx));
  app.use(createGoldenRouter(ctx));
  app.use(createSettingsRouter(ctx));
  app.use(createPoolRouter(ctx));
  app.use(createReconcileRouter(ctx));
  app.use(createBulkImportRouter(ctx));
  app.use(createTrueNasStatusRouter(ctx));

  app.get('/api/events', (req, res) => {
    try {
      // parseInt('abc') is NaN, which better-sqlite3 rejects as a bind param
      // (500 instead of a clean 400); a negative/zero LIMIT in SQLite means
      // "no limit" and would return the entire table. Validate and clamp.
      let limit = 100;
      if (req.query.limit !== undefined) {
        const parsed = parseInt(req.query.limit, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return res.status(400).json({ error: 'limit must be a positive integer' });
        }
        limit = Math.min(parsed, 1000);
      }
      // Optional per-client filter for the dashboard's detail drawer.
      let clientId = null;
      if (req.query.client_id !== undefined) {
        const parsed = parseInt(req.query.client_id, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return res.status(400).json({ error: 'client_id must be a positive integer' });
        }
        clientId = parsed;
      }
      return res.status(200).json(listEvents(db, { limit, clientId }));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  const stopPoller = startSessionPoller(ctx);
  const scheduler = startScheduler(ctx);
  // Read live per-request by the settings route, not destructured at startup,
  // so a later settings change can still trigger a reschedule.
  ctx.rescheduleCron = scheduler.reschedule;

  // Attached to ctx (not captured by routes/pool.js at construction time) so
  // GET /api/pool/status can read the latest reading on every request.
  ctx.poolMonitor = startPoolMonitor(ctx);

  const server = app.listen(config.httpPort, config.httpBind, () => {
    console.log(
      `[server] FleetDeck listening on ${config.httpBind}:${config.httpPort} ` +
        `(DRY_RUN=${config.dryRun ? '1' : '0'}, truenas=${adapter ? 'connected' : 'unavailable'})`
    );
  });

  // Live-update WebSocket channel at /ws (cookie-authenticated at upgrade).
  // Additive: the REST API and the frontend's polling fallback stay intact.
  ctx.push = createPushChannel(server, ctx);

  const shutdown = async (signal) => {
    console.log(`[server] received ${signal}, shutting down`);
    reconnect.stop();
    stopPoller();
    scheduler.stop();
    if (ctx.poolMonitor) ctx.poolMonitor.stop();
    if (ctx.push) ctx.push.stop();
    server.close();
    if (holder.client) {
      try {
        await holder.client.close();
      } catch (_) {
        // already closing/closed
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
