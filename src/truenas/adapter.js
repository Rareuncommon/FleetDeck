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
  // --- Setup-wizard capabilities (all OPTIONAL, see OPTIONAL_CAPABILITIES):
  // used to create the golden zvol / datasets, enable iSCSI, and build the
  // portal → initiator → target chain from the UI. Verified against the
  // v25.10 schema pages like the core set above.
  datasetCreate:      ['pool.dataset.create'],
  serviceQuery:       ['service.query'],
  serviceUpdate:      ['service.update'],
  serviceStart:       ['service.control', 'service.start'],
  portalQuery:        ['iscsi.portal.query'],
  portalCreate:       ['iscsi.portal.create'],
  initiatorQuery:     ['iscsi.initiator.query'],
  initiatorCreate:    ['iscsi.initiator.create'],
  smbShareQuery:      ['sharing.smb.query'],
  smbShareCreate:     ['sharing.smb.create'],
};

// Capabilities that resolve to null (instead of failing introspection) when
// the TrueNAS build doesn't expose them. Consumers must check supports() and
// degrade to "do this in the TrueNAS UI" instructions — never a button that
// errors. The original 16 core capabilities stay hard requirements.
const OPTIONAL_CAPABILITIES = new Set([
  'datasetCreate', 'serviceQuery', 'serviceUpdate', 'serviceStart',
  'portalQuery', 'portalCreate', 'initiatorQuery', 'initiatorCreate',
  'smbShareQuery', 'smbShareCreate',
]);

// Payload shapes below were checked against https://api.truenas.com/v25.10/
// (the api_methods_*.html pages). Note on jobs: that documentation marks
// long-running job methods explicitly ("This method is a job.", e.g.
// pool.scrub.scrub); none of the CORE methods used here — including
// pool.dataset.delete and pool.snapshot.clone — carry that marker in 25.10,
// so their call()s resolve with the final result directly. The one exception
// among the optional setup capabilities is service.control, which IS a job
// in 25.10 and goes through client.callJob (which polls core.get_jobs — see
// client.js for why core.job_wait can't be used).

class TrueNASAdapter {
  constructor(client) {
    this.client = client;
    this.methods = null;
    // null until introspect(); false means sessionsList resolved to the
    // count-only last resort (iscsi.global.client_count), which can't say
    // WHICH target a session belongs to. Consumers (assertNoActiveSession,
    // the session poller) must degrade fail-safe instead of treating the
    // normalized-empty session list as "no sessions anywhere".
    this.sessionsGranular = null;
  }

  async introspect() {
    this.methods = await resolveMethods(this.client, CANDIDATES, OPTIONAL_CAPABILITIES);
    this.sessionsGranular = this.methods.sessionsList !== 'iscsi.global.client_count';
    if (!this.sessionsGranular) {
      console.error(
        '[adapter] WARNING: this TrueNAS build only exposes iscsi.global.client_count — ' +
          'FleetDeck cannot tell which target a session belongs to. Per-client booted/offline ' +
          'status is unavailable, and destructive operations will refuse whenever ANY session ' +
          'is active on the fleet unless forced.'
      );
    }
    return this.methods;
  }

  _requireIntrospected() {
    if (!this.methods) {
      throw new Error('TrueNASAdapter.introspect() must be called before using adapter methods.');
    }
  }

  // Does this TrueNAS build expose an (optional) capability? UI code checks
  // this to render honest "not supported — do it in the TrueNAS UI" steps.
  supports(capability) {
    return !!(this.methods && this.methods[capability]);
  }

