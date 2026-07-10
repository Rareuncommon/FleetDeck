'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TrueNASAdapter, CANDIDATES, OPTIONAL_CAPABILITIES } = require('../src/truenas/adapter');

// A v25.10-shaped method list: every core capability plus all the new
// optional setup capabilities.
const V25_METHODS = [
  'zfs.snapshot.query', 'zfs.snapshot.create', 'zfs.snapshot.clone',
  'pool.dataset.query', 'pool.dataset.delete', 'pool.dataset.promote', 'pool.dataset.create',
  'iscsi.extent.query', 'iscsi.extent.create', 'iscsi.extent.delete',
  'iscsi.target.query', 'iscsi.target.create', 'iscsi.target.delete',
  'iscsi.targetextent.query', 'iscsi.targetextent.create', 'iscsi.targetextent.delete',
  'iscsi.global.sessions',
  'service.query', 'service.update', 'service.control',
  'iscsi.portal.query', 'iscsi.portal.create',
  'iscsi.initiator.query', 'iscsi.initiator.create',
  'sharing.smb.query', 'sharing.smb.create',
];

function fakeClient(methods, onCall = null) {
  return {
    calls: [],
    async call(method, params) {
      this.calls.push({ method, params });
      if (method === 'core.get_methods') return methods;
      return onCall ? onCall(method, params) : null;
    },
    async callJob(method, params) {
      this.calls.push({ method, params, job: true });
      return true;
    },
  };
}

test('all new setup capabilities resolve through introspect() on a v25.10 box', async () => {
  const adapter = new TrueNASAdapter(fakeClient(V25_METHODS));
  await adapter.introspect();
  for (const cap of ['datasetCreate', 'serviceQuery', 'serviceUpdate', 'serviceStart',
    'portalQuery', 'portalCreate', 'initiatorQuery', 'initiatorCreate',
    'smbShareQuery', 'smbShareCreate']) {
    assert.equal(adapter.supports(cap), true, `${cap} should resolve`);
  }
  // service.control preferred over legacy service.start when both listed.
  assert.equal(adapter.methods.serviceStart, 'service.control');
});

test('an older box missing optional methods still introspects; methods degrade honestly', async () => {
  const legacy = V25_METHODS.filter((m) => !m.startsWith('sharing.smb') && !m.startsWith('iscsi.portal'));
  const adapter = new TrueNASAdapter(fakeClient(legacy));
  await adapter.introspect(); // must not throw despite the missing optionals
  assert.equal(adapter.supports('smbShareCreate'), false);
  assert.equal(adapter.supports('portalCreate'), false);
  assert.equal(adapter.supports('datasetCreate'), true);
  // Calling an unsupported capability raises the "do it in the UI" error.
  await assert.rejects(() => adapter.createPortal({ listen: [{ ip: '0.0.0.0' }] }), /TrueNAS UI/);
});

test('startService routes through callJob for service.control, plain call for legacy', async () => {
  const modern = new TrueNASAdapter(fakeClient(V25_METHODS));
  await modern.introspect();
  await modern.startService('iscsitarget');
  const jobCall = modern.client.calls.find((c) => c.method === 'service.control');
  assert.equal(jobCall.job, true, 'service.control must go through callJob');
  assert.deepEqual(jobCall.params, ['START', 'iscsitarget', { silent: false }]);

  const legacyMethods = V25_METHODS.filter((m) => m !== 'service.control').concat('service.start');
  const legacy = new TrueNASAdapter(fakeClient(legacyMethods));
  await legacy.introspect();
  await legacy.startService('iscsitarget');
  const plainCall = legacy.client.calls.find((c) => c.method === 'service.start');
  assert.ok(plainCall && !plainCall.job, 'legacy service.start is a plain call');
});

test('every OPTIONAL_CAPABILITIES entry exists in CANDIDATES (no dangling names)', () => {
  for (const cap of OPTIONAL_CAPABILITIES) {
    assert.ok(CANDIDATES[cap], `optional capability ${cap} missing from CANDIDATES`);
  }
});
