'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const db = require('../src/db');
const { ensureBootDirs } = require('../src/services/bootFiles');
const { generateDeployCmd, generateSafetyPs1 } = require('../src/services/deployScript');
const {
  armGoldenBuild, setGoldenBuildPhase, setChecklistStep, CHECKLIST,
} = require('../src/services/goldenBuild');
const { createBootRouter } = require('../src/routes/boot');

function makeCtx(settings = {}) {
  const bootfilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-deploy-'));
  const d = db.initDb(':memory:');
  for (const [k, v] of Object.entries(settings)) db.setSetting(d, k, v);
  return {
    db: d,
    adapter: { listSessions: async () => [] },
    config: {
      bootfilesDir,
      goldenZvol: 'Main_pool/iscsi/win-golden',
      truenasHost: '192.168.1.36',
      clientZvolRoot: 'Main_pool/iscsi',
      dryRun: false,
      tftpEnabled: false,
      tftpPort: 0,
    },
  };
}

function stage(ctx, rel, content = 'x') {
  const p = path.join(ctx.config.bootfilesDir, 'http', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

test('deploy.cmd for split media uses /SWMFile: and never blind-selects a disk', () => {
  const ctx = makeCtx();
  ensureBootDirs(ctx.config);
  stage(ctx, 'media/sources/install.swm');
  stage(ctx, 'media/sources/install2.swm');

  const cmd = generateDeployCmd({ ctx, baseUrl: 'http://192.168.1.36:8080', goldenSizeGib: 256 });
  // Split media: apply must go through /SWMFile: (Windows Setup silently
  // cannot install from .swm at all).
  assert.match(cmd, /\/SWMFile:M:\\media\\sources\\install\*\.swm/);
  assert.match(cmd, /\/ImageFile:M:\\media\\sources\\install\.swm/);
  // ScratchDir always on W:, never the WinPE RAM disk.
  assert.match(cmd, /\/ScratchDir:W:\\FD-Scratch/);
  // Destructive step: typed disk number + typed confirmation, no "select disk 0".
  assert.match(cmd, /set \/p FD_DISK=/);
  assert.match(cmd, /set \/p FD_CONFIRM=Type the SAME number again/);
  assert.doesNotMatch(cmd, /select disk 0\b/);
  assert.match(cmd, /~256 GiB/); // size-match hint for the picker
  // bcdboot + offline registry fixes for the iSCSI stack and NIC drivers.
  assert.match(cmd, /bcdboot W:\\Windows \/s S: \/f UEFI/);
  assert.match(cmd, /reg load HKLM\\FDSYS W:\\Windows\\System32\\config\\SYSTEM/);
  assert.match(cmd, /for %%S in \(MSiSCSI iScsiPrt rt640x64 e1d e2f e1i65x64\)/);
  assert.match(cmd, /WARNING: service %%S not present/); // warn, don't create
  // Safety script install + RunOnce (not offline TaskCache) rationale present.
  assert.match(cmd, /RunOnce/);
  assert.match(cmd, /schtasks \/Create \/TN FleetDeckDiskOffline/);
  // NEXT STEPS point at the phase switch.
  assert.match(cmd, /switch the session phase/i);
  // cmd.exe needs CRLF.
  assert.ok(cmd.includes('\r\n'));
});

test('deploy.cmd for single install.wim has no /SWMFile: and honors preselected index', () => {
  const ctx = makeCtx({ golden_image_index: '3', nic_boot_services: 'e1d' });
  ensureBootDirs(ctx.config);
  stage(ctx, 'media/sources/install.wim');

  const cmd = generateDeployCmd({ ctx, baseUrl: 'http://x' });
  assert.doesNotMatch(cmd, /\/SWMFile:/);
  assert.match(cmd, /\/ImageFile:M:\\media\\sources\\install\.wim/);
  assert.match(cmd, /set FD_INDEX=3/);           // baked index
  assert.doesNotMatch(cmd, /set \/p FD_INDEX=/); // no prompt when baked
  assert.match(cmd, /for %%S in \(MSiSCSI iScsiPrt e1d\)/); // setting-driven NIC list
});

test('safety.ps1 offlines local non-boot disks only', () => {
  const ps1 = generateSafetyPs1();
  assert.match(ps1, /-not \$_\.IsBoot/);
  assert.match(ps1, /BusType -ne 'iSCSI'/);
  assert.match(ps1, /Set-Disk -Number \$_\.Number -IsOffline \$true/);
});

test('phase switching changes the served boot script', async () => {
  const ctx = makeCtx({ winpe_chain_url: 'http://fd/boot/files/winpe.ipxe' });
  ensureBootDirs(ctx.config);
  await armGoldenBuild(ctx, { mac: 'aa:bb:cc:dd:ee:20', durationMinutes: 60 });

  const app = express();
  app.use(express.json());
  app.use(createBootRouter(ctx));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    // install phase: sanhook + chain WinPE.
    let script = await (await fetch(`${base}/boot/aa-bb-cc-dd-ee-20.ipxe`)).text();
    assert.match(script, /sanhook --drive 0x80 iscsi:192\.168\.1\.36::::iqn\.2005-10\.org\.freenas\.ctl:win-golden/);
    assert.match(script, /chain http:\/\/fd\/boot\/files\/winpe\.ipxe/);

    // boot_installed phase: plain sanboot of the golden target, no WinPE.
    const session = setGoldenBuildPhase(ctx, 'boot_installed');
    assert.equal(session.phase, 'boot_installed');
    script = await (await fetch(`${base}/boot/aa-bb-cc-dd-ee-20.ipxe`)).text();
    assert.match(script, /sanboot iscsi:192\.168\.1\.36::::iqn\.2005-10\.org\.freenas\.ctl:win-golden/);
    assert.doesNotMatch(script, /sanhook|chain|winpe/);

    // Switching is idempotent; unknown phases are rejected.
    assert.equal(setGoldenBuildPhase(ctx, 'boot_installed').phase, 'boot_installed');
    assert.throws(() => setGoldenBuildPhase(ctx, 'nonsense'), /Unknown golden build phase/);

    // Audit trail records the transition.
    assert.ok(db.listEvents(ctx.db, { limit: 20 }).some((e) => e.action === 'golden_build.phase_changed'));
  } finally {
    server.close();
  }
});

test('checklist steps persist on the session row', async () => {
  const ctx = makeCtx({ winpe_chain_url: 'http://x' });
  ensureBootDirs(ctx.config);
  await armGoldenBuild(ctx, { mac: 'aa:bb:cc:dd:ee:21', durationMinutes: 60 });

  assert.ok(CHECKLIST.length >= 8);
  setChecklistStep(ctx, 'run_deploy', true);
  const updated = setChecklistStep(ctx, 'sysprep', true);
  assert.deepEqual(JSON.parse(updated.checklist_json), { run_deploy: true, sysprep: true });

  const row = db.getActiveGoldenBuildSession(ctx.db);
  assert.deepEqual(JSON.parse(row.checklist_json), { run_deploy: true, sysprep: true });

  // Untick persists too; unknown steps rejected.
  setChecklistStep(ctx, 'run_deploy', false);
  assert.equal(JSON.parse(db.getActiveGoldenBuildSession(ctx.db).checklist_json).run_deploy, false);
  assert.throws(() => setChecklistStep(ctx, 'bogus', true), /Unknown checklist step/);
});
