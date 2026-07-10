'use strict';

const fs = require('fs');
const path = require('path');

const { getSetting, setSetting, logEvent } = require('../db');

// On-disk layout under config.bootfilesDir:
//   http/            served (unauthenticated, like /boot/*) at /boot/files/
//     wimboot        the ipxe wimboot binary
//     media/         contents of the Windows ISO (Boot/, sources/, ...)
//   tftp/
//     snponly.efi    what the DHCP boot-filename points at
//
// One process (this one) writes and serves these files, which is the entire
// fix for the recurring 403 class of bugs: the old separate nginx container
// kept serving 403s because files copied in from elsewhere lacked o+r.
function bootDirs(config) {
  const root = config.bootfilesDir;
  return {
    root,
    http: path.join(root, 'http'),
    media: path.join(root, 'http', 'media'),
    tftp: path.join(root, 'tftp'),
  };
}

function ensureBootDirs(config) {
  const dirs = bootDirs(config);
  for (const d of [dirs.http, dirs.media, dirs.tftp]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return dirs;
}

// Case-insensitive single-segment lookup: returns the REAL on-disk name.
// This is the guard against the exact bring-up bug where media copied from a
// Windows machine had lowercase `bcd` while the hand-written script said
// `BCD` — we always reference whatever the file is actually called.
function findEntryCI(dir, name) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  if (entries.includes(name)) return name; // exact match wins
  const lower = name.toLowerCase();
  return entries.find((e) => e.toLowerCase() === lower) || null;
}

// Walk `segments` under `base` case-insensitively; returns the real relative
// path (joined with '/') or null if any segment is missing.
function resolveCI(base, segments) {
  let dir = base;
  const real = [];
  for (const seg of segments) {
    const found = findEntryCI(dir, seg);
    if (!found) return null;
    real.push(found);
    dir = path.join(dir, found);
  }
  return real.join('/');
}

function statEntry(base, relPath) {
  if (!relPath) return { present: false };
  try {
    const st = fs.statSync(path.join(base, relPath));
    return { present: true, size: st.size, path: relPath };
  } catch (_) {
    return { present: false };
  }
}

// Which kind of install image is staged? Split .swm media is critical to
// detect up front: Windows Setup silently CANNOT install from split images
// (it exits with no error at all — cost hours on the real bring-up), so the
// generated deploy script must use dism /Apply-Image /SWMFile: instead.
function detectInstallMedia(httpDir) {
  const sourcesRel = resolveCI(httpDir, ['media', 'sources']);
  if (!sourcesRel) return { kind: null, files: [] };
  const sourcesDir = path.join(httpDir, sourcesRel);
  let entries = [];
  try {
    entries = fs.readdirSync(sourcesDir);
  } catch (_) {
    return { kind: null, files: [] };
  }
  const ci = (n) => entries.find((e) => e.toLowerCase() === n);
  const wim = ci('install.wim');
  if (wim) return { kind: 'wim', files: [`${sourcesRel}/${wim}`] };
  const esd = ci('install.esd');
  if (esd) return { kind: 'esd', files: [`${sourcesRel}/${esd}`] };
  // Split media: install.swm, install2.swm, install3.swm, ...
  const swms = entries
    .filter((e) => /^install\d*\.swm$/i.test(e))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/) || '1', 10) || 1;
      const nb = parseInt(b.match(/\d+/) || '1', 10) || 1;
      return na - nb;
    });
  if (swms.length > 0) {
    return { kind: 'swm', swmParts: swms.length, files: swms.map((s) => `${sourcesRel}/${s}`) };
  }
  return { kind: null, files: [] };
}

// Full presence/size report for everything the boot chain needs; drives the
// Boot Files UI and the diagnostics panel.
function bootFilesStatus(config) {
  const dirs = bootDirs(config);
  const bcdRel = resolveCI(dirs.http, ['media', 'Boot', 'BCD']);
  const sdiRel = resolveCI(dirs.http, ['media', 'Boot', 'boot.sdi']);
  const bootWimRel = resolveCI(dirs.http, ['media', 'sources', 'boot.wim']);
  return {
    dirs: { root: dirs.root, http: dirs.http, tftp: dirs.tftp },
    tftp: {
      enabled: config.tftpEnabled,
      port: config.tftpPort,
      snponly: statEntry(dirs.tftp, findEntryCI(dirs.tftp, 'snponly.efi')),
    },
    http: {
      wimboot: statEntry(dirs.http, findEntryCI(dirs.http, 'wimboot')),
      bcd: statEntry(dirs.http, bcdRel),
      bootSdi: statEntry(dirs.http, sdiRel),
      bootWim: statEntry(dirs.http, bootWimRel),
    },
    install: detectInstallMedia(dirs.http),
  };
}

