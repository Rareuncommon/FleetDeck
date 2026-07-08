'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const {
  createClient, resetClient, rebaseClient, retireClient,
} = require('../src/services/clientOps');

// Real in-memory SQLite via the actual db module — no mocking of the data
// layer, so guardrail/rollback behaviour is exercised against the real
// insert/update/delete/log path. Only TrueNAS is faked.
function freshDb() {
  return db.initDb(':memory:');
}

// --- Fake adapter --------------------------------------------------------
function makeAdapter(overrides = {}) {
  const calls = [];
  const rec = (name) => async (...args) => {
    calls.push({ name, args });
    if (overrides[name]) return overrides[name](...args);
    if (name === 'listGoldenSnapshots') return [{ id: 'snap-1', name: 'gold-v1' }];
    if (name === 'cloneSnapshot') return args[1];
    if (name === 'createExtent') return 'extent-1';
    if (name === 'createTarget') return 'target-1';
    if (name === 'createTargetExtent') return 'te-1';
    if (name === 'listSessions') return [];
    // Default fleet has a working golden target whose portal groups new
    // clients copy (see clientOps.resolveTargetGroups); the extra `id` field
    // mimics query-result decoration that must be stripped before create.
    if (name === 'queryTargets') {
      return [{
        id: 9, name: 'golden',
        groups: [{ id: 1, portal: 1, initiator: null, authmethod: 'NONE', auth: null, auth_networks: [] }],
      }];
    }
    if (name === 'queryExtents' || name === 'queryTargetExtents') return [];
    return undefined;
  };
  const methods = [
    'listGoldenSnapshots', 'createSnapshot', 'cloneSnapshot', 'queryDataset', 'deleteDataset',
    'createExtent', 'createTarget', 'createTargetExtent', 'deleteExtent', 'deleteTarget',
    'deleteTargetExtent', 'queryExtents', 'queryTargets', 'queryTargetExtents', 'listSessions',
  ];
  const adapter = { calls };
  for (const m of methods) adapter[m] = rec(m);
  return adapter;
}

function makeCtx(adapter, configOverrides = {}) {
  return {
    db: freshDb(),
    adapter,
    config: {
      iqnPrefix: 'iqn.2024-01.local.fleetdeck',
      goldenZvol: 'Main_pool/iscsi/golden',
      clientZvolRoot: 'Main_pool/iscsi',
      dryRun: false,
      ...configOverrides,
    },
  };
}

const names = (adapter) => adapter.calls.map((c) => c.name);

function seedClient(ctx, fields) {
  const id = db.insertClient(ctx.db, {
    name: 'seed', mac: '00:00:00:00:00:01', zvol: 'Main_pool/iscsi/seed',
    target_name: 'seed', golden_snapshot: 'gold-v1', notes: null, ...fields,
  });
  return id;
}

test('createClient happy path calls in order and inserts a client', async () => {
  const adapter = makeAdapter();
  const ctx = makeCtx(adapter);

  const row = await createClient(ctx, { name: 'Client01', mac: 'aa:bb:cc:dd:ee:ff' });

  assert.deepEqual(names(adapter), [
    'listGoldenSnapshots', 'queryTargets', 'cloneSnapshot', 'createExtent', 'createTarget', 'createTargetExtent',
  ]);
  assert.equal(row.name, 'Client01');
  assert.equal(row.zvol, 'Main_pool/iscsi/client01');
  assert.equal(row.target_name, 'client01');
  assert.equal(row.golden_snapshot, 'gold-v1');
  assert.equal(db.listClients(ctx.db).length, 1);

  const clone = adapter.calls.find((c) => c.name === 'cloneSnapshot');
  assert.equal(clone.args[0], 'snap-1'); // resolved id, not the name
  assert.equal(clone.args[1], 'Main_pool/iscsi/client01');

  // Portal groups are copied from the golden target, stripped down to the
  // iscsi.target.create schema fields (no `id` decoration from the query).
  const target = adapter.calls.find((c) => c.name === 'createTarget');
  assert.deepEqual(target.args[0], {
    name: 'client01',
    groups: [{ portal: 1, initiator: null, authmethod: 'NONE', auth: null, auth_networks: [] }],
  });
});

