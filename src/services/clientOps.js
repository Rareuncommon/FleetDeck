'use strict';

const {
  getClient, getClientByMac, listClients, insertClient, updateClient, deleteClient,
  getSetting, setSetting, logEvent, insertSafetySnapshot,
} = require('../db');
const { sendWakeOnLan } = require('./wol');

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function leafOf(zvol) {
  return String(zvol || '').split('/').pop();
}

function firstId(rows) {
  if (Array.isArray(rows) && rows.length > 0) {
    const r = rows[0];
    if (r && r.id != null) return r.id;
  }
  return null;
}

// Hard guardrails: never destroy anything outside the client zvol root, and
// never target the golden zvol or a snapshot path. Enforced regardless of force.
function assertSafeToDestroy(ctx, client) {
  if (!client) throw new Error('Client not found');
  const zvol = client.zvol;
  const root = `${ctx.config.clientZvolRoot}/`;
  if (!zvol || !zvol.startsWith(root)) {
    throw new Error(`Refusing to touch zvol "${zvol}": not under ${root}`);
  }
  if (zvol === ctx.config.goldenZvol) {
    throw new Error(`Refusing to touch the golden zvol "${zvol}"`);
  }
  if (zvol.includes('@')) {
    throw new Error(`Refusing to touch snapshot path "${zvol}"`);
  }
}

// Anchor the match on a ':' boundary (the IQN target separator) so a target
// named "pc1" cannot be matched by a session for "pc10" or "mypc1" (plain
// includes()/endsWith() against the bare name would false-positive on both).
function targetMatches(sessionTarget, targetName) {
  if (!sessionTarget || !targetName) return false;
  const t = String(sessionTarget);
  return t === targetName || t.endsWith(`:${targetName}`);
}

async function assertNoActiveSession(ctx, client, force) {
  if (force) return;
  // Strict === false: only the count-only degraded mode (set by
  // adapter.introspect when sessionsList resolved to
  // iscsi.global.client_count) takes this path — adapters without the
  // property (test mocks, older code) keep the granular path below. On a
  // count-only build listSessions() normalizes to [], which would read as
  // "no sessions anywhere" and silently disable this guard; fail safe on the
  // fleet-wide count instead. (The nightly scheduler always forces, so it's
  // unaffected.)
  if (ctx.adapter.sessionsGranular === false) {
    const count = await ctx.adapter.sessionCount();
    if (count > 0) {
      throw new Error(
        `${count} iSCSI session(s) are active somewhere on the fleet, and this TrueNAS build can ` +
          `only report a count — not which target — so "${client.name}" cannot be proven idle; ` +
          'pass { force: true } to proceed.'
      );
    }
    return;
  }
  const sessions = await ctx.adapter.listSessions();
  const active = (sessions || []).some((s) => targetMatches(s && s.target, client.target_name));
  if (active) {
    throw new Error(
      `Client "${client.name}" has an active iSCSI session; pass { force: true } to proceed.`
    );
  }
}

async function resolveSnapshotId(ctx, nameOrId) {
  const list = await ctx.adapter.listGoldenSnapshots(ctx.config.goldenZvol);
  const match = (list || []).find((s) => s.id === nameOrId || s.name === nameOrId);
  if (!match) {
    // Must throw, not silently pass `nameOrId` through as if it were a real
    // snapshot id: this runs BEFORE the client's zvol is destroyed, so failing
    // loudly here means reclone() aborts with nothing touched. Falling back to
    // an unresolvable placeholder (e.g. a reconcile-imported client's
    // golden_snapshot of 'unknown') would instead destroy the zvol and only
    // THEN discover cloneSnapshot has nothing valid to reprovision from,
    // leaving the client with no zvol at all.
    throw new Error(
      `No golden snapshot matches "${nameOrId}" on ${ctx.config.goldenZvol}; refusing to proceed`
    );
  }
  return match.id;
}

// Picks the highest gold-vN by parsed version number, not list order (TrueNAS's
// query result order is not a version guarantee, and even if it were, lexical
// order would put "gold-v10" before "gold-v2"). Falls back to the last entry
// for snapshots that don't match the gold-vN naming convention.
function highestVersioned(list) {
  let best = null;
  let bestVersion = -1;
  for (const snap of list) {
    const m = /^gold-v(\d+)$/.exec(snap.name || '');
    const version = m ? parseInt(m[1], 10) : -1;
    if (version > bestVersion) {
      bestVersion = version;
      best = snap;
    }
  }
  return best || list[list.length - 1];
}

