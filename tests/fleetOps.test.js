'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const db = require('../src/db');
const { createAuthRouter, hashPassword, verifyPassword } = require('../src/routes/auth');
const { createSystemRouter, RESTORE_CONFIRM_PHRASE } = require('../src/routes/system');
const { createFleetOpsRouter } = require('../src/routes/fleetOps');
const { requireAuth, verifySession, COOKIE_NAME } = require('../src/middleware/requireAuth');
const { runMaintenanceWindow } = require('../src/services/scheduler');
const { fireWebhook } = require('../src/services/webhook');

const SECRET = 'test-secret';

function makeCtx(settings = {}) {
  const d = db.initDb(':memory:');
  for (const [k, v] of Object.entries(settings)) db.setSetting(d, k, v);
  return {
    db: d,
    adapter: null,
    config: {
      adminPassword: 'envpass', cookieSecret: SECRET, dryRun: true, poolName: 'Main_pool',
      clientZvolRoot: 'Main_pool/iscsi', goldenZvol: 'Main_pool/iscsi/win-golden',
    },
  };
}

function seed(ctx, name, mac, over = {}) {
  // insertClient takes only the creation columns; tags/status/etc. are
  // post-creation updates (same as the real meta endpoint's flow).
  const id = db.insertClient(ctx.db, {
    name, mac, zvol: `Main_pool/iscsi/${name}`, target_name: name,
    golden_snapshot: 'gold-v1', notes: null,
  });
  if (Object.keys(over).length > 0) db.updateClient(ctx.db, id, over);
  return id;
}

function startApp(ctx, ...routers) {
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter(ctx));
  app.use('/api', requireAuth(SECRET));
  for (const r of routers) app.use(r(ctx));
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({ server: s, base: `http://127.0.0.1:${s.address().port}` }));
  });
}

async function login(base, body) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { status: res.status, cookie, body: await res.json().catch(() => null) };
}

// --- multi-admin auth ---------------------------------------------------------

test('env password works until a named admin exists, then only accounts do', async () => {
  const ctx = makeCtx();
  const { server, base } = await startApp(ctx, createFleetOpsRouter);
  try {
    // Legacy path: env password, username omitted.
    const legacy = await login(base, { password: 'envpass' });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.username, 'admin');
    assert.equal(verifySession(SECRET, legacy.cookie.split('=')[1]), 'admin');

    // Create a named account through the API.
    const created = await fetch(`${base}/api/admins`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: legacy.cookie },
      body: JSON.stringify({ username: 'mel', password: 'supersecret' }),
    });
    assert.equal(created.status, 201);

    // Env password is now dead; the account logs in with its username.
    assert.equal((await login(base, { password: 'envpass' })).status, 401);
    const named = await login(base, { username: 'mel', password: 'supersecret' });
    assert.equal(named.status, 200);
    assert.equal(named.body.username, 'mel');

    // Last-account protection.
    const admins = await (await fetch(`${base}/api/admins`, { headers: { Cookie: named.cookie } })).json();
    const del = await fetch(`${base}/api/admins/${admins[0].id}`, { method: 'DELETE', headers: { Cookie: named.cookie } });
    assert.equal(del.status, 400);
    assert.match((await del.json()).error, /last admin/);
  } finally {
    server.close();
  }
});

test('scrypt hashing round-trips and session timeout honors the setting', async () => {
  assert.equal(verifyPassword('pw12345678', hashPassword('pw12345678')), true);
  assert.equal(verifyPassword('wrong', hashPassword('pw12345678')), false);

  const ctx = makeCtx({ session_timeout_minutes: '1' });
  const { server, base } = await startApp(ctx, createFleetOpsRouter);
  try {
    const r = await login(base, { password: 'envpass' });
    const exp = parseInt(r.cookie.split('=')[1].split('.')[0], 10);
    const ttlMin = (exp - Date.now()) / 60000;
    assert.ok(ttlMin > 0 && ttlMin <= 1.5, `cookie TTL ~1min, got ${ttlMin}`);
  } finally {
    server.close();
  }
});

// --- maintenance windows -------------------------------------------------------

