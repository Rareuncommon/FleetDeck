'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db = require('../src/db');
const { createSystemRouter } = require('../src/routes/system');
const { createAuthRouter } = require('../src/routes/auth');
const { requireAuth } = require('../src/middleware/requireAuth');

const SECRET = 'obs-secret';

function makeCtx(settings = {}) {
  const d = db.initDb(':memory:');
  for (const [k, v] of Object.entries(settings)) db.setSetting(d, k, v);
  return { db: d, adapter: null, config: { adminPassword: 'pw', cookieSecret: SECRET, dryRun: false } };
}

function seed(ctx, name, mac) {
  return db.insertClient(ctx.db, {
    name, mac, zvol: `Main_pool/iscsi/${name}`, target_name: name,
    golden_snapshot: 'gold-v1', notes: null,
  });
}

function startApp(ctx) {
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter(ctx));
  app.use('/api', requireAuth(SECRET));
  app.use(createSystemRouter(ctx));
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({ server: s, base: `http://127.0.0.1:${s.address().port}` }));
  });
}
async function loginCookie(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }),
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

// --- audit filters (item 44) --------------------------------------------------

test('listEvents filters by action prefix and date range', () => {
  const ctx = makeCtx();
  const id = seed(ctx, 'pc-01', '00:00:00:00:00:01');
  db.logEvent(ctx.db, { action: 'client.reset', clientId: id });
  db.logEvent(ctx.db, { action: 'client.reset.failed', clientId: id });
  db.logEvent(ctx.db, { action: 'settings.update' });

  assert.equal(db.listEvents(ctx.db, { action: 'client.' }).length, 2);
  assert.equal(db.listEvents(ctx.db, { action: 'client.reset.failed' }).length, 1);
  assert.equal(db.listEvents(ctx.db, { action: 'settings.' }).length, 1);
  // Future lower bound excludes everything just written.
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  assert.equal(db.listEvents(ctx.db, { from: future }).length, 0);
});

// --- last error per client (item 45) ------------------------------------------

test('latestErrorPerClient returns the most recent failure per client only', () => {
  const ctx = makeCtx();
  const a = seed(ctx, 'a', '00:00:00:00:00:0a');
  const b = seed(ctx, 'b', '00:00:00:00:00:0b');
  db.logEvent(ctx.db, { action: 'client.reset.failed', clientId: a, after: { error: 'old' } });
  db.logEvent(ctx.db, { action: 'client.reset', clientId: a }); // success after
  db.logEvent(ctx.db, { action: 'client.create.rollback_error', clientId: a, after: { error: 'newest' } });
  db.logEvent(ctx.db, { action: 'client.reset', clientId: b }); // b never failed

  const errs = db.latestErrorPerClient(ctx.db);
  assert.ok(errs[a]);
  assert.equal(errs[a].action, 'client.create.rollback_error'); // most recent failure wins
  assert.equal(errs[b], undefined); // no failure -> absent
});

// --- config warnings (item 47) ------------------------------------------------

test('config warnings surface recommended-but-unset settings', async () => {
  const ctx = makeCtx({ wol_enabled: '1', wol_broadcast: '255.255.255.255' });
  const { server, base } = await startApp(ctx);
  try {
    const cookie = await loginCookie(base);
    const warns = await (await fetch(`${base}/api/system/warnings`, { headers: { Cookie: cookie } })).json();
    const keys = warns.map((w) => w.key);
    assert.ok(keys.includes('webhook_url'));      // unset
    assert.ok(keys.includes('wol_broadcast'));    // enabled but limited broadcast
    assert.ok(keys.includes('api_key_created_at'));
  } finally {
    server.close();
  }
});

// --- connection state (items 42/43) -------------------------------------------

test('connection endpoint reflects ctx.connState', async () => {
  const ctx = makeCtx();
  ctx.connState = { state: 'reconnecting', attempt: 3, nextRetryAt: new Date(Date.now() + 8000).toISOString() };
  const { server, base } = await startApp(ctx);
  try {
    const cookie = await loginCookie(base);
    const c = await (await fetch(`${base}/api/system/connection`, { headers: { Cookie: cookie } })).json();
    assert.equal(c.state, 'reconnecting');
    assert.equal(c.attempt, 3);
    assert.ok(c.nextRetryAt);
  } finally {
    server.close();
  }
});

// --- changelog + per-admin unread (item 50) -----------------------------------

test('changelog parses and tracks per-admin unread state', async () => {
  const ctx = makeCtx();
  // A named admin so last_seen_version has somewhere to persist.
  const { hashPassword } = require('../src/routes/auth');
  db.insertAdmin(ctx.db, { username: 'mel', passwordHash: hashPassword('supersecret') });
  const { server, base } = await startApp(ctx);
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'mel', password: 'supersecret' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    const first = await (await fetch(`${base}/api/system/changelog`, { headers: { Cookie: cookie } })).json();
    assert.ok(first.entries.length >= 1, 'CHANGELOG.md parsed into entries');
    assert.ok(first.latest);
    assert.equal(first.unread, true); // never seen before

    // Mark seen, then it reads as read.
    await fetch(`${base}/api/system/changelog/seen`, { method: 'POST', headers: { Cookie: cookie } });
    const second = await (await fetch(`${base}/api/system/changelog`, { headers: { Cookie: cookie } })).json();
    assert.equal(second.unread, false);
    assert.equal(db.getAdminByUsername(ctx.db, 'mel').last_seen_version, first.latest);
  } finally {
    server.close();
  }
});
