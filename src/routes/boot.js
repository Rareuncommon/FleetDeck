const express = require('express');

const { normalizeMac, fromHexHyp } = require('../services/mac');
const {
  renderBootScript, renderUnknownScript, renderGoldenBuildScript, renderGoldenBootScript,
} = require('../services/ipxeTemplate');
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

  // Heartbeat contract for the golden image's disk-offline safety script:
  // its SYSTEM scheduled task POSTs { safety_script_ran: true } here at
  // startup. Unauthenticated by necessity (the machine has no credentials at
  // boot), same trust boundary as the rest of /boot/* — the only effect is a
  // timestamp on an already-known MAC, so the worst a LAN attacker can do is
  // suppress a warning badge. A booted client with no recent heartbeat gets
  // flagged in the UI: the safety script may not have run.
  router.post('/boot/:mac/heartbeat', (req, res) => {
    try {
      let mac;
      try {
        mac = normalizeMac(req.params.mac);
      } catch (e) {
        return res.status(400).json({ error: 'malformed MAC' });
      }
      const client = getClientByMac(ctx.db, mac);
      if (!client) return res.status(404).json({ error: 'unknown client' });
      updateClient(ctx.db, client.id, { last_heartbeat_at: new Date().toISOString() });
      logEvent(ctx.db, {
        action: 'client.heartbeat',
        clientId: client.id,
        after: { safety_script_ran: !!(req.body && req.body.safety_script_ran) },
      });
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('heartbeat route error:', err);
      return res.status(500).json({ error: 'internal error' });
    }
  });

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
        let script;
        if (buildSession.phase === 'boot_installed') {
          // Post-install phase: the image is applied and bcdboot has run —
          // the machine must now sanboot the installed OS from the golden
          // zvol itself. Serving WinPE again here is exactly the wrong-phase
          // bug that used to need a manual static-file override.
          script = renderGoldenBootScript({
            settings,
            truenasHost: ctx.config.truenasHost,
            goldenZvol: ctx.config.goldenZvol,
          });
        } else {
          const winpeChainUrl = settings.winpe_chain_url;
          if (!winpeChainUrl) {
            // arm() rejects when winpe_chain_url is unset, but it could have
            // been cleared after arming — never emit a blank chain target.
            logEvent(ctx.db, {
              action: 'boot.golden_build_serve.error',
              after: { mac, session_id: buildSession.id, error: 'winpe_chain_url unset' },
            });
            return ipxe(res, '#!ipxe\necho Golden Build Mode armed but winpe_chain_url is unset in FleetDeck\nshell\n');
          }
          script = renderGoldenBuildScript({
            settings,
            truenasHost: ctx.config.truenasHost,
            goldenZvol: ctx.config.goldenZvol,
            winpeChainUrl,
          });
        }
        // Distinct from boot.serve: this is a meaningfully different (and more
        // consequential) thing to have happened than a normal client boot.
        logEvent(ctx.db, {
          action: 'boot.golden_build_serve',
          after: { mac, session_id: buildSession.id, phase: buildSession.phase || 'install' },
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
