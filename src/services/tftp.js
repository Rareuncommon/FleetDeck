'use strict';

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

// Minimal read-only TFTP server (RFC 1350 RRQ + RFC 2348 blksize + tsize).
//
// Why hand-rolled: the prompt was to pick a maintained pure-JS package, but
// the evaluation found none — `tftp` last shipped 0.1.2 in 2015, `tftp2` is
// a 0.0.1 stub, `tftp-server` is similarly abandoned. A read-only RRQ server
// is ~150 lines over dgram with zero dependencies, and dropping WRQ support
// entirely removes the whole write-path attack surface, so this is the safer
// call than depending on nine-years-unmaintained code. Serves exactly one
// job: handing snponly.efi to PXE firmware.
//
// Protocol shape: the client sends RRQ to our well-known port; each transfer
// then runs on its OWN ephemeral socket (per RFC: the server's TID must be
// randomly chosen), sending DATA blocks and waiting for ACKs, retransmitting
// on timeout. Options (blksize/tsize) are acknowledged with OACK, which the
// client confirms with ACK(0).

const OP = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5, OACK: 6 };
const MAX_BLKSIZE = 1468; // fits standard 1500 MTU with IP+UDP+TFTP headers
const RETRY_MS = 1000;
const MAX_RETRIES = 5;

function errorPacket(code, message) {
  const msg = Buffer.from(message, 'ascii');
  const buf = Buffer.alloc(4 + msg.length + 1);
  buf.writeUInt16BE(OP.ERROR, 0);
  buf.writeUInt16BE(code, 2);
  msg.copy(buf, 4);
  return buf;
}

// RRQ: opcode(2) filename\0 mode\0 [option\0 value\0]...
function parseRrq(msg) {
  const parts = [];
  let start = 2;
  for (let i = 2; i < msg.length; i += 1) {
    if (msg[i] === 0) {
      parts.push(msg.subarray(start, i).toString('ascii'));
      start = i + 1;
    }
  }
  if (parts.length < 2) return null;
  const [filename, mode, ...optPairs] = parts;
  const options = {};
  for (let i = 0; i + 1 < optPairs.length; i += 2) {
    options[optPairs[i].toLowerCase()] = optPairs[i + 1];
  }
  return { filename, mode: mode.toLowerCase(), options };
}

