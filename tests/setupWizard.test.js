'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../src/db');
const { wizardStatus, applyStep, GIB } = require('../src/services/setupWizard');

// Stateful fake adapter: creates mutate the fake state so idempotency can be
// asserted by literally running the wizard twice.
function makeSetupAdapter(init = {}) {
  const calls = [];
  const st = {
    datasets: new Set(init.datasets || []),
    zvols: new Set(init.zvols || []),
    service: init.service || { service: 'iscsitarget', state: 'STOPPED', enable: false },
    portals: init.portals || [],
    initiators: init.initiators || [],
    targets: init.targets || [],
    extents: init.extents || [],
    targetExtents: init.targetExtents || [],
    unsupported: new Set(init.unsupported || []),
  };
  let nextId = 10;
  const rec = (name, fn) => async (...args) => { calls.push({ name, args }); return fn(...args); };
  return {
    calls,
    st,
    supports: (cap) => !st.unsupported.has(cap),
    queryDataset: rec('queryDataset', async (n) => {
      if (st.zvols.has(n)) return { name: n, volsize: { parsed: 256 * GIB } };
      return st.datasets.has(n) ? { name: n } : null;
    }),
    createDataset: rec('createDataset', async (p) => {
      (p.type === 'VOLUME' ? st.zvols : st.datasets).add(p.name);
      return { ...p, id: p.name };
    }),
    queryServices: rec('queryServices', async () => [st.service]),
    setServiceEnabled: rec('setServiceEnabled', async () => { st.service.enable = true; return 1; }),
    startService: rec('startService', async () => { st.service.state = 'RUNNING'; return true; }),
    queryPortals: rec('queryPortals', async () => st.portals),
    createPortal: rec('createPortal', async (p) => {
      const row = { id: nextId++, ...p };
      st.portals.push(row);
      return row;
    }),
    queryInitiators: rec('queryInitiators', async () => st.initiators),
    createInitiator: rec('createInitiator', async (p) => {
      const row = { id: nextId++, ...p };
      st.initiators.push(row);
      return row;
    }),
    queryTargets: rec('queryTargets', async (filters) => {
      const name = filters && filters[0] && filters[0][2];
      return st.targets.filter((t) => !name || t.name === name);
    }),
    createTarget: rec('createTarget', async (p) => {
      const row = { id: nextId++, ...p };
      st.targets.push(row);
      return row.id;
    }),
    queryExtents: rec('queryExtents', async (filters) => {
      const name = filters && filters[0] && filters[0][2];
      return st.extents.filter((e) => !name || e.name === name);
    }),
    createExtent: rec('createExtent', async (p) => {
      const row = { id: nextId++, ...p };
      st.extents.push(row);
      return row.id;
    }),
    queryTargetExtents: rec('queryTargetExtents', async (filters) => {
      const target = filters && filters[0] && filters[0][2];
      return st.targetExtents.filter((te) => te.target === target);
    }),
    createTargetExtent: rec('createTargetExtent', async ({ targetId, extentId, lunId }) => {
      st.targetExtents.push({ id: nextId++, target: targetId, extent: extentId, lunid: lunId });
      return nextId;
    }),
  };
}

function makeCtx(adapter, configOverrides = {}) {
  const bootfilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-wizard-'));
  return {
    db: db.initDb(':memory:'),
    adapter,
    config: {
      clientZvolRoot: 'Main_pool/iscsi',
      goldenZvol: 'Main_pool/iscsi/win-golden',
      dryRun: false,
      bootfilesDir,
      tftpEnabled: false,
      tftpPort: 0,
      httpBind: '127.0.0.1',
      httpPort: 0,
      ...configOverrides,
    },
  };
}

const creates = (adapter) => adapter.calls.filter((c) => c.name.startsWith('create') || c.name === 'setServiceEnabled' || c.name === 'startService');

const RPC_ORDER = ['datasets', 'golden_zvol', 'iscsi_service', 'portal', 'initiator', 'target', 'extent', 'targetextent'];

