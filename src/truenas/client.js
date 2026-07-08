const EventEmitter = require('events');
const WebSocket = require('ws');

class TrueNASClient extends EventEmitter {
  constructor({ url, apiKey }) {
    super();
    if (!url) throw new Error('TrueNASClient requires a url');
    if (!apiKey) throw new Error('TrueNASClient requires an apiKey');
    this.url = url;
    this._apiKey = apiKey;
    this.ws = null;
    this._nextId = 1;
    this._pending = new Map();
    this._connected = false;
    this._closed = false;
  }

  connect() {
    if (this._connected) return Promise.resolve();
    this._closed = false;
    return new Promise((resolve, reject) => {
      // Self-signed TLS is expected on the closed home LAN TrueNAS box, so we
      // accept it here rather than shipping a cert into every fleet node.
      const ws = new WebSocket(this.url, { rejectUnauthorized: false });
      this.ws = ws;

      let settled = false;
      const failConnect = (err) => {
        if (settled) return;
        settled = true;
        this._connected = false;
        try { ws.terminate(); } catch (_) {}
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      ws.on('open', async () => {
        this._connected = true;
        try {
          const result = await this.call('auth.login_with_api_key', [this._apiKey]);
          if (result !== true) {
            throw new Error('TrueNAS authentication rejected the API key');
          }
          settled = true;
          this.emit('connected');
          resolve();
        } catch (err) {
          const wrapped = new Error(`TrueNAS authentication failed: ${err.message}`);
          failConnect(wrapped);
        }
      });

      ws.on('message', (data) => this._onMessage(data));

      ws.on('error', (err) => {
        // Guard: a bare EventEmitter throws on an 'error' emit with no listener,
        // which would crash a caller that only awaits connect()'s rejection.
        if (this.listenerCount('error') > 0) this.emit('error', err);
        failConnect(new Error(`TrueNAS connection error: ${err.message}`));
      });

      ws.on('close', () => {
        const wasConnected = this._connected;
        this._connected = false;
        this._rejectAllPending(new Error('TrueNAS connection closed'));
        if (settled && wasConnected && !this._closed) {
          this.emit('disconnected');
        }
        failConnect(new Error('TrueNAS connection closed before authentication'));
      });
    });
  }

  call(method, params = [], { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this._closed) {
        return reject(new Error('TrueNASClient is closed'));
      }
      if (!this._connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('TrueNASClient is not connected; call connect() first'));
      }
      const id = this._nextId++;
      const payload = { jsonrpc: '2.0', id, method, params };

      // A hung RPC (TrueNAS accepts the call but never answers) would otherwise
      // leave this promise unsettled forever — fatal for sequential batches like
      // the nightly reset loop, which has no outer timeout of its own and would
      // stall indefinitely on a single bad call. Wrapping resolve/reject here
      // (rather than in _onMessage/_rejectAllPending) means every settlement
      // path — a normal reply, a connection close, or this timeout — clears it.
      let timer = null;
      const settled = (fn) => (value) => {
        if (timer) { clearTimeout(timer); timer = null; }
        fn(value);
      };
      const wrappedResolve = settled(resolve);
      const wrappedReject = settled(reject);

      this._pending.set(id, { resolve: wrappedResolve, reject: wrappedReject });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this._pending.delete(id)) {
            wrappedReject(new Error(`TrueNAS RPC "${method}" timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }

      this.ws.send(JSON.stringify(payload), (err) => {
        if (err && this._pending.delete(id)) {
          wrappedReject(new Error(`Failed to send RPC "${method}": ${err.message}`));
        }
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      this._closed = true;
      this._rejectAllPending(new Error('TrueNASClient closed while request was pending'));
      const ws = this.ws;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        this._connected = false;
        return resolve();
      }
      ws.once('close', () => {
        this._connected = false;
        resolve();
      });
      try { ws.close(); } catch (_) {
        this._connected = false;
        resolve();
      }
    });
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== 'object' || !('id' in msg)) {
      return; // unsolicited event/notification with no matching request
    }
    const pending = this._pending.get(msg.id);
    if (!pending) return;
    this._pending.delete(msg.id);
    if (msg.error) {
      const code = msg.error.code !== undefined ? ` (code ${msg.error.code})` : '';
      const errMsg = msg.error.message || 'Unknown JSON-RPC error';
      pending.reject(new Error(`TrueNAS RPC error${code}: ${errMsg}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  _rejectAllPending(err) {
    for (const { reject } of this._pending.values()) {
      reject(err);
    }
    this._pending.clear();
  }
}

module.exports = { TrueNASClient };