// Generate winpe.ipxe from what is ACTUALLY on disk. URLs use the real
// on-disk names (case included); the names presented to WinPE stay the
// canonical BCD / boot.sdi / boot.wim that wimboot expects.
function generateWinpeIpxe({ baseUrl, config }) {
  const dirs = bootDirs(config);
  const wimboot = findEntryCI(dirs.http, 'wimboot');
  const bcd = resolveCI(dirs.http, ['media', 'Boot', 'BCD']);
  const sdi = resolveCI(dirs.http, ['media', 'Boot', 'boot.sdi']);
  const bootWim = resolveCI(dirs.http, ['media', 'sources', 'boot.wim']);

  const missing = [];
  if (!wimboot) missing.push('wimboot');
  if (!bcd) missing.push('media/Boot/BCD');
  if (!sdi) missing.push('media/Boot/boot.sdi');
  if (!bootWim) missing.push('media/sources/boot.wim');
  if (missing.length > 0) return { ok: false, missing, script: null };

  const url = (rel) => `${baseUrl}/boot/files/${rel.split('/').map(encodeURIComponent).join('/')}`;
  const script = [
    '#!ipxe',
    `kernel ${url(wimboot)}`,
    `initrd ${url(bcd)} BCD`,
    `initrd ${url(sdi)} boot.sdi`,
    `initrd ${url(bootWim)} boot.wim`,
    'boot',
  ].join('\n') + '\n';
  return { ok: true, missing: [], script };
}

// Official wimboot release from the iPXE project. latest/download redirects
// to the newest tagged release; global fetch (Node 20+) follows it.
const WIMBOOT_URL = 'https://github.com/ipxe/wimboot/releases/latest/download/wimboot';

async function downloadWimboot(config) {
  const dirs = ensureBootDirs(config);
  const res = await fetch(WIMBOOT_URL);
  if (!res.ok) throw new Error(`wimboot download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Sanity floor: real wimboot is ~60-90 KB; a redirect/error page is not.
  if (buf.length < 50 * 1024) {
    throw new Error(`wimboot download suspiciously small (${buf.length} bytes); not saving`);
  }
  // tmp+rename so a half-written file is never served.
  const dest = path.join(dirs.http, 'wimboot');
  const tmp = `${dest}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return { size: buf.length };
}

// First/last boot-request tracking, powering the honest DHCP checklist
// indicator: FleetDeck can't configure UniFi, but it CAN detect that the
// DHCP settings worked, because the very next thing a correctly-configured
// machine does is hit our TFTP (snponly.efi) and then our HTTP (/boot/*).
function recordBootActivity(db, kind /* 'http' | 'tftp' */, detail = null) {
  const now = new Date().toISOString();
  try {
    setSetting(db, `last_${kind}_boot_request_at`, now);
    if (!getSetting(db, `first_${kind}_boot_request_at`, null)) {
      setSetting(db, `first_${kind}_boot_request_at`, now);
      logEvent(db, { action: `setup.first_${kind}_request`, after: { at: now, detail } });
    }
  } catch (err) {
    // Tracking must never break boot serving itself.
    console.error('[bootFiles] activity tracking failed:', err.message);
  }
}

function bootActivity(db) {
  return {
    http: {
      first: getSetting(db, 'first_http_boot_request_at', null),
      last: getSetting(db, 'last_http_boot_request_at', null),
    },
    tftp: {
      first: getSetting(db, 'first_tftp_boot_request_at', null),
      last: getSetting(db, 'last_tftp_boot_request_at', null),
    },
  };
}

module.exports = {
  bootDirs, ensureBootDirs, findEntryCI, resolveCI,
  bootFilesStatus, detectInstallMedia, generateWinpeIpxe,
  downloadWimboot, WIMBOOT_URL,
  recordBootActivity, bootActivity,
};
