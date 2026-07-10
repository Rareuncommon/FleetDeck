'use strict';

const { logEvent } = require('../db');
const { goldenTargetName } = require('./ipxeTemplate');
const { bootFilesStatus, bootActivity } = require('./bootFiles');

// First-run setup wizard: every step is check()able (drives both the wizard
// UI and the diagnostics panel) and — for the RPC-able ones — apply()able.
// Contract for every mutating step, mirroring clientOps.js:
//   * idempotent: if the thing exists, apply() reports it and creates nothing
//   * capability-honest: if this TrueNAS build lacks the method, the step
//     says "do this in the TrueNAS UI" with exact instructions — no button
//     that errors
//   * DRY_RUN: apply() returns the exact would-be RPC payload(s), executes
//     nothing, and logs a .dryrun event
//   * every real mutation logs its own setup.<step>.applied event

const GIB = 1024 * 1024 * 1024;
const DEFAULT_GOLDEN_SIZE_GIB = 256;

function detail(ok, text, extra = {}) {
  return { ok, detail: text, ...extra };
}

function unsupported(instructions) {
  return { ok: false, supported: false, detail: instructions };
}

// ---- individual step checks (each returns { ok, detail, ... }) -------------

async function checkDatasets(ctx) {
  const root = ctx.config.clientZvolRoot;
  const safety = `${root}/_safety`;
  const [rootDs, safetyDs] = [await ctx.adapter.queryDataset(root), await ctx.adapter.queryDataset(safety)];
  const missing = [];
  if (!rootDs) missing.push(root);
  if (!safetyDs) missing.push(safety);
  return missing.length === 0
    ? detail(true, `${root} and ${safety} exist`)
    : detail(false, `missing: ${missing.join(', ')}`, { missing });
}

async function checkGoldenZvol(ctx) {
  const ds = await ctx.adapter.queryDataset(ctx.config.goldenZvol);
  if (!ds) return detail(false, `${ctx.config.goldenZvol} does not exist`);
  const volsize = ds.volsize && (ds.volsize.parsed != null ? ds.volsize.parsed : ds.volsize);
  const size = typeof volsize === 'number' ? `${Math.round(volsize / GIB)} GiB` : 'unknown size';
  return detail(true, `${ctx.config.goldenZvol} exists (${size})`);
}

async function checkIscsiService(ctx) {
  if (!ctx.adapter.supports('serviceQuery')) {
    return unsupported('This TrueNAS build does not expose service.query — check System Settings > Services > iSCSI in the TrueNAS UI (enable + start it).');
  }
  const rows = await ctx.adapter.queryServices([['service', '=', 'iscsitarget']]);
  const svc = Array.isArray(rows) ? rows[0] : null;
  if (!svc) return detail(false, 'iscsitarget service not found via service.query');
  const running = svc.state === 'RUNNING';
  const enabled = !!svc.enable;
  return detail(running && enabled,
    `iSCSI service: ${svc.state || 'unknown'}${enabled ? ', starts on boot' : ', NOT enabled on boot'}`,
    { running, enabled });
}

async function checkPortal(ctx) {
  if (!ctx.adapter.supports('portalQuery')) {
    return unsupported('This TrueNAS build does not expose iscsi.portal.* — create a portal (0.0.0.0, port 3260) under Shares > iSCSI > Portals in the TrueNAS UI.');
  }
  const portals = await ctx.adapter.queryPortals([]);
  if (!Array.isArray(portals) || portals.length === 0) return detail(false, 'no iSCSI portal exists');
  const first = portals[0];
  const listen = (first.listen || []).map((l) => l.ip).join(', ');
  return detail(true, `portal #${first.id} listening on ${listen || 'unknown'}`, { portalId: first.id });
}

async function checkInitiator(ctx) {
  if (!ctx.adapter.supports('initiatorQuery')) {
    return unsupported('This TrueNAS build does not expose iscsi.initiator.* — create an allow-all initiator group under Shares > iSCSI > Initiators Groups in the TrueNAS UI.');
  }
  const groups = await ctx.adapter.queryInitiators([]);
  if (!Array.isArray(groups) || groups.length === 0) return detail(false, 'no initiator group exists');
  // Prefer an allow-all group (empty initiators list) but accept any.
  const allowAll = groups.find((g) => !g.initiators || g.initiators.length === 0);
  const chosen = allowAll || groups[0];
  return detail(true,
    `initiator group #${chosen.id}${allowAll ? ' (allow-all)' : ' (restricted list)'}`,
    { initiatorId: chosen.id });
}