test('createClient throws and touches nothing when no target with groups exists', async () => {
  const adapter = makeAdapter({
    queryTargets: () => [],
  });
  const ctx = makeCtx(adapter);

  await assert.rejects(
    () => createClient(ctx, { name: 'Client04', mac: '0a:0b:0c:0d:0e:0f' }),
    /No existing iSCSI target with portal groups/
  );

  // Both queryTargets probes (golden by name, then any target) ran, but no
  // mutation and no rollback ever happened — nothing was created.
  assert.deepEqual(names(adapter), ['listGoldenSnapshots', 'queryTargets', 'queryTargets']);
  assert.equal(db.listClients(ctx.db).length, 0);
});

test('createClient rolls back created objects in reverse when a mid-step fails', async () => {
  const adapter = makeAdapter({
    createTarget: () => { throw new Error('target boom'); },
  });
  const ctx = makeCtx(adapter);

  await assert.rejects(
    () => createClient(ctx, { name: 'Client02', mac: '11:22:33:44:55:66' }),
    (err) => {
      assert.match(err.message, /rolled back/);
      assert.match(err.message, /target boom/);
      return true;
    }
  );

  // dataset + extent existed before the failing createTarget; tear down in
  // reverse (extent then dataset). target/targetExtent were never created.
  assert.deepEqual(names(adapter), [
    'listGoldenSnapshots', 'queryTargets', 'cloneSnapshot', 'createExtent', 'createTarget',
    'deleteExtent', 'deleteDataset',
  ]);
  const delExtent = adapter.calls.find((c) => c.name === 'deleteExtent');
  const delDataset = adapter.calls.find((c) => c.name === 'deleteDataset');
  assert.equal(delExtent.args[0], 'extent-1');
  assert.equal(delDataset.args[0], 'Main_pool/iscsi/client02');
  assert.equal(db.listClients(ctx.db).length, 0); // no row inserted
});

test('createClient rollback tears down all four objects when the last step fails', async () => {
  const adapter = makeAdapter({
    createTargetExtent: () => { throw new Error('te boom'); },
  });
  const ctx = makeCtx(adapter);

  await assert.rejects(() => createClient(ctx, { name: 'Client03', mac: 'a1:b2:c3:d4:e5:f6' }));

  assert.deepEqual(names(adapter), [
    'listGoldenSnapshots', 'queryTargets', 'cloneSnapshot', 'createExtent', 'createTarget', 'createTargetExtent',
    'deleteTarget', 'deleteExtent', 'deleteDataset',
  ]);
  assert.equal(db.listClients(ctx.db).length, 0);
});

