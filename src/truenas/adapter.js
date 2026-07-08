'use strict';

const { resolveMethods } = require('./introspect');

const CANDIDATES = {
  snapshotList:       ['zfs.snapshot.query', 'pool.snapshot.query'],
  snapshotCreate:     ['zfs.snapshot.create', 'pool.snapshot.create'],
  snapshotClone:      ['zfs.snapshot.clone', 'pool.snapshot.clone'],
  datasetQuery:       ['pool.dataset.query'],
  datasetDelete:      ['pool.dataset.delete'],
  datasetPromote:     ['pool.dataset.promote', 'zfs.dataset.promote'],
  extentQuery:        ['iscsi.extent.query'],
  extentCreate:       ['iscsi.extent.create'],
  extentDelete:       ['iscsi.extent.delete'],
  targetQuery:        ['iscsi.target.query'],
  targetCreate:       ['iscsi.target.create'],
  targetDelete:       ['iscsi.target.delete'],
  targetExtentQuery:  ['iscsi.targetextent.query'],
  targetExtentCreate: ['iscsi.targetextent.create'],
  targetExtentDelete: ['iscsi.targetextent.delete'],
  sessionsList:       ['iscsi.global.sessions', 'iscsi.global.session_list', 'iscsi.global.client_count'],
};

class TrueNASAdapter {
  constructor(client) {
    this.client = client;
    this.methods = null;
  }

  async introspect() {
    this.methods = await resolveMethods(this.client, CANDIDATES);
    return this.methods;
  }

  _requireIntrospected() {
    if (!this.methods) {
      throw new Error('TrueNASAdapter.introspect() must be called before using adapter methods.');
    }
  }

  // Isolated because the exact wire format of TrueNAS query params (filters +
  // options) can't be verified without a live box; keeping it in one helper
  // means adjusting the shape later is a one-line change, not a sweep.
  _query(methodKey, filters = []) {
    this._requireIntrospected();
    return this.client.call(this.methods[methodKey], [filters]);
  }

  async listGoldenSnapshots(goldenZvol) {
    this._requireIntrospected();
    const filters = [
      ['dataset', '=', goldenZvol],
      ['snapshot_name', '^', 'gold-'],
    ];
    const rows = await this._query('snapshotList', filters);
    const list = Array.isArray(rows) ? rows : [];
    return list.map((snap) => ({
      id: snap.id || snap.name,
      name: snap.snapshot_name || snap.name,
      properties: snap.properties || {},
      used: snap.used != null ? snap.used : (snap.properties && snap.properties.used),
    }));
  }

  async createSnapshot(dataset, name) {
    this._requireIntrospected();
    // Best-guess field shape pending live TrueNAS verification.
    const result = await this.client.call(this.methods.snapshotCreate, [
      { dataset, name },
    ]);
    return (result && (result.id || result.name)) || result;
  }

  async cloneSnapshot(snapshotId, targetDatasetName) {
    this._requireIntrospected();
    // Best-guess field shape pending live TrueNAS verification.
    const result = await this.client.call(this.methods.snapshotClone, [
      { snapshot: snapshotId, dataset_dst: targetDatasetName },
    ]);
    return (result && (result.name || result.id)) || targetDatasetName;
  }

  async queryDataset(name) {
    const rows = await this._query('datasetQuery', [['name', '=', name]]);
    if (Array.isArray(rows) && rows.length > 0) return rows[0];
    return null;
  }

  async deleteDataset(name, { recursive = false, force = false } = {}) {
    this._requireIntrospected();
    return this.client.call(this.methods.datasetDelete, [name, { recursive, force }]);
  }

  // A ZFS clone stays dependent on its origin snapshot until promoted — without
  // this, destroying the origin's parent dataset either fails ("snapshot has
  // dependent clones") or cascade-destroys the clone too, depending on how the
  // recursive delete is implemented. Callers that clone-to-preserve data before
  // a destructive operation (see clientOps.js's quarantineBeforeDestroy) must
  // promote the clone immediately afterward so it becomes fully independent.
  async promoteDataset(name) {
    this._requireIntrospected();
    return this.client.call(this.methods.datasetPromote, [name]);
  }

  async createExtent({ name, disk }) {
    this._requireIntrospected();
    // Best-guess field shape pending live TrueNAS verification.
    const result = await this.client.call(this.methods.extentCreate, [
      { name, type: 'DISK', disk },
    ]);
    return (result && (result.id != null ? result.id : result.name)) != null
      ? (result.id != null ? result.id : result.name)
      : result;
  }

  async createTarget({ name, iqn }) {
    this._requireIntrospected();
    // Best-guess field shape pending live TrueNAS verification.
    const result = await this.client.call(this.methods.targetCreate, [
      { name, alias: iqn },
    ]);
    return (result && result.id != null) ? result.id : result;
  }

  async createTargetExtent({ targetId, extentId, lunId = 0 }) {
    this._requireIntrospected();
    // Best-guess field shape pending live TrueNAS verification.
    const result = await this.client.call(this.methods.targetExtentCreate, [
      { target: targetId, extent: extentId, lunid: lunId },
    ]);
    return (result && result.id != null) ? result.id : result;
  }

  async deleteExtent(id) {
    this._requireIntrospected();
    return this.client.call(this.methods.extentDelete, [id]);
  }

  async deleteTarget(id) {
    this._requireIntrospected();
    return this.client.call(this.methods.targetDelete, [id]);
  }

  async deleteTargetExtent(id) {
    this._requireIntrospected();
    return this.client.call(this.methods.targetExtentDelete, [id]);
  }

  async queryExtents(filters = []) {
    return this._query('extentQuery', filters);
  }

  async queryTargets(filters = []) {
    return this._query('targetQuery', filters);
  }

  async queryTargetExtents(filters = []) {
    return this._query('targetExtentQuery', filters);
  }

  async listSessions() {
    this._requireIntrospected();
    // sessionsList may resolve to a query-style method, a plain list call, or a
    // count — call with no params and normalize whatever comes back defensively.
    const raw = await this.client.call(this.methods.sessionsList, []);
    if (raw == null) return [];
    if (typeof raw === 'number') return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((s) => ({
      target: s.target || s.target_name || s.tpgt || null,
      initiator: s.initiator || s.initiator_name || s.client || null,
      ...s,
    }));
  }
}

module.exports = { TrueNASAdapter, CANDIDATES };
