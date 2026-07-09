const express = require('express');

const { normalizeMac, fromHexHyp } = require('../services/mac');
const { renderBootScript, renderUnknownScript, renderGoldenBuildScript } = require('../services/ipxeTemplate');
const {
  getClientByMac,
  updateClient,
  getAllSettings,
  upsertDiscovered,
  logEvent,
  getActiveGoldenBuildSession,
} = require('../db/index');

// Every response is 200 text/plain, even for malformed MACs, unknown clients, or
// internal errors: booting iPXE firmware has no login flow and cannot handle an
// HTTP error status, so we always hand it an executable script instead of stranding it.
function ipxe(res, body) {
  res.set('Content-Type', 'text/plain');
  res.status(200).send(body);
}

function createBootRouter(ctx) {
  const router = express.Router();

  router.get('/boot/:macfile', (req, res) => {
    try {
      const hexhyp = req.params.macfile.replace(/\.ipxe$/i, '');

      let mac;
      try {
        mac = normalizeMac(fromHexHyp(hexhyp));
      } catch (e) {
        return ipxe(res, '#!ipxe\necho Malformed MAC in request path\nshell\n');
      }

      // Golden Build Mode takes precedence over normal client/discovered
      // handling. Arming a MAC is a deliberate, high-privilege action (it
      // grants direct write access to the live golden zvol), so an armed MAC
      // gets the sanhook script regardless of whether it is also a registered
      // fleet client — this must win unambiguously and never be shadowed by a
      // normal per-client boot.
      const buildSession = getActiveGoldenBuildSession(ctx.db);
      if (buildSession && buildSession.mac === mac) {
        const settings = getAllSettings(ctx.db);
        const winpeChainUrl = settings.winpe_chain_url;
        if (!winpeChainUrl) {
          // arm() rejects when winpe_chain_url is unset, but it could have been
          // cleared after arming — never emit a script with a blank chain target.
          logEvent(ctx.db, {
            action: 'boot.golden_build_serve.error',
            after: { mac, session_id: buildSession.id, error: 'winpe_chain_url unset' },
          });
          return ipxe(res, '#!ipxe\necho Golden Build Mode armed but winpe_chain_url is unset in FleetDeck\nshell\n');
        }
        const script = renderGoldenBuildScript({
          settings,
          truenasHost: ctx.config.truenasHost,
          goldenZvol: ctx.config.goldenZvol,
          winpeChainUrl,
        });
        // Distinct from boot.serve: this is a meaningfully different (and more
        // consequential) thing to have happened than a normal client boot.
        logEvent(ctx.db, {
          action: 'boot.golden_build_serve',
          after: { mac, session_id: buildSession.id },
        });
        return ipxe(res, script);
      }

      const client = getClientByMac(ctx.db, mac);

      let script;
      if (client) {
        const settings = getAllSettings(ctx.db);
        script = renderBootScript({ client, settings, truenasHost: ctx.config.truenasHost });

        if (client.boot_golden_once) {
          updateClient(ctx.db, client.id, { boot_golden_once: 0 });
        }
        updateClient(ctx.db, client.id, { last_boot_at: new Date().toISOString() });
        logEvent(ctx.db, {
          action: 'boot.serve',
          clientId: client.id,
          after: { target: client.target_name },
        });
      } else {
        upsertDiscovered(ctx.db, mac);
        logEvent(ctx.db, { action: 'boot.serve.unknown', after: { mac } });
        script = renderUnknownScript(mac);
      }

      return ipxe(res, script);
    } catch (err) {
      console.error('boot route error:', err);
      return ipxe(res, '#!ipxe\necho FleetDeck internal error\nshell\n');
    }
  });

  return router;
}

module.exports = { createBootRouter };