async function checkGoldenTarget(ctx) {
  const name = goldenTargetName(ctx.config.goldenZvol);
  const rows = await ctx.adapter.queryTargets([['name', '=', name]]);
  const target = Array.isArray(rows) ? rows[0] : null;
  if (!target) return detail(false, `target "${name}" does not exist`);
  const groups = Array.isArray(target.groups) ? target.groups : [];
  if (groups.length === 0) {
    // The exact misconfiguration from the real bring-up: a target with no
    // portal groups exists but is unreachable by every initiator.
    return detail(false, `target "${name}" exists but has NO portal groups — it is invisible to initiators`, { targetId: target.id, ungrouped: true });
  }
  return detail(true, `target "${name}" exists with ${groups.length} portal group(s)`, { targetId: target.id });
}

async function checkGoldenExtent(ctx) {
  const name = goldenTargetName(ctx.config.goldenZvol);
  const rows = await ctx.adapter.queryExtents([['name', '=', name]]);
  const extent = Array.isArray(rows) ? rows[0] : null;
  return extent
    ? detail(true, `extent "${name}" exists (id ${extent.id})`, { extentId: extent.id })
    : detail(false, `extent "${name}" does not exist`);
}

async function checkGoldenTargetExtent(ctx) {
  const t = await checkGoldenTarget(ctx);
  const e = await checkGoldenExtent(ctx);
  if (!t.targetId || !e.extentId) {
    return detail(false, 'needs the target and extent steps first');
  }
  const rows = await ctx.adapter.queryTargetExtents([['target', '=', t.targetId]]);
  const te = (Array.isArray(rows) ? rows : []).find((r) => r.extent === e.extentId);
  return te
    ? detail(true, `target ↔ extent mapping exists (LUN ${te.lunid})`)
    : detail(false, 'target and extent exist but are not mapped', { targetId: t.targetId, extentId: e.extentId });
}

function checkDhcp(ctx) {
  const act = bootActivity(ctx.db);
  const seen = !!(act.tftp.first || act.http.first);
  return detail(seen,
    seen
      ? `boot traffic confirmed (tftp: ${act.tftp.first || 'never'}, http: ${act.http.first || 'never'})`
      : 'no boot request seen yet — configure DHCP network boot and PXE-boot any machine',
    { manual: true, activity: act });
}

function checkSnponly(ctx) {
  const status = bootFilesStatus(ctx.config);
  return status.tftp.snponly.present
    ? detail(true, `snponly.efi staged (${status.tftp.snponly.size} bytes)`, { manual: true })
    : detail(false, 'snponly.efi not staged in the TFTP directory yet', { manual: true });
}

// ---- step registry ----------------------------------------------------------

// kind 'rpc' steps have an apply(); 'manual' steps are checklist-only (the
// honest boundary: FleetDeck detects completion, it doesn't pretend to do
// the work).
const STEPS = [
  { id: 'datasets', title: 'Client + safety datasets', kind: 'rpc', check: checkDatasets },
  { id: 'golden_zvol', title: 'Golden zvol', kind: 'rpc', check: checkGoldenZvol },
  { id: 'iscsi_service', title: 'iSCSI service enabled + running', kind: 'rpc', check: checkIscsiService },
  { id: 'portal', title: 'iSCSI portal (0.0.0.0:3260)', kind: 'rpc', check: checkPortal },
  { id: 'initiator', title: 'Allow-all initiator group', kind: 'rpc', check: checkInitiator },
  { id: 'target', title: 'Golden target with portal groups', kind: 'rpc', check: checkGoldenTarget },
  { id: 'extent', title: 'Golden device extent', kind: 'rpc', check: checkGoldenExtent },
  { id: 'targetextent', title: 'Target ↔ extent mapping (LUN 0)', kind: 'rpc', check: checkGoldenTargetExtent },
  { id: 'dhcp', title: 'DHCP network boot (router/UniFi)', kind: 'manual', check: checkDhcp },
  { id: 'snponly', title: 'snponly.efi staged for TFTP', kind: 'manual', check: checkSnponly },
];

async function wizardStatus(ctx) {
  const steps = [];
  for (const step of STEPS) {
    let state;
    try {
      if (step.kind !== 'manual' && !ctx.adapter) {
        state = detail(false, 'TrueNAS adapter unavailable — reconnect first');
      } else {
        state = await step.check(ctx);
      }
    } catch (err) {
      state = detail(false, `check failed: ${err.message}`);
    }
    steps.push({
      id: step.id,
      title: step.title,
      kind: step.kind,
      supported: state.supported !== false,
      ...state,
    });
  }
  return steps;
}