  _requireCapability(capability) {
    this._requireIntrospected();
    if (!this.methods[capability]) {
      throw new Error(
        `This TrueNAS build does not expose a method for "${capability}"; perform this step in the TrueNAS UI instead.`
      );
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
    // Snapshot query entries carry the FULL '<dataset>@<snap>' name in
    // id/name and the bare snap name in snapshot_name — so `id` here is
    // exactly what cloneSnapshot's `snapshot` field requires (see the
    // v25.10 pool.snapshot.clone note below), while `name` stays the short
    // gold-vN label the UI and settings store use.
    return list.map((snap) => ({
      id: snap.id || snap.name,
      name: snap.snapshot_name || snap.name,
      properties: snap.properties || {},
      used: snap.used != null ? snap.used : (snap.properties && snap.properties.used),
    }));
  }

  async createSnapshot(dataset, name) {
    this._requireIntrospected();
    // Verified against the v25.10 schema (pool.snapshot.create): { dataset,
    // name } are exactly the required fields of the with-name variant; the
    // created snapshot entry comes back, so id/name extraction below holds.
    const result = await this.client.call(this.methods.snapshotCreate, [
      { dataset, name },
    ]);
    return (result && (result.id || result.name)) || result;
  }

  async cloneSnapshot(snapshotId, targetDatasetName) {
    this._requireIntrospected();
    // Verified against the v25.10 schema (pool.snapshot.clone): `snapshot`
    // must be the FULL '<dataset>@<snap>' name (which listGoldenSnapshots /
    // createSnapshot supply as the snapshot id) and `dataset_dst` the new
    // dataset path. Returns the constant true on success, so the fallback to
    // targetDatasetName below is what callers actually get back.
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

  // Verified against the v25.10 schema (pool.dataset.delete): positional
  // [id, { recursive, force }]. Synchronous in 25.10 — not a job (see the
  // jobs note above CANDIDATES).
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
  // Verified against the v25.10 schema (pool.dataset.promote): positional
  // [id] with the clone's full path; synchronous in 25.10 — not a job (see
  // the jobs note above CANDIDATES).
  async promoteDataset(name) {
    this._requireIntrospected();
    return this.client.call(this.methods.datasetPromote, [name]);
  }

  async createExtent({ name, disk }) {
    this._requireIntrospected();
    // Verified against the v25.10 schema (iscsi.extent.create): { name,
    // type: 'DISK', disk } with disk as the device path — 'zvol/<path>' for
    // zvol-backed extents, which callers already prefix. The schema doesn't
    // pin an escaping rule for spaces/special chars in that path, but
    // FleetDeck slugs client names to [a-z0-9-] so its own zvol paths can
    // never contain any.
    const result = await this.client.call(this.methods.extentCreate, [
      { name, type: 'DISK', disk },
    ]);
    return (result && (result.id != null ? result.id : result.name)) != null
      ? (result.id != null ? result.id : result.name)
      : result;
  }

  // Verified against the v25.10 schema (iscsi.target.create): `groups` is what
  // binds a target to a portal (and optionally an initiator group), and it
  // DEFAULTS TO [] — a target created without groups is not published on any
  // portal, so initiators can never see or connect to it. That's why an empty
  // `groups` is a hard error here instead of a silent default. (`alias` is just
  // a human-readable label — the full IQN is derived by TrueNAS as
  // `<global basename>:<name>` — so we don't send it at all.)
  async createTarget({ name, groups }) {
    this._requireIntrospected();
    if (!Array.isArray(groups) || groups.length === 0) {
      throw new Error(
        `Refusing to create iSCSI target "${name}" with no portal groups: it would be invisible to initiators.`
      );
    }
    const result = await this.client.call(this.methods.targetCreate, [
      { name, mode: 'ISCSI', groups },
    ]);
    return (result && result.id != null) ? result.id : result;
  }

  async createTargetExtent({ targetId, extentId, lunId = 0 }) {
    this._requireIntrospected();
    // Verified against the v25.10 schema (iscsi.targetextent.create):
    // { target, extent, lunid } — target/extent are the integer row ids,
    // lunid may also be null for auto-assignment (we pin 0 deliberately:
    // one LUN per target).
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

  // Fleet-wide session count that works regardless of which sessionsList
  // method introspection resolved to — the safety net for count-only builds
  // (see sessionsGranular), where listSessions() normalizes to [] and would
  // otherwise read as "nothing is booted".
  async sessionCount() {
    this._requireIntrospected();
    const raw = await this.client.call(this.methods.sessionsList, []);
    if (typeof raw === 'number') return raw;
    if (Array.isArray(raw)) return raw.length;
    return raw == null ? 0 : 1;
  }

  // --- Setup-wizard capabilities (all OPTIONAL — callers check supports()
  // and render "do this in the TrueNAS UI" guidance when unsupported) ------

  // Verified against the v25.10 schema (pool.dataset.create): one object
  // param; the Volume variant takes { name, type: 'VOLUME', volsize,
  // sparse, volblocksize }, the Filesystem variant { name } (+ options).
  // Callers pass the full payload since the wizard also displays it verbatim
  // as the would-be RPC in dry-run.
  async createDataset(payload) {
    this._requireCapability('datasetCreate');
    return this.client.call(this.methods.datasetCreate, [payload]);
  }

  async queryServices(filters = []) {
    this._requireCapability('serviceQuery');
    return this.client.call(this.methods.serviceQuery, [filters]);
  }

  // Verified against the v25.10 schema (service.update): [id_or_name,
  // { enable }] — `enable` is only the start-on-boot flag; the running state
  // is startService's business.
  async setServiceEnabled(idOrName, enable) {
    this._requireCapability('serviceUpdate');
    return this.client.call(this.methods.serviceUpdate, [idOrName, { enable }]);
  }

  async startService(name) {
    this._requireCapability('serviceStart');
    if (this.methods.serviceStart === 'service.control') {
      // Verified against the v25.10 schema (service.control): [verb, service,
      // options], and it IS a job — the one job method FleetDeck calls, hence
      // callJob (see client.js). silent:false makes a failed start raise
      // instead of quietly resolving false.
      return this.client.callJob(this.methods.serviceStart, ['START', name, { silent: false }]);
    }
    // Legacy pre-25.10 service.start: [service, options], plain call.
    return this.client.call(this.methods.serviceStart, [name, { silent: false }]);
  }

  async queryPortals(filters = []) {
    this._requireCapability('portalQuery');
    return this.client.call(this.methods.portalQuery, [filters]);
  }

  // Verified against the v25.10 schema (iscsi.portal.create): { listen:
  // [{ ip }], comment } — note there is NO port field in 25.10; portals
  // always listen on 3260. ip '0.0.0.0' listens on all interfaces.
  async createPortal({ listen, comment = '' }) {
    this._requireCapability('portalCreate');
    return this.client.call(this.methods.portalCreate, [{ listen, comment }]);
  }

  async queryInitiators(filters = []) {
    this._requireCapability('initiatorQuery');
    return this.client.call(this.methods.initiatorQuery, [filters]);
  }

  // Verified against the v25.10 schema (iscsi.initiator.create):
  // { initiators: [], comment } — an EMPTY initiators array means
  // "allow all initiators", which is what the wizard creates.
  async createInitiator({ initiators = [], comment = '' }) {
    this._requireCapability('initiatorCreate');
    return this.client.call(this.methods.initiatorCreate, [{ initiators, comment }]);
  }

  async querySmbShares(filters = []) {
    this._requireCapability('smbShareQuery');
    return this.client.call(this.methods.smbShareQuery, [filters]);
  }

  // Verified against the v25.10 schema (sharing.smb.create): { path, name,
  // purpose, comment, ... } with purpose defaulting to DEFAULT_SHARE (the
  // recommended mode). Full payload passed through for the same dry-run
  // display reason as createDataset.
  async createSmbShare(payload) {
    this._requireCapability('smbShareCreate');
    return this.client.call(this.methods.smbShareCreate, [payload]);
  }
}

module.exports = { TrueNASAdapter, CANDIDATES, OPTIONAL_CAPABILITIES };