// Sandbox the requested name inside root. DHCP option 67 values are simple
// ("snponly.efi"), but firmware is untrusted network input all the same.
function safeResolve(root, requested) {
  const cleaned = requested.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(root, cleaned);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function startTftpServer({ root, port = 69, host = '0.0.0.0', onRead = null }) {
  const absRoot = path.resolve(root);
  const socket = dgram.createSocket('udp4');

  function runTransfer(rinfo, data, blksizeWanted, wantTsize) {
    const blksize = Math.max(8, Math.min(parseInt(blksizeWanted, 10) || 512, MAX_BLKSIZE));
    const usingOptions = blksizeWanted !== undefined || wantTsize;
    const totalBlocks = Math.floor(data.length / blksize) + 1; // final short/empty block terminates
    const tx = dgram.createSocket('udp4');
    let block = usingOptions ? 0 : 1; // OACK is "block 0"; ACK(0) then starts DATA(1)
    let retries = 0;
    let timer = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { tx.close(); } catch (_) { /* already closed */ }
    };

    const packetFor = (b) => {
      if (b === 0) {
        // OACK echoing the accepted options.
        const opts = [];
        if (blksizeWanted !== undefined) opts.push('blksize', String(blksize));
        if (wantTsize) opts.push('tsize', String(data.length));
        const body = Buffer.from(opts.map((o) => o + '\0').join(''), 'ascii');
        const buf = Buffer.alloc(2 + body.length);
        buf.writeUInt16BE(OP.OACK, 0);
        body.copy(buf, 2);
        return buf;
      }
      const chunk = data.subarray((b - 1) * blksize, b * blksize);
      const buf = Buffer.alloc(4 + chunk.length);
      buf.writeUInt16BE(OP.DATA, 0);
      buf.writeUInt16BE(b & 0xffff, 2); // block numbers wrap at 65535
      chunk.copy(buf, 4);
      return buf;
    };

    const send = (b) => {
      if (done) return;
      tx.send(packetFor(b), rinfo.port, rinfo.address);
      clearTimeout(timer);
      timer = setTimeout(() => {
        retries += 1;
        if (retries > MAX_RETRIES) return finish();
        send(b);
      }, RETRY_MS);
    };

    tx.on('message', (msg) => {
      if (done || msg.length < 4) return;
      const op = msg.readUInt16BE(0);
      if (op === OP.ERROR) return finish();
      if (op !== OP.ACK) return;
      const acked = msg.readUInt16BE(2);
      if (acked !== (block & 0xffff)) return; // stale/duplicate ACK
      retries = 0;
      if (block >= totalBlocks) return finish(); // final block acknowledged
      block += 1;
      send(block);
    });
    tx.on('error', finish);
    tx.bind(() => send(block));
  }

  socket.on('message', (msg, rinfo) => {
    if (msg.length < 4) return;
    const op = msg.readUInt16BE(0);
    if (op === OP.WRQ) {
      // Read-only by design; refuse writes outright.
      socket.send(errorPacket(2, 'Server is read-only'), rinfo.port, rinfo.address);
      return;
    }
    if (op !== OP.RRQ) return;
    const req = parseRrq(msg);
    if (!req) return;
    const filePath = req.filename ? safeResolve(absRoot, req.filename) : null;
    if (!filePath) {
      socket.send(errorPacket(2, 'Access violation'), rinfo.port, rinfo.address);
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        socket.send(errorPacket(1, 'File not found'), rinfo.port, rinfo.address);
        return;
      }
      if (onRead) {
        try { onRead(req.filename, rinfo); } catch (_) { /* tracking must not break serving */ }
      }
      runTransfer(rinfo, data, req.options.blksize, 'tsize' in req.options);
    });
  });

  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, host, () => {
      socket.removeListener('error', reject);
      socket.on('error', (err) => console.error('[tftp] socket error:', err.message));
      resolve({
        port: socket.address().port,
        close() {
          try { socket.close(); } catch (_) { /* already closed */ }
        },
      });
    });
  });
}

// Minimal TFTP read client, used by the diagnostics panel to prove the
// in-process server actually answers (a self-test read of snponly.efi) —
// the honest version of "TFTP is configured".
function tftpFetch({ host = '127.0.0.1', port = 69, filename, timeoutMs = 4000 }) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const chunks = [];
    let finished = false;
    const finish = (err, data) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) { /* already closed */ }
      if (err) reject(err); else resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('TFTP self-test timed out')), timeoutMs);

    sock.on('message', (msg, rinfo) => {
      if (msg.length < 4) return;
      const op = msg.readUInt16BE(0);
      if (op === OP.ERROR) {
        return finish(new Error(`TFTP error: ${msg.subarray(4, msg.length - 1).toString('ascii')}`));
      }
      if (op === OP.DATA) {
        const block = msg.readUInt16BE(2);
        chunks.push(msg.subarray(4));
        const ack = Buffer.alloc(4);
        ack.writeUInt16BE(OP.ACK, 0);
        ack.writeUInt16BE(block, 2);
        sock.send(ack, rinfo.port, rinfo.address);
        if (msg.length - 4 < 512) finish(null, Buffer.concat(chunks));
      }
    });
    sock.on('error', finish);
    const rrq = Buffer.concat([Buffer.from([0, OP.RRQ]), Buffer.from(`${filename}\0octet\0`, 'ascii')]);
    sock.send(rrq, port, host);
  });
}

module.exports = { startTftpServer, tftpFetch };
