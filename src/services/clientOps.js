'use strict';

const {
  getClient, getClientByMac, listClients, insertClient, updateClient, deleteClient,
  getSetting, setSetting, logEvent,
} = require('../db');

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
  return match ? match.id : nameOrId;
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
  const created = [];
  try {
    await ctx.adapter.cloneSnapshot(golden.id, zvol);
    created.push({ type: 'dataset', ref: zvol });

    const extentId = await ctx.adapter.createExtent({ name: leaf, disk: `zvol/${zvol}` });
    created.push({ type: 'extent', ref: extentId });

    const targetId = await ctx.adapter.createTarget({ name: leaf, iqn: ctx.config.iqnPrefix });
    created.push({ type: 'target', ref: targetId });

    const targetExtentId = await ctx.adapter.createTargetExtent({ targetId, extentId, lunId: 0 });
    created.push({ type: 'targetExtent', ref: targetExtentId });

    const newId = insertClient(ctx.db, {
      name, mac, zvol, target_name: leaf, golden_snapshot: golden.name, notes: null,
    });
    logEvent(ctx.db, {
      action: 'client.create',
      clientId: newId,
      after: { name, mac, zvol, target_name: leaf, golden_snapshot: golden.name },
    });
    return getClient(ctx.db, newId);
  } catch (err) {
    await rollback(ctx, created);
    throw new Error(`Failed to create client "${name}" (rolled back): ${err.message}`);
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

  await ctx.adapter.deleteDataset(before.zvol, { recursive: true });
  await ctx.adapter.cloneSnapshot(snapshotId, before.zvol);

  updateClient(ctx.db, clientId, isRebase ? { golden_snapshot: rebaseTo } : {});
  const after = getClient(ctx.db, clientId);
  logEvent(ctx.db, { action, clientId, before, after });
  return after;
}

async function resetClient(ctx, clientId, { force = false } = {}) {
  return reclone(ctx, clientId, { force, rebaseTo: null });
}

async function rebaseClient(ctx, clientId, { goldenSnapshot, force = false } = {}) {
  if (!goldenSnapshot) throw new Error('rebaseClient requires goldenSnapshot');
  return reclone(ctx, clientId, { force, rebaseTo: goldenSnapshot });
}

async function retireClient(ctx, clientId) {
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

  await ctx.adapter.deleteDataset(client.zvol, { recursive: true, force: true });
  deleteClient(ctx.db, clientId);
  logEvent(ctx.db, { action: 'client.retire', clientId, before: client });
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
