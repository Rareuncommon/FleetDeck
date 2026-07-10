'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const express = require('express');

const {
  ensureBootDirs, generateWinpeIpxe, detectInstallMedia, bootFilesStatus,
} = require('../src/services/bootFiles');
const { startTftpServer } = require('../src/services/tftp');
const { resolveMethods } = require('../src/truenas/introspect');
const { TrueNASClient } = require('../src/truenas/client');
const { createBootFilesRouter } = require('../src/routes/bootFiles');
const db = require('../src/db');

function tmpConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-bootfiles-'));
  return { bootfilesDir: root, tftpEnabled: true, tftpPort: 0, dryRun: false };
}

function write(base, rel, content = 'x') {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// --- introspection: optional capabilities -----------------------------------

test('optional capabilities resolve to null instead of failing introspection', async () => {
  const client = { call: async () => ['iscsi.target.query', 'pool.dataset.create'] };
  const resolved = await resolveMethods(
    client,
    { targetQuery: ['iscsi.target.query'], datasetCreate: ['pool.dataset.create'], smbShareCreate: ['sharing.smb.create'] },
    new Set(['smbShareCreate'])
  );
  assert.equal(resolved.targetQuery, 'iscsi.target.query');
  assert.equal(resolved.datasetCreate, 'pool.dataset.create');
  assert.equal(resolved.smbShareCreate, null); // optional + absent -> null, no throw

  // A missing REQUIRED capability still throws.
  await assert.rejects(
    () => resolveMethods(client, { extentCreate: ['iscsi.extent.create'] }, new Set()),
    /No known TrueNAS method/
  );
});

// --- winpe.ipxe generation ---------------------------------------------------

test('winpe.ipxe uses real on-disk filename case but presents canonical names', () => {
  const config = tmpConfig();
  const dirs = ensureBootDirs(config);
  // The exact real-world bug: media copied from Windows had lowercase `bcd`.
  write(dirs.http, 'wimboot');
  write(dirs.http, 'media/Boot/bcd');
  write(dirs.http, 'media/Boot/boot.sdi');
  write(dirs.http, 'media/sources/boot.wim');

  const gen = generateWinpeIpxe({ baseUrl: 'http://192.168.1.36:8080', config });
  assert.equal(gen.ok, true);
  // URL references the actual lowercase file...
  assert.match(gen.script, /initrd http:\/\/192\.168\.1\.36:8080\/boot\/files\/media\/Boot\/bcd BCD\n/);
  // ...while the name handed to wimboot stays canonical BCD.
  assert.match(gen.script, /kernel http:\/\/192\.168\.1\.36:8080\/boot\/files\/wimboot\n/);
  assert.match(gen.script, / boot\.sdi\n/);
  assert.match(gen.script, / boot\.wim\n/);
});

test('winpe.ipxe reports exactly what is missing instead of emitting a broken script', () => {
  const config = tmpConfig();
  const dirs = ensureBootDirs(config);
  write(dirs.http, 'wimboot'); // everything else absent
  const gen = generateWinpeIpxe({ baseUrl: 'http://x', config });
  assert.equal(gen.ok, false);
  assert.deepEqual(gen.missing, ['media/Boot/BCD', 'media/Boot/boot.sdi', 'media/sources/boot.wim']);
});

// --- install media detection -------------------------------------------------

test('split-WIM media is detected and distinguished from single install.wim', () => {
  const config = tmpConfig();
  const dirs = ensureBootDirs(config);
  write(dirs.http, 'media/sources/install.swm');
  write(dirs.http, 'media/sources/install2.swm');
  let media = detectInstallMedia(dirs.http);
  assert.equal(media.kind, 'swm');
  assert.equal(media.swmParts, 2);

  // install.wim beats swm detection when present.
  write(dirs.http, 'media/sources/install.wim');
  media = detectInstallMedia(dirs.http);
  assert.equal(media.kind, 'wim');

  // Status endpoint carries the same analysis.
  const status = bootFilesStatus(config);
  assert.equal(status.install.kind, 'wim');
});

// --- HTTP static serving: Range support --------------------------------------

test('/boot/files serves Range requests with 206 (wimboot fetches ranged)', async () => {
  const config = tmpConfig();
  const dirs = ensureBootDirs(config);
  write(dirs.http, 'wimboot', 'ABCDEFGHIJ');

  const ctx = { config, db: db.initDb(':memory:'), adapter: null };
  const app = express();
  app.use(express.json());
  app.use(createBootFilesRouter(ctx));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const full = await fetch(`${base}/boot/files/wimboot`);
    assert.equal(full.status, 200);
    assert.equal(await full.text(), 'ABCDEFGHIJ');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');

    const partial = await fetch(`${base}/boot/files/wimboot`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), 'CDEF');
    assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');

    // Generated winpe.ipxe route: base URL derived from the Host header.
    write(dirs.http, 'media/Boot/BCD');
    write(dirs.http, 'media/Boot/boot.sdi');
    write(dirs.http, 'media/sources/boot.wim');
    const ipxe = await fetch(`${base}/boot/files/winpe.ipxe`);
    const script = await ipxe.text();
    assert.match(script, new RegExp(`kernel ${base.replace(/[.:/]/g, '\\$&')}/boot/files/wimboot`));
  } finally {
    server.close();
  }
});