test('resetClient refuses when zvol is outside clientZvolRoot', async () => {
  const adapter = makeAdapter();
  const ctx = makeCtx(adapter);
  const id = seedClient(ctx, { zvol: 'Other_pool/data/stray', mac: '00:00:00:00:00:02' });

  await assert.rejects(() => resetClient(ctx, id), /not under Main_pool\/iscsi\//);
  assert.equal(adapter.calls.length, 0); // guardrail fires before any adapter call
});

test('resetClient refuses to touch a snapshot path or the golden zvol', async () => {
  const adapter = makeAdapter();
  const ctx = makeCtx(adapter);

  const goldId = seedClient(ctx, { zvol: 'Main_pool/iscsi/golden', target_name: 'golden', mac: '00:00:00:00:00:03' });
  await assert.rejects(() => resetClient(ctx, goldId), /golden zvol/);

  const snapId = seedClient(ctx, { zvol: 'Main_pool/iscsi/client01@gold-v1', target_name: 'client01-snap', mac: '00:00:00:00:00:04' });
  await assert.rejects(() => resetClient(ctx, snapId), /snapshot path/);

  assert.equal(adapter.calls.length, 0);
});

test('resetClient with an active session throws unless force=true', async () => {
  const withSession = () => makeAdapter({
    listSessions: () => [{ target: 'client01', initiator: 'iqn.pc' }],
  });

  let adapter = withSession();
  let ctx = makeCtx(adapter);
  seedClient(ctx, { name: 'Client01', zvol: 'Main_pool/iscsi/client01', target_name: 'client01', mac: '00:00:00:00:00:05' });
  await assert.rejects(() => resetClient(ctx, 1, { force: false }), /active iSCSI session/);
  assert.ok(!names(adapter).includes('deleteDataset'));

  adapter = withSession();
  ctx = makeCtx(adapter);
  seedClient(ctx, { name: 'Client01', zvol: 'Main_pool/iscsi/client01', target_name: 'client01', mac: '00:00:00:00:00:06' });
  const row = await resetClient(ctx, 1, { force: true });
  const seq = names(adapter);
  assert.ok(seq.includes('deleteDataset'));
  assert.ok(seq.includes('cloneSnapshot'));
  assert.equal(row.id, 1);
});

test('retireClient with an active session rejects and deletes nothing unless forced', async () => {
  const withSession = () => makeAdapter({
    listSessions: () => [{ target: 'client01', initiator: 'iqn.pc' }],
    // Retire looks the target/extent up by the client's own name here, so the
    // default golden-target fixture would be the wrong row to return.
    queryTargets: () => [{ id: 3, name: 'client01', groups: [{ portal: 1 }] }],
    queryExtents: () => [{ id: 5, name: 'client01' }],
    queryTargetExtents: () => [{ id: 8, target: 3 }],
  });

  let adapter = withSession();
  let ctx = makeCtx(adapter);
  seedClient(ctx, { name: 'Client01', zvol: 'Main_pool/iscsi/client01', target_name: 'client01', mac: '00:00:00:00:00:08' });
  await assert.rejects(() => retireClient(ctx, 1), /active iSCSI session/);
  const seq = names(adapter);
  assert.ok(!seq.some((n) => n.startsWith('delete')), `expected no delete calls, got: ${seq}`);
  assert.equal(db.listClients(ctx.db).length, 1); // row survives

  adapter = withSession();
  ctx = makeCtx(adapter);
  seedClient(ctx, { name: 'Client01', zvol: 'Main_pool/iscsi/client01', target_name: 'client01', mac: '00:00:00:00:00:09' });
  await retireClient(ctx, 1, { force: true });
  const forced = names(adapter);
  assert.ok(forced.includes('deleteTargetExtent'));
  assert.ok(forced.includes('deleteTarget'));
  assert.ok(forced.includes('deleteExtent'));
  assert.ok(forced.includes('deleteDataset'));
  assert.equal(db.listClients(ctx.db).length, 0);
});

test('count-only session reporting blocks reset whenever any session is active', async () => {
  // Adapter degraded to iscsi.global.client_count: listSessions normalizes to
  // [] (useless), so the guard must fall back to the fleet-wide count.
  const withCount = (n) => {
    const adapter = makeAdapter({ listSessions: () => [] });
    adapter.sessionsGranular = false;
    adapter.sessionCount = async () => n;
    return adapter;
  };

  let ctx = makeCtx(withCount(2));
  seedClient(ctx, { name: 'Client01', zvol: 'Main_pool/iscsi/client01', target_name: 'client01', mac: '00:00:00:00:00:0a' });
  await assert.rejects(() => resetClient(ctx, 1), /can only report a count/);
  assert.ok(!names(ctx.adapter).includes('deleteDataset'));

  // Zero sessions fleet-wide: safe to proceed even without granularity.
  ctx = makeCtx(withCount(0));
  seedClient(ctx, { name: 'Client01', zvol: 'Main_pool/iscsi/client01', target_name: 'client01', mac: '00:00:00:00:00:0b' });
  const row = await resetClient(ctx, 1);
  assert.ok(names(ctx.adapter).includes('deleteDataset'));
  assert.equal(row.id, 1);
});

test('rebaseClient reclones from the new snapshot and records it', async () => {
  const adapter = makeAdapter({
    listGoldenSnapshots: () => [
      { id: 'snap-1', name: 'gold-v1' },
      { id: 'snap-2', name: 'gold-v2' },
    ],
  });
  const ctx = makeCtx(adapter);
  seedClient(ctx, { name: 'Client01', zvol: 'Main_pool/iscsi/client01', target_name: 'client01', mac: '00:00:00:00:00:07' });

  const row = await rebaseClient(ctx, 1, { goldenSnapshot: 'gold-v2' });
  const clone = adapter.calls.find((c) => c.name === 'cloneSnapshot');
  assert.equal(clone.args[0], 'snap-2');
  assert.equal(row.golden_snapshot, 'gold-v2');
});