test('maintenance windows act only on tagged clients', async () => {
  const ctx = makeCtx();
  const resets = [];
  // dryRun ctx: resetClient short-circuits, so give tagged clients real rows
  // and observe via the dryrun audit events instead of adapter calls.
  seed(ctx, 'vip-1', '00:00:00:00:01:01', { tags: 'vip' });
  seed(ctx, 'vip-2', '00:00:00:00:01:02', { tags: 'vip,corner' });
  seed(ctx, 'plain', '00:00:00:00:01:03');

  await runMaintenanceWindow(ctx, { id: 1, tag: 'vip', action: 'reset', cron: '0 5 * * *' });
  const events = db.listEvents(ctx.db, { limit: 50 });
  const dryruns = events.filter((e) => e.action === 'client.reset.dryrun');
  assert.equal(dryruns.length, 2, 'only the two vip-tagged clients reset');
  const summary = events.find((e) => e.action === 'scheduler.maintenance_window');
  assert.equal(JSON.parse(summary.after_json).count, 2);

  // Blank tag = the whole fleet.
  await runMaintenanceWindow(ctx, { id: 2, tag: '', action: 'reset', cron: '0 6 * * *' });
  const all = db.listEvents(ctx.db, { limit: 50 }).filter((e) => e.action === 'client.reset.dryrun');
  assert.equal(all.length, 5);
});

// --- webhooks --------------------------------------------------------------------

test('webhook fires only for subscribed events and survives a dead receiver', async () => {
  const received = [];
  const hook = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { received.push(JSON.parse(body)); res.end('ok'); });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${hook.address().port}/`;
  const ctx = makeCtx({ webhook_url: url, webhook_events: 'pool_warning' });
  try {
    assert.equal(await fireWebhook(ctx, 'pool_warning', { usedPercent: 91 }), true);
    assert.equal(await fireWebhook(ctx, 'nightly_summary', { count: 3 }), false); // not subscribed
    assert.equal(received.length, 1);
    assert.equal(received[0].event, 'pool_warning');
    assert.equal(received[0].usedPercent, 91);
    assert.ok(received[0].ts);

    // Dead receiver: resolves false + audits, never throws.
    db.setSetting(ctx.db, 'webhook_url', 'http://127.0.0.1:1/');
    assert.equal(await fireWebhook(ctx, 'pool_warning', {}), false);
    assert.ok(db.listEvents(ctx.db, { limit: 10 }).some((e) => e.action === 'webhook.failed'));
  } finally {
    hook.close();
  }
});

// --- /healthz, /metrics, backup/restore --------------------------------------------

test('healthz + metrics are minimal and unauthenticated; backup/restore round-trips', async () => {
  const ctx = makeCtx();
  const id = seed(ctx, 'pc-01', '00:00:00:00:02:01', { tags: 'vip' });
  db.updateClient(ctx.db, id, { status: 'booted' });
  db.setSetting(ctx.db, 'golden_snapshot', 'gold-v3');
  const { server, base } = await startApp(ctx, createSystemRouter);
  try {
    // Unauthenticated on purpose; check they don't leak details.
    const hz = await fetch(`${base}/healthz`);
    assert.equal(hz.status, 200);
    assert.deepEqual(await hz.json(), { ok: true, truenas: 'disconnected', dryRun: true });

    const metrics = await (await fetch(`${base}/metrics`)).text();
    assert.match(metrics, /fleetdeck_clients_total 1/);
    assert.match(metrics, /fleetdeck_clients_booted 1/);
    assert.match(metrics, /fleetdeck_dry_run 1/);
    assert.doesNotMatch(metrics, /pc-01|00:00:00/, 'metrics carry counts, not identities');

    const { cookie } = await login(base, { password: 'envpass' });

    // Backup -> mutate -> restore -> original state is back.
    const backupRes = await fetch(`${base}/api/backup`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(backupRes.status, 200);
    const backup = Buffer.from(await backupRes.arrayBuffer());
    assert.equal(backup.subarray(0, 15).toString(), 'SQLite format 3');

    db.updateClient(ctx.db, id, { name: 'renamed' });
    db.setSetting(ctx.db, 'golden_snapshot', 'gold-v9');

    // Without the phrase: refused.
    const refused = await fetch(`${base}/api/restore`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: backup,
    });
    assert.equal(refused.status, 400);

    const restored = await fetch(`${base}/api/restore?confirm=${encodeURIComponent(RESTORE_CONFIRM_PHRASE)}`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: backup,
    });
    assert.equal(restored.status, 200, JSON.stringify(await restored.clone().json().catch(() => null)));
    assert.equal(db.getClient(ctx.db, id).name, 'pc-01');
    assert.equal(db.getSetting(ctx.db, 'golden_snapshot', null), 'gold-v3');

    // Garbage upload: rejected by the magic check.
    const junk = await fetch(`${base}/api/restore?confirm=${encodeURIComponent(RESTORE_CONFIRM_PHRASE)}`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(2048, 7),
    });
    assert.equal(junk.status, 400);
  } finally {
    server.close();
  }
});
