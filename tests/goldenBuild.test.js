'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const db = require('../src/db');
const {
  armGoldenBuild, endGoldenBuild, expireGoldenBuild,
} = require('../src/services/goldenBuild');
const { createBootRouter } = require('../src/routes/boot');

const CONFIG = {
  goldenZvol: 'Main_pool/iscsi/win-golden',
  truenasHost: '192.168.1.36',
  dryRun: false,
};

// Adapter whose golden-target session presence is configurable. Default: no
// sessions (granular path). `sessionsGranular` left truthy/undefined so the
// granular branch runs (mirrors clientOps' strict === false check).
function makeAdapter(sessions = []) {
  return { listSessions: async () => sessions };
}

function makeCtx({ adapter = makeAdapter(), settings = {} } = {}) {
  const d = db.initDb(':memory:');
  for (const [k, v] of Object.entries(settings)) db.setSetting(d, k, v);
  return { db: d, adapter, config: { ...CONFIG } };
}

const WINPE = { winpe_chain_url: 'http://ipxeboot.local/winpe.ipxe' };

test('arming rejects when winpe_chain_url is unset', async () => {
  const ctx = makeCtx(); // no winpe setting
  await assert.rejects(
    () => armGoldenBuild(ctx, { mac: 'aa:bb:cc:dd:ee:01', durationMinutes: 60 }),
    /winpe_chain_url/
  );
  assert.equal(db.getActiveGoldenBuildSession(ctx.db), null);
});

test('arming rejects a second concurrent session for a different MAC', async () => {
  const ctx = makeCtx({ settings: WINPE });
  const first = await armGoldenBuild(ctx, { mac: 'aa:bb:cc:dd:ee:01', durationMinutes: 60 });
  assert.equal(first.mac, 'aa:bb:cc:dd:ee:01');
  await assert.rejects(
    () => armGoldenBuild(ctx, { mac: 'aa:bb:cc:dd:ee:02', durationMinutes: 60 }),
    /already armed for a different machine/
  );
  // Still exactly one active session, and it's the first one.
  const active = db.getActiveGoldenBuildSession(ctx.db);
  assert.equal(active.mac, 'aa:bb:cc:dd:ee:01');
});

test('arming rejects when a TrueNAS session already exists on the golden target', async () => {
  // A session whose target is the golden target (win-golden).
  const ctx = makeCtx({ settings: WINPE, adapter: makeAdapter([{ target: 'win-golden', initiator: 'iqn.pc' }]) });
  await assert.rejects(
    () => armGoldenBuild(ctx, { mac: 'aa:bb:cc:dd:ee:01', durationMinutes: 60 }),
    /already connected to the golden target/
  );
  assert.equal(db.getActiveGoldenBuildSession(ctx.db), null);

  // A session on some OTHER target must NOT block arming.
  const ctx2 = makeCtx({ settings: WINPE, adapter: makeAdapter([{ target: 'iqn.2005-10.org.freenas.ctl:pc07' }]) });
  const s = await armGoldenBuild(ctx2, { mac: 'aa:bb:cc:dd:ee:03', durationMinutes: 60 });
  assert.equal(s.mac, 'aa:bb:cc:dd:ee:03');
});

test('expiry closes a session past its expires_at via the background check', async () => {
  const ctx = makeCtx({ settings: WINPE });
  // Insert directly with a past expiry (arm only accepts positive durations).
  db.insertGoldenBuildSession(ctx.db, {
    mac: 'aa:bb:cc:dd:ee:04',
    startedAt: new Date(Date.now() - 7200000).toISOString(),
    expiresAt: new Date(Date.now() - 3600000).toISOString(),
  });
  assert.ok(db.getActiveGoldenBuildSession(ctx.db));

  const expired = expireGoldenBuild(ctx);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].ended_reason, 'expired');
  assert.equal(db.getActiveGoldenBuildSession(ctx.db), null);
  assert.ok(db.listEvents(ctx.db, { limit: 20 }).some((e) => e.action === 'golden_build.expired'));

  // A future-dated session is left alone.
  db.insertGoldenBuildSession(ctx.db, {
    mac: 'aa:bb:cc:dd:ee:05',
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  assert.equal(expireGoldenBuild(ctx).length, 0);
  assert.ok(db.getActiveGoldenBuildSession(ctx.db));
});

test('ending a session manually works and is idempotent', async () => {
  const ctx = makeCtx({ settings: WINPE });
  await armGoldenBuild(ctx, { mac: 'aa:bb:cc:dd:ee:06', durationMinutes: 60 });

  const ended = endGoldenBuild(ctx, { reason: 'manual' });
  assert.ok(ended);
  assert.equal(ended.ended_reason, 'manual');
  assert.equal(db.getActiveGoldenBuildSession(ctx.db), null);

  // Ending again is a harmless no-op (returns null, does not throw).
  const again = endGoldenBuild(ctx, { reason: 'manual' });
  assert.equal(again, null);
});

// --- boot.js integration ---------------------------------------------------

function startBootServer(ctx) {
  const app = express();
  app.use(express.json());
  app.use(createBootRouter(ctx));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('boot.js serves the sanhook script for an armed MAC and falls through otherwise', async () => {
  const ctx = makeCtx({ settings: WINPE });
  await armGoldenBuild(ctx, { mac: 'aa:bb:cc:dd:ee:07', durationMinutes: 60 });
  const { server, port } = await startBootServer(ctx);
  try {
    // Armed MAC -> golden build sanhook script.
    const armedRes = await fetch(`http://127.0.0.1:${port}/boot/aa-bb-cc-dd-ee-07.ipxe`);
    const armed = await armedRes.text();
    assert.match(armed, /set keep-san 1/);
    assert.match(armed, /sanhook --drive 0x80 iscsi:192\.168\.1\.36::::iqn\.2005-10\.org\.freenas\.ctl:win-golden/);
    assert.match(armed, /chain http:\/\/ipxeboot\.local\/winpe\.ipxe/);
    // A distinct audit event was logged.
    assert.ok(db.listEvents(ctx.db, { limit: 20 }).some((e) => e.action === 'boot.golden_build_serve'));

    // A different (unknown) MAC -> normal discovered/shell fallthrough, no sanhook.
    const otherRes = await fetch(`http://127.0.0.1:${port}/boot/11-22-33-44-55-66.ipxe`);
    const other = await otherRes.text();
    assert.doesNotMatch(other, /sanhook/);
    assert.match(other, /shell/);
    assert.ok(db.listEvents(ctx.db, { limit: 20 }).some((e) => e.action === 'boot.serve.unknown'));
  } finally {
    server.close();
  }
});

test('boot.js falls through when a session is armed for a DIFFERENT MAC', async () => {
  const ctx = makeCtx({ settings: WINPE });
  await armGoldenBuild(ctx, { mac: 'aa:bb:cc:dd:ee:08', durationMinutes: 60 });
  const { server, port } = await startBootServer(ctx);
  try {
    // This MAC is not the armed one -> must NOT get the sanhook script.
    const res = await fetch(`http://127.0.0.1:${port}/boot/99-88-77-66-55-44.ipxe`);
    const body = await res.text();
    assert.doesNotMatch(body, /sanhook/);
  } finally {
    server.close();
  }
});