// ---- apply ------------------------------------------------------------------

// Executes (or dry-run-plans) one step. Returns:
//   { already: true, detail }                      nothing to do
//   { dryRun: true, payloads: [{method, params}] } DRY_RUN plan, nothing ran
//   { applied: true, payloads, detail }            executed
//   { supported: false, detail }                   TrueNAS build can't
async function applyStep(ctx, stepId, opts = {}) {
  const step = STEPS.find((s) => s.id === stepId);
  if (!step) throw new Error(`Unknown setup step "${stepId}"`);
  if (step.kind === 'manual') throw new Error(`Step "${stepId}" is a manual checklist step; there is nothing FleetDeck can execute for it`);
  if (!ctx.adapter) throw new Error('TrueNAS adapter unavailable');

  const current = await step.check(ctx);
  if (current.supported === false) return { supported: false, detail: current.detail };
  if (current.ok) return { already: true, detail: current.detail };

  // Build the plan: the exact RPCs this step would run, in order. The plan is
  // what dry-run shows and what the confirm modal displays before arming.
  const plan = [];
  const name = goldenTargetName(ctx.config.goldenZvol);

  if (stepId === 'datasets') {
    for (const missing of current.missing || []) {
      plan.push({ method: 'createDataset', params: { name: missing, type: 'FILESYSTEM' } });
    }
  } else if (stepId === 'golden_zvol') {
    const sizeGib = Number(opts.sizeGib) > 0 ? Number(opts.sizeGib) : DEFAULT_GOLDEN_SIZE_GIB;
    plan.push({
      method: 'createDataset',
      // sparse + 64K volblocksize per the proven manual bring-up settings.
      params: { name: ctx.config.goldenZvol, type: 'VOLUME', volsize: sizeGib * GIB, sparse: true, volblocksize: '64K' },
    });
  } else if (stepId === 'iscsi_service') {
    if (!ctx.adapter.supports('serviceUpdate') || !ctx.adapter.supports('serviceStart')) {
      return { supported: false, detail: 'service.update/service.control not exposed — enable + start iSCSI under System Settings > Services in the TrueNAS UI.' };
    }
    if (!current.enabled) plan.push({ method: 'setServiceEnabled', params: ['iscsitarget', true] });
    if (!current.running) plan.push({ method: 'startService', params: ['iscsitarget'] });
  } else if (stepId === 'portal') {
    if (!ctx.adapter.supports('portalCreate')) return { supported: false, detail: 'iscsi.portal.create not exposed — create the portal in the TrueNAS UI (Shares > iSCSI > Portals, IP 0.0.0.0).' };
    plan.push({ method: 'createPortal', params: { listen: [{ ip: '0.0.0.0' }], comment: 'FleetDeck (all interfaces, port 3260)' } });
  } else if (stepId === 'initiator') {
    if (!ctx.adapter.supports('initiatorCreate')) return { supported: false, detail: 'iscsi.initiator.create not exposed — create an allow-all initiators group in the TrueNAS UI.' };
    plan.push({ method: 'createInitiator', params: { initiators: [], comment: 'FleetDeck allow-all' } });
  } else if (stepId === 'target') {
    // Needs portal + initiator ids — the wizard's target is the template
    // resolveTargetGroups copies for every future client, so it gets a real
    // portal group from the start (an ungrouped target is unreachable).
    const portal = await checkPortal(ctx);
    const initiator = await checkInitiator(ctx);
    if (!portal.portalId || !initiator.initiatorId) {
      throw new Error('Create the portal and initiator group steps first — the target needs their ids for its portal group.');
    }
    plan.push({
      method: 'createTarget',
      params: {
        name,
        groups: [{ portal: portal.portalId, initiator: initiator.initiatorId, authmethod: 'NONE', auth: null, auth_networks: [] }],
      },
    });
  } else if (stepId === 'extent') {
    plan.push({ method: 'createExtent', params: { name, disk: `zvol/${ctx.config.goldenZvol}` } });
  } else if (stepId === 'targetextent') {
    if (!current.targetId || !current.extentId) {
      throw new Error('Create the target and extent steps first — the mapping needs both ids.');
    }
    plan.push({ method: 'createTargetExtent', params: { targetId: current.targetId, extentId: current.extentId, lunId: 0 } });
  }

  if (plan.length === 0) return { already: true, detail: current.detail };

  // planOnly: the UI's confirm modal shows the exact RPCs before anything
  // runs — "what will be created", not a vague description.
  if (opts.planOnly) return { plan };

  if (ctx.config.dryRun) {
    logEvent(ctx.db, { action: `setup.${stepId}.dryrun`, after: { plan } });
    return { dryRun: true, payloads: plan };
  }

  // Sequential, matching the repo-wide rule for TrueNAS mutations.
  for (const rpc of plan) {
    if (Array.isArray(rpc.params)) await ctx.adapter[rpc.method](...rpc.params);
    else await ctx.adapter[rpc.method](rpc.params);
  }
  logEvent(ctx.db, { action: `setup.${stepId}.applied`, after: { plan } });
  const after = await step.check(ctx);
  return { applied: true, payloads: plan, detail: after.detail };
}

