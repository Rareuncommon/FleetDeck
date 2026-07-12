'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db = require('../src/db');
const { createGuestRouter } = require('../src/routes/guest');
const { createBootRouter } = require('../src/routes/boot');

// Exercise pollOnce directly (not the timer) for transition/timeout tests.
const { startSessionPoller } = require('../src/services/sessionPoller');

function makeCtx({ sessions = [], settings = {} } = {}) {
  const d = db.initDb(':memory:');
  for (const [k, v] of Object.entries(settings)) db.setSetting(d, k, v);
  const adapter = {
    calls: [],
    listSessions: async () => sessions,
    queryDataset: async () => null,
    listGoldenSnapshots: async () => [{ id: 'Main_pool/iscsi/win-golden@gold-v1', name: 'gold-v1' }],
    createSnapshot: async () => 'snap',
    cloneSnapshot: async (s, dst) => dst,
    promoteDataset: async () => null,
    deleteDataset: async function (...args) { this.calls.push(['deleteDataset', ...args]); },
    queryTargets: async () => [],
    supports: () => true,
  };
  adapter.deleteDataset = adapter.deleteDataset.bind(adapter);
  return {
    db: d,
    adapter,
    config: {
      clientZvolRoot: 'Main_pool/iscsi', goldenZvol: 'Main_pool/iscsi/win-golden',
      truenasHost: '192.168.1.36', dryRun: false,
    },
  };
}

function seed(ctx, over = {}) {
  const id = db.insertClient(ctx.db, {
    name: 'pc-01', mac: 'aa:bb:cc:dd:ee:30', zvol: 'Main_pool/iscsi/pc-01',
    target_name: 'pc-01', golden_snapshot: 'gold-v1', notes: null, ...over,
  });
  return id;
}

// pollOnce isn't exported; run one poller tick synchronously via the
// start/stop pair (tick() fires immediately on start).
async function tickOnce(ctx) {
  const stop = startSessionPoller(ctx, 60 * 60 * 1000);
  await new Promise((r) => setTimeout(r, 50)); // let the immediate tick finish
  stop();
}

test('poller transitions open and close session history rows', async () => {
  const ctx = makeCtx({ sessions: [{ target: 'pc-01' }] });
  const id = seed(ctx);

  await tickOnce(ctx); // offline -> booted: opens a session
  let open = db.getOpenSession(ctx.db, id);
  assert.ok(open, 'session row opened on booted transition');
  assert.equal(db.getClient(ctx.db, id).status, 'booted');

  ctx.adapter.listSessions = async () => []; // machine went away
  await tickOnce(ctx); // booted -> offline: closes it
  open = db.getOpenSession(ctx.db, id);
  assert.equal(open, null);
  const history = db.listClientSessions(ctx.db, id);
  assert.equal(history.length, 1);
  assert.ok(history[0].ended_at);
  assert.ok(history[0].duration_seconds >= 0);
});

test('idle timeout force-resets once per session, not every tick', async () => {
  const ctx = makeCtx({
    sessions: [{ target: 'pc-01' }],
    settings: { guest_idle_timeout_minutes: '60' },
  });
  const id = seed(ctx);

  await tickOnce(ctx); // opens the session
  // Backdate the open session past the timeout.
  const open = db.getOpenSession(ctx.db, id);
  ctx.db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 2 * 3600 * 1000).toISOString(), open.id);

  await tickOnce(ctx); // exceeds timeout -> forced reset
  const resets1 = ctx.adapter.calls.filter((c) => c[0] === 'deleteDataset').length;
  assert.equal(resets1, 1, 'one forced reset fired');
  assert.ok(db.getOpenSession(ctx.db, id).idle_reset_at, 'session marked as idle-reset');
  assert.ok(db.listEvents(ctx.db, { limit: 20 }).some((e) => e.action === 'client.idle_timeout_reset'));

  await tickOnce(ctx); // session still live (iSCSI outlives the reset)…
  const resets2 = ctx.adapter.calls.filter((c) => c[0] === 'deleteDataset').length;
  assert.equal(resets2, 1, 'marker prevents a reset storm');
});

test('heartbeat endpoint stamps the client and rejects unknowns', async () => {
  const ctx = makeCtx();
  const id = seed(ctx);
  const app = express();
  app.use(express.json());
  app.use(createBootRouter(ctx));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = await fetch(`${base}/boot/aa-bb-cc-dd-ee-30/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ safety_script_ran: true }),
    });
    assert.equal(ok.status, 200);
    assert.ok(db.getClient(ctx.db, id).last_heartbeat_at);
    assert.ok(db.listEvents(ctx.db, { limit: 10 }).some((e) => e.action === 'client.heartbeat'));

    const unknown = await fetch(`${base}/boot/11-22-33-44-55-66/heartbeat`, { method: 'POST' });
    assert.equal(unknown.status, 404);
    const malformed = await fetch(`${base}/boot/zzz/heartbeat`, { method: 'POST' });
    assert.equal(malformed.status, 400);
  } finally {
    server.close();
  }
});

test('public /status leaks names + availability and nothing else', async () => {
  const ctx = makeCtx({ settings: { guest_motd: 'Tournament at 7pm' } });
  const id = seed(ctx);
  db.updateClient(ctx.db, id, { status: 'booted' });
  const app = express();
  app.use(express.json());
  app.use(createGuestRouter(ctx));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const html = await (await fetch(`${base}/status`)).text();
    assert.match(html, /pc-01/);
    assert.match(html, /in use/);
    assert.match(html, /Tournament at 7pm/); // guest_motd banner
    // The leak checks: nothing but name + availability may appear.
    assert.doesNotMatch(html, /aa:bb:cc:dd:ee:30/, 'MAC must not leak');
    assert.doesNotMatch(html, /Main_pool/, 'zvol path must not leak');
    assert.doesNotMatch(html, /gold-v1/, 'snapshot names must not leak');
  } finally {
    server.close();
  }
});

test('gpu_vendor validates its enum; hardware gaps round-trip', async () => {
  const ctx = makeCtx();
  const id = seed(ctx);
  const app = express();
  app.use(express.json());
  app.use(createGuestRouter(ctx));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const bad = await fetch(`${base}/api/clients/${id}/meta`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gpu_vendor: '3dfx' }),
    });
    assert.equal(bad.status, 400);
    const good = await fetch(`${base}/api/clients/${id}/meta`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gpu_vendor: 'nvidia', notes: 'corner machine' }),
    });
    assert.equal(good.status, 200);
    const row = db.getClient(ctx.db, id);
    assert.equal(row.gpu_vendor, 'nvidia');
    assert.equal(row.notes, 'corner machine');

    const created = await fetch(`${base}/api/hardware-gaps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: id, description: 'NIC driver missing' }),
    });
    assert.equal(created.status, 201);
    const list = await (await fetch(`${base}/api/hardware-gaps`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].description, 'NIC driver missing');
    const gone = await fetch(`${base}/api/hardware-gaps/${list[0].id}`, { method: 'DELETE' });
    assert.equal(gone.status, 200);
    assert.equal((await (await fetch(`${base}/api/hardware-gaps`)).json()).length, 0);
  } finally {
    server.close();
  }
});