// --- TFTP server --------------------------------------------------------------

// Tiny TFTP client good enough to exercise the server: sends RRQ with a
// blksize option, ACKs each DATA block, resolves with the file content.
function tftpGet(port, filename, { blksize = 512 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const chunks = [];
    let serverPort = null;
    const fail = (e) => { sock.close(); reject(e); };
    const timer = setTimeout(() => fail(new Error('tftp client timeout')), 5000);

    const rrq = Buffer.concat([
      Buffer.from([0, 1]),
      Buffer.from(`${filename}\0octet\0blksize\0${blksize}\0tsize\0${0}\0`, 'ascii'),
    ]);
    sock.on('message', (msg, rinfo) => {
      serverPort = rinfo.port;
      const op = msg.readUInt16BE(0);
      if (op === 5) { clearTimeout(timer); return fail(new Error(`tftp error: ${msg.subarray(4, -1)}`)); }
      if (op === 6) { // OACK -> ACK(0)
        sock.send(Buffer.from([0, 4, 0, 0]), serverPort, '127.0.0.1');
        return;
      }
      if (op === 3) { // DATA
        const block = msg.readUInt16BE(2);
        const data = msg.subarray(4);
        chunks.push(data);
        const ack = Buffer.alloc(4);
        ack.writeUInt16BE(4, 0);
        ack.writeUInt16BE(block, 2);
        sock.send(ack, serverPort, '127.0.0.1');
        if (data.length < blksize) {
          clearTimeout(timer);
          sock.close();
          resolve(Buffer.concat(chunks));
        }
      }
    });
    sock.send(rrq, port, '127.0.0.1');
  });
}

test('TFTP serves a file, honors blksize, rejects traversal and writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-tftp-'));
  // 3000 bytes -> multiple blocks at blksize 1024, exercises the ACK loop.
  const payload = Buffer.alloc(3000).fill('Z');
  fs.writeFileSync(path.join(root, 'snponly.efi'), payload);

  const reads = [];
  const server = await startTftpServer({ root, port: 0, host: '127.0.0.1', onRead: (f) => reads.push(f) });
  try {
    const got = await tftpGet(server.port, 'snponly.efi', { blksize: 1024 });
    assert.equal(got.length, 3000);
    assert.ok(got.equals(payload));
    assert.deepEqual(reads, ['snponly.efi']); // onRead fired (drives the DHCP indicator)

    await assert.rejects(() => tftpGet(server.port, '../etc/passwd'), /Access violation|File not found/);
    await assert.rejects(() => tftpGet(server.port, 'nope.bin'), /File not found/);

    // WRQ -> read-only error.
    await new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      const t = setTimeout(() => { sock.close(); reject(new Error('no WRQ rejection')); }, 3000);
      sock.on('message', (msg) => {
        clearTimeout(t);
        assert.equal(msg.readUInt16BE(0), 5); // ERROR
        sock.close();
        resolve();
      });
      sock.send(Buffer.concat([Buffer.from([0, 2]), Buffer.from('x\0octet\0', 'ascii')]), server.port, '127.0.0.1');
    });
  } finally {
    server.close();
  }
});

// --- callJob ------------------------------------------------------------------

test('callJob polls core.get_jobs until the job completes (or fails)', async () => {
  const calls = [];
  let polls = 0;
  const fake = {
    call: async (method, params) => {
      calls.push(method);
      if (method === 'service.control') return 42; // job id
      if (method === 'core.get_jobs') {
        polls += 1;
        assert.deepEqual(params, [[['id', '=', 42]]]);
        return polls < 2 ? [{ id: 42, state: 'RUNNING' }] : [{ id: 42, state: 'SUCCESS', result: true }];
      }
      throw new Error('unexpected ' + method);
    },
  };
  const result = await TrueNASClient.prototype.callJob.call(fake, 'service.control', ['START', 'iscsitarget'], { pollMs: 5 });
  assert.equal(result, true);

  // Non-job response (older builds) passes straight through.
  const direct = { call: async () => ({ ok: 1 }) };
  assert.deepEqual(await TrueNASClient.prototype.callJob.call(direct, 'service.start', []), { ok: 1 });

  // FAILED job raises with detail.
  const failing = {
    call: async (method) => (method === 'x' ? 7 : [{ id: 7, state: 'FAILED', error: 'boom' }]),
  };
  await assert.rejects(
    () => TrueNASClient.prototype.callJob.call(failing, 'x', [], { pollMs: 5 }),
    /FAILED: boom/
  );
});
