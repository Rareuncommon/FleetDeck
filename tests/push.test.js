'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');

const db = require('../src/db');
const { createPushChannel } = require('../src/services/push');
const { signSession, COOKIE_NAME } = require('../src/middleware/requireAuth');

const SECRET = 'test-cookie-secret';

function seed(d) {
  return db.insertClient(d, {
    name: 'seed', mac: '00:00:00:00:00:01', zvol: 'Main_pool/iscsi/seed',
    target_name: 'seed', golden_snapshot: 'gold-v1', notes: null,
  });
}

// --- listEvents client filter ---------------------------------------------

test('listEvents filters by clientId and keeps the unfiltered feed intact', () => {
  const d = db.initDb(':memory:');
  const id = seed(d);
  db.logEvent(d, { action: 'client.reset', clientId: id, after: { ok: true } });
  db.logEvent(d, { action: 'settings.update', after: { some: 'thing' } });
  db.logEvent(d, { action: 'client.rebase', clientId: id });

  const all = db.listEvents(d, { limit: 10 });
  assert.equal(all.length, 3);

  const scoped = db.listEvents(d, { limit: 10, clientId: id });
  assert.deepEqual(scoped.map((e) => e.action), ['client.rebase', 'client.reset']);
  assert.ok(scoped.every((e) => e.client_id === id));
});

// --- change emitter ---------------------------------------------------------

test('db mutations emit change events with API-shaped payloads', () => {
  const d = db.initDb(':memory:');
  const seen = { events: [], clients: [] };
  const onEvent = (row) => seen.events.push(row);
  const onClients = (c) => seen.clients.push(c);
  db.changes.on('event', onEvent);
  db.changes.on('clients_changed', onClients);
  try {
    const id = seed(d);
    db.logEvent(d, { action: 'client.reset', clientId: id, after: { n: 1 } });
    db.updateClient(d, id, { status: 'booted' });
    db.updateClient(d, id, { bogus_column: 'x' }); // filtered out: must not emit
    db.deleteClient(d, id);

    assert.equal(seen.events.length, 1);
    // Same field names/serialization as rows served by GET /api/events, so
    // the frontend renders pushed and fetched events with one code path.
    assert.equal(seen.events[0].action, 'client.reset');
    assert.equal(seen.events[0].client_id, id);
    assert.equal(seen.events[0].after_json, JSON.stringify({ n: 1 }));

    assert.deepEqual(seen.clients.map((c) => c.op), ['insert', 'update', 'delete']);
    assert.deepEqual(seen.clients[1].fields, ['status']);
  } finally {
    db.changes.off('event', onEvent);
    db.changes.off('clients_changed', onClients);
  }
});

// --- WebSocket channel ------------------------------------------------------

function startChannel() {
  const server = http.createServer((req, res) => res.end('ok'));
  const ctx = { config: { cookieSecret: SECRET }, adapter: null };
  const push = createPushChannel(server, ctx);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, ctx, push, port: server.address().port });
    });
  });
}

function connect(port, { cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  return new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    ws.once('error', reject);
    ws.once('close', () => reject(new Error('closed before message')));
  });
}

test('ws upgrade rejects without a valid session cookie', async () => {
  const { server, push, port } = await startChannel();
  try {
    const ws = connect(port);
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
      /401/
    );
  } finally {
    push.stop();
    server.close();
  }
});

test('authenticated ws gets a truenas greeting then broadcast db changes', async () => {
  const { server, push, port } = await startChannel();
  try {
    const cookie = `${COOKIE_NAME}=${signSession(SECRET, Date.now() + 60000)}`;
    const ws = connect(port, { cookie });

    const greeting = await nextMessage(ws);
    assert.equal(greeting.type, 'truenas');
    assert.equal(greeting.payload.connected, false);

    // An audit event emitted by any db.logEvent call reaches the socket.
    const eventMsg = nextMessage(ws);
    db.changes.emit('event', { id: 1, action: 'client.reset', client_id: 1 });
    const got = await eventMsg;
    assert.equal(got.type, 'event');
    assert.equal(got.payload.action, 'client.reset');

    // clients_changed is debounced: a burst collapses into one broadcast.
    const clientsMsg = nextMessage(ws);
    db.changes.emit('clients_changed', { op: 'update', id: 1 });
    db.changes.emit('clients_changed', { op: 'update', id: 2 });
    db.changes.emit('clients_changed', { op: 'update', id: 3 });
    const burst = await clientsMsg;
    assert.equal(burst.type, 'clients_changed');
    // No second clients_changed arrives right behind it (100ms grace).
    const extra = await Promise.race([
      nextMessage(ws).then(() => 'extra'),
      new Promise((resolve) => setTimeout(() => resolve('none'), 400)),
    ]);
    assert.equal(extra, 'none');

    ws.close();
  } finally {
    push.stop();
    server.close();
  }
});
