'use strict';

const WebSocket = require('ws');
const { changes } = require('../db');
const { parseCookies, verifySession, COOKIE_NAME } = require('../middleware/requireAuth');

// Live-update push channel. Strictly additive to the REST API: the frontend
// treats a WS message as "something changed, refetch/patch state" and falls
// back to its existing polling whenever the socket is down, so nothing
// functional depends on this channel existing. Three message types:
//   clients_changed — any insert/update/delete on the clients table
//                     (debounced: bulk ops emit dozens in one burst)
//   event           — a new audit row, same shape GET /api/events serves
//   truenas         — adapter connection state ({ connected }), sent on
//                     every transition and greeted to each new socket
function createPushChannel(server, ctx) {
  // noServer + manual upgrade rather than ws's built-in server: the upgrade
  // is where auth happens. /ws carries the same data the /api routes serve,
  // so it must demand the same session cookie — an unauthenticated socket
  // would otherwise leak client names/status changes to anyone on the LAN.
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = null;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) { /* malformed URL: fall through to destroy */ }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const cookies = parseCookies(req);
    if (!verifySession(ctx.config.cookieSecret, cookies[COOKIE_NAME])) {
      // Proper HTTP rejection (not a bare destroy) so browser devtools show
      // 401 instead of an opaque connection failure.
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload, ts: new Date().toISOString() });
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch (_) { /* dying socket; ping reaper handles it */ }
      }
    }
  }

  // Debounce clients_changed: a bulk reset/import mutates N rows back to back
  // and the frontend refetches the whole list per message — one refetch per
  // burst is enough. Audit events are NOT debounced (each is distinct data).
  let clientsTimer = null;
  const onClientsChanged = () => {
    if (clientsTimer) return;
    clientsTimer = setTimeout(() => {
      clientsTimer = null;
      broadcast('clients_changed', {});
    }, 250);
  };
  const onEvent = (row) => broadcast('event', row);
  changes.on('clients_changed', onClientsChanged);
  changes.on('event', onEvent);

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* reaper terminates; don't crash the process */ });
    // Greet with the current adapter + reconnect state so a fresh tab shows
    // connection status immediately (including "reconnecting" with attempt/
    // next-retry) instead of waiting for the next transition.
    try {
      ws.send(JSON.stringify({
        type: 'truenas',
        payload: { connected: !!ctx.adapter, ...(ctx.connState || {}) },
        ts: new Date().toISOString(),
      }));
    } catch (_) { /* socket died mid-handshake */ }
  });

  // Browsers that vanish without a close frame (sleep, network drop) would
  // otherwise accumulate as zombie sockets we keep broadcasting to.
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) { /* already dead */ }
    }
  }, 30000);

  return {
    broadcast,
    clientCount: () => wss.clients.size,
    stop() {
      clearInterval(pingTimer);
      if (clientsTimer) clearTimeout(clientsTimer);
      changes.off('clients_changed', onClientsChanged);
      changes.off('event', onEvent);
      for (const ws of wss.clients) {
        try { ws.terminate(); } catch (_) { /* already gone */ }
      }
      wss.close();
    },
  };
}

module.exports = { createPushChannel };