async function resolveDefaultGolden(ctx) {
  const settingName = getSetting(ctx.db, 'golden_snapshot', null);
  const list = (await ctx.adapter.listGoldenSnapshots(ctx.config.goldenZvol)) || [];
  if (settingName) {
    const match = list.find((s) => s.name === settingName || s.id === settingName);
    if (match) return { id: match.id, name: match.name };
    return { id: settingName, name: settingName };
  }
  const last = list.length > 0 ? highestVersioned(list) : null;
  if (!last) throw new Error(`No golden snapshot available on ${ctx.config.goldenZvol}`);
  return { id: last.id, name: last.name };
}

// A target's `groups` (portal + initiator-group bindings) is what makes it
// visible to initiators at all, and the correct portal/initiator ids are
// site-specific — we can't invent them. Copy them from a known-working target
// instead: preferably the golden target (it demonstrably boots on the right
// portal), else any existing target that has groups. Keep only the
// create-schema fields per group — query results may carry extra decoration
// (e.g. row ids) that iscsi.target.create would reject or misinterpret.
function copyCreateGroups(groups) {
  return groups.map((g) => ({
    portal: g.portal,
    initiator: g.initiator != null ? g.initiator : null,
    authmethod: g.authmethod || 'NONE',
    auth: g.auth != null ? g.auth : null,
    auth_networks: Array.isArray(g.auth_networks) ? [...g.auth_networks] : [],
  }));
}

function hasGroups(target) {
  return target && Array.isArray(target.groups) && target.groups.length > 0;
}

async function resolveTargetGroups(ctx) {
  const goldenTargetName = leafOf(ctx.config.goldenZvol);
  const goldenRows = await ctx.adapter.queryTargets([['name', '=', goldenTargetName]]);
  const golden = (Array.isArray(goldenRows) ? goldenRows : []).find(hasGroups);
  if (golden) {
    return { groups: copyCreateGroups(golden.groups), copiedFrom: golden.name || goldenTargetName };
  }
  const allRows = await ctx.adapter.queryTargets([]);
  const fallback = (Array.isArray(allRows) ? allRows : []).find(hasGroups);
  if (fallback) {
    return { groups: copyCreateGroups(fallback.groups), copiedFrom: fallback.name };
  }
  throw new Error(
    `No existing iSCSI target with portal groups found to copy from (looked for "${goldenTargetName}" first, ` +
      'then any target). Create at least one working target — e.g. the golden target — in the TrueNAS UI ' +
      'so FleetDeck has a portal/initiator group configuration to copy for new clients.'
  );
}

async function rollback(ctx, created) {
  // Reverse order; swallow (log) errors so a rollback failure can't mask the
  // original error that triggered the unwind.
  for (let i = created.length - 1; i >= 0; i -= 1) {
    const obj = created[i];
    try {
      if (obj.type === 'targetExtent') await ctx.adapter.deleteTargetExtent(obj.ref);
      else if (obj.type === 'target') await ctx.adapter.deleteTarget(obj.ref);
      else if (obj.type === 'extent') await ctx.adapter.deleteExtent(obj.ref);
      else if (obj.type === 'dataset') await ctx.adapter.deleteDataset(obj.ref, { recursive: true, force: true });
    } catch (err) {
      logEvent(ctx.db, {
        action: 'client.create.rollback_error',
        after: { type: obj.type, ref: String(obj.ref), error: err.message },
      });
    }
  }
}