// ---- diagnostics ------------------------------------------------------------

// Re-runnable health panel: the wizard's checks plus live self-tests that
// prove serving actually works (fetch our own HTTP, read our own TFTP) —
// each of these corresponds to a failure mode from the real bring-up.
async function runDiagnostics(ctx, { tftpFetch = null } = {}) {
  const out = [];
  const add = (id, ok, text, warn = false) => out.push({ id, ok, warn, detail: text });

  // TrueNAS connection + session-reporting granularity.
  if (!ctx.adapter) {
    add('truenas', false, 'TrueNAS adapter unavailable (reconnecting in background)');
  } else {
    add('truenas', true, 'TrueNAS connected, RPC methods resolved');
    if (ctx.adapter.sessionsGranular === false) {
      add('sessions', true, 'session reporting is count-only on this build — client status shows "unknown"', true);
    }
  }

  // Golden zvol + target groups (the "target exists but is unreachable" trap).
  if (ctx.adapter) {
    try {
      const z = await checkGoldenZvol(ctx);
      add('golden_zvol', z.ok, z.detail);
      const t = await checkGoldenTarget(ctx);
      add('golden_target', t.ok, t.detail);
    } catch (err) {
      add('golden_zvol', false, `check failed: ${err.message}`);
    }
  }

  // Boot files on disk.
  const files = bootFilesStatus(ctx.config);
  add('snponly', files.tftp.snponly.present, files.tftp.snponly.present ? 'snponly.efi staged' : 'snponly.efi missing from TFTP dir');
  add('wimboot', files.http.wimboot.present, files.http.wimboot.present ? 'wimboot staged' : 'wimboot missing (Setup tab has a one-click download)');
  const media = files.http.bcd.present && files.http.bootSdi.present && files.http.bootWim.present;
  add('winpe_media', media, media ? 'WinPE media staged (BCD, boot.sdi, boot.wim)' : 'WinPE media incomplete — copy the ISO contents into media/');
  if (files.install.kind === 'swm') {
    add('install_media', true, `split .swm install media (${files.install.swmParts} parts) — deploy script will use /SWMFile:`, true);
  } else if (files.install.kind) {
    add('install_media', true, `single install.${files.install.kind} staged`);
  } else {
    add('install_media', false, 'no install image staged (media/sources/install.wim|esd|swm)');
  }

  // HTTP self-fetch: FleetDeck requesting its own boot asset the way wimboot
  // would (ranged). Proves serving end-to-end, not just fs.stat.
  if (files.http.wimboot.present) {
    try {
      const bindHost = ctx.config.httpBind === '0.0.0.0' ? '127.0.0.1' : ctx.config.httpBind;
      const res = await fetch(`http://${bindHost}:${ctx.config.httpPort}/boot/files/wimboot`, {
        headers: { Range: 'bytes=0-0' },
      });
      add('http_self', res.status === 206 || res.status === 200,
        `self-fetch of /boot/files/wimboot returned ${res.status}${res.status === 206 ? ' (ranged, as wimboot requests)' : ''}`);
    } catch (err) {
      add('http_self', false, `self-fetch failed: ${err.message}`);
    }
  }

  // TFTP self-test read (only when the in-process server is up).
  if (ctx.tftp && files.tftp.snponly.present && tftpFetch) {
    try {
      const data = await tftpFetch({ port: ctx.tftp.port, filename: 'snponly.efi' });
      add('tftp_self', data.length === files.tftp.snponly.size,
        `TFTP self-test read snponly.efi (${data.length} bytes)`);
    } catch (err) {
      add('tftp_self', false, `TFTP self-test failed: ${err.message}`);
    }
  } else if (ctx.config.tftpEnabled && !ctx.tftp) {
    add('tftp_self', false, 'TFTP enabled but not running (bind failed at startup?)');
  }

  return out;
}

module.exports = { wizardStatus, applyStep, runDiagnostics, STEPS, DEFAULT_GOLDEN_SIZE_GIB, GIB };
