'use strict';

const fs = require('fs');
const path = require('path');

const { getSetting } = require('../db');
const { bootDirs, detectInstallMedia } = require('./bootFiles');

// Generates the WinPE-side automation for the golden install. Everything the
// real bring-up required hand-typing (from photos of chat messages, with
// typo-induced failures) is collapsed into one generated .cmd:
//   diskpart (with typed disk confirmation) → dism apply (swm-aware) →
//   bcdboot → offline-registry boot-start fixes → safety-script install.
// Generated scripts are code: they carry their own comments, and the one
// destructive step (diskpart clean) requires the operator to type the disk
// number twice — never a blind "select disk 0", because mixed local+iSCSI
// disks are the normal case and a wrong clean destroys someone's drive.

const GIB = 1024 * 1024 * 1024;

// Default NIC boot-start service names (drivers whose Start must be 0 for
// iSCSI boot): Realtek, Intel 1G (two generations), Intel i219. Extendable
// via the nic_boot_services setting without touching code.
const DEFAULT_NIC_SERVICES = 'rt640x64,e1d,e2f,e1i65x64';

function nicServices(db) {
  const raw = getSetting(db, 'nic_boot_services', DEFAULT_NIC_SERVICES);
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

// The local-disk-offline safety script baked into the golden image. Runs as
// SYSTEM at boot: any disk that is not the iSCSI boot disk goes offline, so
// a walk-up guest session can never scribble on the machine's own drive.
function generateSafetyPs1() {
  return [
    '# FleetDeck disk-offline safety script (GENERATED - do not hand-edit).',
    '# Runs at startup as SYSTEM: takes every local (non-boot, non-iSCSI)',
    '# disk offline so nothing in the guest session can write to the',
    "# machine's own drive. Re-run at every boot because Windows re-onlines",
    '# disks it considers healthy.',
    "Get-Disk | Where-Object { -not $_.IsBoot -and $_.BusType -ne 'iSCSI' } | ForEach-Object {",
    '  try {',
    '    Set-Disk -Number $_.Number -IsOffline $true -ErrorAction Stop',
    "    Write-Output (\"FleetDeck: disk {0} ({1}) set offline\" -f $_.Number, $_.FriendlyName)",
    '  } catch {',
    "    Write-Output (\"FleetDeck: could not offline disk {0}: {1}\" -f $_.Number, $_.Exception.Message)",
    '  }',
    '}',
  ].join('\r\n') + '\r\n';
}

// baseUrl: how the booting machine reached us (from the request Host header).
// goldenSizeGib: display hint for the disk picker (null when unknown).
function generateDeployCmd({ ctx, baseUrl, goldenSizeGib = null }) {
  const dirs = bootDirs(ctx.config);
  const media = detectInstallMedia(dirs.http);
  const truenasHost = ctx.config.truenasHost || '<truenas-host>';
  const shareName = getSetting(ctx.db, 'bootfiles_smb_share_name', 'fleetdeck-bootfiles');
  const preIndex = getSetting(ctx.db, 'golden_image_index', '');
  const nics = nicServices(ctx.db);
  const sizeHint = goldenSizeGib ? `~${goldenSizeGib} GiB` : 'the size of your golden zvol';

  // Media paths as WinPE will see them on the mapped SMB drive. Real on-disk
  // names (case included) — same discipline as winpe.ipxe generation.
  const first = media.files && media.files[0] ? media.files[0] : 'media/sources/install.wim';
  const rel = first.split('/');
  const fileName = rel.pop();
  const dirWin = rel.join('\\');
  const imgPath = `M:\\${dirWin}\\${fileName}`;
  const swmPattern = `M:\\${dirWin}\\${fileName.replace(/\.swm$/i, '')}*.swm`;

  const applyLine = media.kind === 'swm'
    // Windows Setup CANNOT install from split .swm (silent exit, no error) —
    // dism with /SWMFile: is the only working path for split media.
    ? `dism /Apply-Image /ImageFile:${imgPath} /SWMFile:${swmPattern} /Index:!FD_INDEX! /ApplyDir:W:\\ /ScratchDir:W:\\FD-Scratch`
    : `dism /Apply-Image /ImageFile:${imgPath} /Index:!FD_INDEX! /ApplyDir:W:\\ /ScratchDir:W:\\FD-Scratch`;

  const lines = [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    'rem ================================================================',
    'rem  FleetDeck golden-image deploy script (GENERATED - do not edit).',
    `rem  Media: ${media.kind === 'swm' ? `split .swm (${media.swmParts} parts) -> dism /SWMFile:` : `single install.${media.kind || 'wim'}`}`,
    `rem  Fetched from ${baseUrl}/boot/files/deploy.cmd`,
    'rem ================================================================',
    '',
    'echo.',
    'echo === STEP 1/6: choose the target disk ===',
    'echo list disk > X:\\fd-list.txt',
    'diskpart /s X:\\fd-list.txt',
    'echo.',
    `echo The golden iSCSI disk should be ${sizeHint}. Pick by SIZE.`,
    'echo WARNING: choosing a local drive DESTROYS it. Mixed local + iSCSI',
    'echo disks are the normal case here - read the list carefully.',
    'set /p FD_DISK=Disk number of the golden iSCSI disk: ',
    'set /p FD_CONFIRM=Type the SAME number again to confirm CLEANING disk !FD_DISK!: ',
    'if not "!FD_DISK!"=="!FD_CONFIRM!" (',
    '  echo Numbers did not match - aborting with nothing touched.',
    '  exit /b 1',
    ')',
    '',
    'rem GPT layout: 300MB ESP (S:) + MSR + NTFS primary (W:)',
    '> X:\\fd-part.txt (',
    '  echo select disk !FD_DISK!',
    '  echo clean',
    '  echo convert gpt',
    '  echo create partition efi size=300',
    '  echo format quick fs=fat32 label=System',
    '  echo assign letter=S',
    '  echo create partition msr size=16',
    '  echo create partition primary',
    '  echo format quick fs=ntfs label=Windows',
    '  echo assign letter=W',
    ')',
    'diskpart /s X:\\fd-part.txt || (echo diskpart FAILED & exit /b 1)',
    '',
    'echo === STEP 2/6: mount the install media (FleetDeck SMB share) ===',
    `net use M: \\\\${truenasHost}\\${shareName} || (`,
    '  echo Could not map the media share. Check the share exists (FleetDeck',
    '  echo Setup tab) and credentials, then re-run this script.',
    '  exit /b 1',
    ')',
    '',
    'echo === STEP 3/6: apply the Windows image ===',
    `dism /Get-WimInfo /WimFile:${imgPath}`,
    ...(preIndex
      ? [
        `set FD_INDEX=${preIndex}`,
        `echo Using image index ${preIndex} (preselected in FleetDeck settings: golden_image_index).`,
      ]
      : [
        'set /p FD_INDEX=Image index to apply (see list above): ',
      ]),
    'rem ScratchDir on W: always - the WinPE RAM-disk scratch space caused',
    'rem real DISM failures on this exact workflow.',
    'mkdir W:\\FD-Scratch',
    `${applyLine} || (echo DISM apply FAILED & exit /b 1)`,
    '',
    'echo === STEP 4/6: write UEFI boot files ===',
    'bcdboot W:\\Windows /s S: /f UEFI || (echo bcdboot FAILED & exit /b 1)',
    '',
    'echo === STEP 5/6: boot-start registry fixes (offline SYSTEM hive) ===',
    'rem Without Start=0 on the iSCSI stack and the NIC driver, first boot',
    'rem from the iSCSI disk dies with INACCESSIBLE_BOOT_DEVICE - these are',
    'rem the offline edits the real bring-up had to discover the hard way.',
    'reg load HKLM\\FDSYS W:\\Windows\\System32\\config\\SYSTEM || (echo SYSTEM hive load FAILED & exit /b 1)',
    `for %%S in (MSiSCSI iScsiPrt ${nics.join(' ')}) do (`,
    '  reg query HKLM\\FDSYS\\ControlSet001\\Services\\%%S >nul 2>&1 && (',
    '    reg add HKLM\\FDSYS\\ControlSet001\\Services\\%%S /v Start /t REG_DWORD /d 0 /f >nul',
    '    echo   Start=0 set on %%S',
    '  ) || (',
    '    echo   WARNING: service %%S not present in this image - skipped',
    '  )',
    ')',
    'reg unload HKLM\\FDSYS',
    '',
    'echo === STEP 6/6: install the disk-offline safety script ===',
    'mkdir W:\\FleetDeck',
    'copy M:\\fleetdeck-safety.ps1 W:\\FleetDeck\\disk-offline.ps1 || (',
    `  powershell -NoProfile -c "iwr ${baseUrl}/boot/files/fleetdeck-safety.ps1 -OutFile W:\\FleetDeck\\disk-offline.ps1"`,
    ')',
    'rem Task registration happens via RunOnce+schtasks on first boot, NOT by',
    'rem writing the task offline: offline registration means hand-crafting',
    'rem Schedule\\TaskCache registry blobs, which is undocumented and breaks',
    'rem across Windows builds. RunOnce runs elevated at first logon (during',
    'rem OOBE completion), registers the real SYSTEM startup task once, and',
    'rem removes itself - deterministic on every build.',
    'reg load HKLM\\FDSOFT W:\\Windows\\System32\\config\\SOFTWARE || (echo SOFTWARE hive load FAILED & exit /b 1)',
    'reg add "HKLM\\FDSOFT\\Microsoft\\Windows\\CurrentVersion\\RunOnce" /v FleetDeckSafetyTask /t REG_SZ /d "schtasks /Create /TN FleetDeckDiskOffline /SC ONSTART /RU SYSTEM /TR \\"powershell -NoProfile -ExecutionPolicy Bypass -File C:\\FleetDeck\\disk-offline.ps1\\" /F" /f',
    'reg unload HKLM\\FDSOFT',
    '',
    'echo ==================== NEXT STEPS ====================',
    'echo 1. In FleetDeck, Golden tab: switch the session phase to',
    'echo    boot_installed (so the next PXE boot sanboots the new OS).',
    'echo 2. Reboot this machine:  wpeutil reboot',
    'echo =====================================================',
  ];
  // CRLF: this runs under cmd.exe, which mis-parses bare-LF multi-line blocks.
  return lines.join('\r\n') + '\r\n';
}

// Write current generated scripts into the HTTP dir so the SMB share (which
// exposes that dir) carries fresh copies — WinPE's guaranteed transport is
// `net use`, and the share serves static files, not our generated routes.
function writeGeneratedScripts(ctx, baseUrl, goldenSizeGib = null) {
  const dirs = bootDirs(ctx.config);
  fs.writeFileSync(path.join(dirs.http, 'deploy.cmd'), generateDeployCmd({ ctx, baseUrl, goldenSizeGib }));
  fs.writeFileSync(path.join(dirs.http, 'fleetdeck-safety.ps1'), generateSafetyPs1());
}

module.exports = { generateDeployCmd, generateSafetyPs1, writeGeneratedScripts, DEFAULT_NIC_SERVICES, GIB };