async function createClient(ctx, { name, mac }) {
  const leaf = slug(name);
  const zvol = `${ctx.config.clientZvolRoot}/${leaf}`;

  // Check for collisions before touching TrueNAS at all: a mac UNIQUE
  // violation (or a name-slug collision, e.g. "PC 1" and "PC-1" both -> "pc-1")
  // must not be discovered only after cloning/creating real infrastructure
  // that then has to be rolled back for no reason.
  if (getClientByMac(ctx.db, mac)) {
    throw new Error(`A client with mac "${mac}" already exists`);
  }
  if (listClients(ctx.db).some((c) => c.zvol === zvol || c.target_name === leaf)) {
    throw new Error(`A client already resolves to zvol/target "${leaf}" (name collision)`);
  }

  if (ctx.config.dryRun) {
    const goldenName = getSetting(ctx.db, 'golden_snapshot', null) || 'gold-vX';
    logEvent(ctx.db, {
      action: 'client.create.dryrun',
      after: {
        name, mac, zvol, target_name: leaf, extent_name: leaf,
        disk: `zvol/${zvol}`, iqn: ctx.config.iqnPrefix,
        golden_snapshot: goldenName,
      },
    });
    return { id: null, name, mac, zvol, target_name: leaf, golden_snapshot: goldenName, notes: null, dryRun: true };
  }

  const golden = await resolveDefaultGolden(ctx);
  // Resolve portal groups BEFORE any mutation: if no template target exists,
  // creation aborts here with nothing created and nothing to roll back.
  const targetGroups = await resolveTargetGroups(ctx);
  const created = [];
  try {
    await ctx.adapter.cloneSnapshot(golden.id, zvol);
    created.push({ type: 'dataset', ref: zvol });

    const extentId = await ctx.adapter.createExtent({ name: leaf, disk: `zvol/${zvol}` });
    created.push({ type: 'extent', ref: extentId });

    const targetId = await ctx.adapter.createTarget({ name: leaf, groups: targetGroups.groups });
    created.push({ type: 'target', ref: targetId });

    const targetExtentId = await ctx.adapter.createTargetExtent({ targetId, extentId, lunId: 0 });
    created.push({ type: 'targetExtent', ref: targetExtentId });

    const newId = insertClient(ctx.db, {
      name, mac, zvol, target_name: leaf, golden_snapshot: golden.name, notes: null,
    });
    logEvent(ctx.db, {
      action: 'client.create',
      clientId: newId,
      after: {
        name, mac, zvol, target_name: leaf, golden_snapshot: golden.name,
        target_groups_copied_from: targetGroups.copiedFrom,
      },
    });
    return getClient(ctx.db, newId);
  } catch (err) {
    await rollback(ctx, created);
    throw new Error(`Failed to create client "${name}" (rolled back): ${err.message}`);
  }
}

// Quarantine-clone before a destroy so there's a brief undo window. Snapshotting
// the zvol in place is useless here: the subsequent recursive deleteDataset would
// take the safety snapshot with it. Instead we snapshot then immediately clone
// that snapshot into an independent dataset under _safety/ that survives the
// client zvol's destruction, and record it in the DB for later cleanup (there is
// no prefix-enumeration on the adapter, so our own row is the only tracker).
// Best-effort: a failed safety net must never block the wipe the user asked for.
async function quarantineBeforeDestroy(ctx, client, clientId, reason) {
  if (ctx.config.dryRun) return;
  try {
    const snapId = await ctx.adapter.createSnapshot(client.zvol, `safety-${Date.now()}`);
    if (!snapId) throw new Error('createSnapshot returned no snapshot id');
    const quarantineZvol = `${ctx.config.clientZvolRoot}/_safety/${leafOf(client.zvol)}-${Date.now()}`;
    await ctx.adapter.cloneSnapshot(snapId, quarantineZvol);
    // Must promote before the caller destroys client.zvol: an unpromoted clone
    // is still dependent on client.zvol's snapshot and would either block or be
    // cascade-destroyed by the recursive delete that follows, defeating the
    // entire point of this quarantine step. See adapter.js's promoteDataset.
    await ctx.adapter.promoteDataset(quarantineZvol);
    insertSafetySnapshot(ctx.db, { clientId, zvol: quarantineZvol, reason });
  } catch (err) {
    logEvent(ctx.db, {
      action: 'client.safety_snapshot.failed', clientId, after: { error: err.message },
    });
  }
}

// Shared reset/rebase body. `rebaseTo` (when set) is the new golden snapshot to
// clone from and record; otherwise the client's currently assigned one is reused.
async function reclone(ctx, clientId, { force, rebaseTo }) {
  const isRebase = rebaseTo != null;
  const action = isRebase ? 'client.rebase' : 'client.reset';
  const before = getClient(ctx.db, clientId);
  assertSafeToDestroy(ctx, before);

  if (ctx.config.dryRun) {
    logEvent(ctx.db, {
      action: `${action}.dryrun`,
      clientId,
      before,
      after: { zvol: before.zvol, golden_snapshot: isRebase ? rebaseTo : before.golden_snapshot },
    });
    return before;
  }

  await assertNoActiveSession(ctx, before, force);
  const snapshotId = await resolveSnapshotId(ctx, isRebase ? rebaseTo : before.golden_snapshot);

  await quarantineBeforeDestroy(ctx, before, clientId, isRebase ? 'rebase' : 'reset');

  await ctx.adapter.deleteDataset(before.zvol, { recursive: true });
  await ctx.adapter.cloneSnapshot(snapshotId, before.zvol);

  updateClient(ctx.db, clientId, isRebase ? { golden_snapshot: rebaseTo } : {});
  const after = getClient(ctx.db, clientId);
  logEvent(ctx.db, { action, clientId, before, after });

  const wolEnabled = getSetting(ctx.db, 'wol_enabled', '0') === '1';
  if (wolEnabled && after.mac) {
    // The container typically runs on a bridge network, where a limited
    // broadcast (255.255.255.255) never leaves the bridge — the operator must
    // set wol_broadcast to the LAN's directed broadcast (e.g. 192.168.1.255)
    // for magic packets to reach the fleet. Read at send time so a Settings
    // change takes effect without a restart, like the other runtime tunables.
    const broadcastAddress = getSetting(ctx.db, 'wol_broadcast', '255.255.255.255');
    sendWakeOnLan(after.mac, { broadcastAddress }).catch((err) => {
      logEvent(ctx.db, { action: 'client.wol.failed', clientId, after: { error: err.message } });
    });
    logEvent(ctx.db, { action: 'client.wol.sent', clientId, after: { mac: after.mac, broadcast: broadcastAddress } });
  }
  return after;
}

