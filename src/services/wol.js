'use strict';
const dgram = require('dgram');

function buildMagicPacket(mac) {
  const bytes = mac.split(':').map((h) => parseInt(h, 16));
  const packet = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i += 1) {
    Buffer.from(bytes).copy(packet, 6 + i * 6);
  }
  return packet;
}

function sendWakeOnLan(mac, { broadcastAddress = '255.255.255.255', port = 9 } = {}) {
  return new Promise((resolve, reject) => {
    let packet;
    try {
      packet = buildMagicPacket(mac);
    } catch (err) {
      reject(err);
      return;
    }
    const socket = dgram.createSocket('udp4');
    socket.on('error', (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, port, broadcastAddress, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

module.exports = { sendWakeOnLan, buildMagicPacket };