test('wizard applies every step on an empty box with the proven payloads', async () => {
  const adapter = makeSetupAdapter();
  const ctx = makeCtx(adapter);

  for (const stepId of RPC_ORDER) {
    const result = await applyStep(ctx, stepId, stepId === 'golden_zvol' ? { sizeGib: 128 } : {});
    assert.equal(result.applied, true, `${stepId} should apply`);
  }

  // Golden zvol: sparse, 64K blocks, requested size — the settings that
  // worked on the real bring-up.
  const zvol = adapter.calls.find((c) => c.name === 'createDataset' && c.args[0].type === 'VOLUME').args[0];
  assert.deepEqual(zvol, {
    name: 'Main_pool/iscsi/win-golden', type: 'VOLUME',
    volsize: 128 * GIB, sparse: true, volblocksize: '64K',
  });
  // Datasets: root + _safety.
  const fsNames = adapter.calls.filter((c) => c.name === 'createDataset' && c.args[0].type === 'FILESYSTEM').map((c) => c.args[0].name);
  assert.deepEqual(fsNames, ['Main_pool/iscsi', 'Main_pool/iscsi/_safety']);
  // Portal listens on all interfaces; initiator group allows all.
  assert.deepEqual(adapter.calls.find((c) => c.name === 'createPortal').args[0].listen, [{ ip: '0.0.0.0' }]);
  assert.deepEqual(adapter.calls.find((c) => c.name === 'createInitiator').args[0].initiators, []);
  // Target gets a real portal group wired to the created portal + initiator.
  const target = adapter.calls.find((c) => c.name === 'createTarget').args[0];
  assert.equal(target.name, 'win-golden');
  assert.equal(target.groups.length, 1);
  assert.equal(target.groups[0].portal, adapter.st.portals[0].id);
  assert.equal(target.groups[0].initiator, adapter.st.initiators[0].id);
  // Extent points at the zvol device path; mapping is LUN 0.
  assert.equal(adapter.calls.find((c) => c.name === 'createExtent').args[0].disk, 'zvol/Main_pool/iscsi/win-golden');
  assert.equal(adapter.st.targetExtents[0].lunid, 0);

  // Now everything exists: the whole wizard reports ok.
  const steps = await wizardStatus(ctx);
  for (const s of steps.filter((x) => x.kind === 'rpc')) {
    assert.equal(s.ok, true, `${s.id} should be ok after apply: ${s.detail}`);
  }
});

test('second run is a no-op: every step reports already, zero creates', async () => {
  const adapter = makeSetupAdapter();
  const ctx = makeCtx(adapter);
  for (const stepId of RPC_ORDER) await applyStep(ctx, stepId, {});

  const before = creates(adapter).length;
  for (const stepId of RPC_ORDER) {
    const result = await applyStep(ctx, stepId, {});
    assert.equal(result.already, true, `${stepId} should be already-done`);
  }
  assert.equal(creates(adapter).length, before, 'no mutations on the second run');
});

test('dry-run returns payloads, executes nothing, and logs a dryrun event', async () => {
  const adapter = makeSetupAdapter();
  const ctx = makeCtx(adapter, { dryRun: true });

  const result = await applyStep(ctx, 'golden_zvol', { sizeGib: 64 });
  assert.equal(result.dryRun, true);
  assert.equal(result.payloads[0].method, 'createDataset');
  assert.equal(result.payloads[0].params.volsize, 64 * GIB);
  assert.equal(creates(adapter).length, 0, 'dry-run must not mutate');
  assert.ok(db.listEvents(ctx.db, { limit: 10 }).some((e) => e.action === 'setup.golden_zvol.dryrun'));
});

test('planOnly previews the exact RPCs without executing or logging', async () => {
  const adapter = makeSetupAdapter();
  const ctx = makeCtx(adapter);
  const preview = await applyStep(ctx, 'portal', { planOnly: true });
  assert.equal(preview.plan[0].method, 'createPortal');
  assert.equal(creates(adapter).length, 0);
  assert.equal(db.listEvents(ctx.db, { limit: 10 }).length, 0);
});

test('unsupported capabilities become instructions, not errors', async () => {
  const adapter = makeSetupAdapter({ unsupported: ['portalCreate', 'portalQuery'] });
  const ctx = makeCtx(adapter);
  const steps = await wizardStatus(ctx);
  const portal = steps.find((s) => s.id === 'portal');
  assert.equal(portal.supported, false);
  assert.match(portal.detail, /TrueNAS UI/);

  const result = await applyStep(ctx, 'portal', {});
  assert.equal(result.supported, false);
  assert.equal(creates(adapter).length, 0);
});

test('an ungrouped golden target is flagged, not treated as done', async () => {
  const adapter = makeSetupAdapter({ targets: [{ id: 5, name: 'win-golden', groups: [] }] });
  const ctx = makeCtx(adapter);
  const steps = await wizardStatus(ctx);
  const target = steps.find((s) => s.id === 'target');
  assert.equal(target.ok, false);
  assert.match(target.detail, /NO portal groups/);
});