async function resetClient(ctx, clientId, { force = false } = {}) {
  return reclone(ctx, clientId, { force, rebaseTo: null });
}

async function rebaseClient(ctx, clientId, { goldenSnapshot, force = false } = {}) {
  if (!goldenSnapshot) throw new Error('rebaseClient requires goldenSnapshot');
  return reclone(ctx, clientId, { force, rebaseTo: goldenSnapshot });
}

async function retireClient(ctx, clientId, { force = false } = {}) {
  const client = getClient(ctx.db, clientId);
  if (!client) throw new Error('Client not found');

  // Guardrail must run before the dryRun short-circuit (matching reclone's
  // order) so a dry-run faithfully surfaces a guardrail violation instead of
  // reporting success on an operation that will fail once armed.
  assertSafeToDestroy(ctx, client);

  if (ctx.config.dryRun) {
    logEvent(ctx.db, { action: 'client.retire.dryrun', clientId, before: client });
    return client;
  }

  // Same live-session guard as reset/rebase (and in the same position,
  // after the dryRun short-circuit): retiring deletes the target and zvol
  // out from under a running Windows machine, which is at least as
  // destructive as a reset and must demand the same explicit force.
  await assertNoActiveSession(ctx, client, force);

  const leaf = leafOf(client.zvol);

  const warn = (message) => logEvent(ctx.db, {
    action: 'client.retire.warning', clientId, after: { message },
  });

  const targetId = firstId(await ctx.adapter.queryTargets([['name', '=', client.target_name]]));
  if (targetId != null) {
    const teId = firstId(await ctx.adapter.queryTargetExtents([['target', '=', targetId]]));
    if (teId != null) await ctx.adapter.deleteTargetExtent(teId);
    else warn(`targetextent not found for target ${client.target_name}`);
    await ctx.adapter.deleteTarget(targetId);
  } else {
    warn(`target "${client.target_name}" not found; skipping target/targetextent`);
  }

  const extentId = firstId(await ctx.adapter.queryExtents([['name', '=', leaf]]));
  if (extentId != null) await ctx.adapter.deleteExtent(extentId);
  else warn(`extent "${leaf}" not found; skipping`);

  await quarantineBeforeDestroy(ctx, client, clientId, 'retire');

  await ctx.adapter.deleteDataset(client.zvol, { recursive: true, force: true });
  // Log BEFORE deleting the row: events.client_id has an enforced FK to
  // clients(id), so inserting this after the delete would be rejected.
  // deleteClient detaches (nulls) the reference; before_json keeps the full
  // client for the audit trail.
  logEvent(ctx.db, { action: 'client.retire', clientId, before: client });
  deleteClient(ctx.db, clientId);
  return client;
}

async function promoteGolden(ctx, { versionLabel } = {}) {
  if (!versionLabel) throw new Error('promoteGolden requires versionLabel');
  // Caller (route) is responsible for the final "gold-" prefixed name — this
  // function must not add its own prefix or names come out double-prefixed.
  const name = versionLabel;

  if (ctx.config.dryRun) {
    logEvent(ctx.db, {
      action: 'golden.promote.dryrun',
      after: { snapshot: name, dataset: ctx.config.goldenZvol },
    });
    return name;
  }

  await ctx.adapter.createSnapshot(ctx.config.goldenZvol, name);
  setSetting(ctx.db, 'golden_snapshot', name);
  logEvent(ctx.db, { action: 'golden.promote', after: { snapshot: name } });
  return name;
}

module.exports = { createClient, resetClient, rebaseClient, retireClient, promoteGolden };
