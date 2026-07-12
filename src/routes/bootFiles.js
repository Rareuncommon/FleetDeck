'use strict';

const express = require('express');
const {
  bootDirs, bootFilesStatus, generateWinpeIpxe, downloadWimboot, bootActivity,
} = require('../services/bootFiles');
const { generateDeployCmd, generateSafetyPs1 } = require('../services/deployScript');
const { getSetting, logEvent } = require('../db');

// Base URL for the boot chain as seen BY THE BOOTING CLIENT. Derived from the
// request's own Host header: the iPXE firmware just fetched this script from
// us, so however it addressed us is by definition an address that works from
// its network position — no config knob for "my own LAN IP" needed.
function baseUrlFrom(req) {
  return `http://${req.get('host')}`;
}

function createBootFilesRouter(ctx) {
  const router = express.Router();
  const dirs = bootDirs(ctx.config);

  // Generated winpe.ipxe — replaces the hand-edited file on the old ipxeboot
  // container. Built from what's actually on disk (real filename case and
  // all); like every /boot/* response it's always 200 text/plain, because
  // booting firmware can't do anything useful with an HTTP error.
  router.get('/boot/files/winpe.ipxe', (req, res) => {
    res.set('Content-Type', 'text/plain');
    try {
      const gen = generateWinpeIpxe({ baseUrl: baseUrlFrom(req), config: ctx.config });
      if (!gen.ok) {
        logEvent(ctx.db, { action: 'boot.winpe_serve.incomplete', after: { missing: gen.missing } });
        return res.status(200).send(
          '#!ipxe\n' +
          gen.missing.map((m) => `echo Missing boot file: ${m}`).join('\n') +
          '\necho Stage the files above in FleetDeck (Setup tab) and try again.\nshell\n'
        );
      }
      logEvent(ctx.db, { action: 'boot.winpe_serve' });
      return res.status(200).send(gen.script);
    } catch (err) {
      console.error('winpe.ipxe generation error:', err);
      return res.status(200).send('#!ipxe\necho FleetDeck internal error generating winpe.ipxe\nshell\n');
    }
  });

  // Generated WinPE-side automation. Registered BEFORE the static handler so
  // the live-generated versions win over the on-disk snapshots (written for
  // the SMB share at arm time). Same unauthenticated trust boundary as the
  // rest of /boot/* — WinPE can't log in either.
  router.get('/boot/files/deploy.cmd', async (req, res) => {
    res.set('Content-Type', 'text/plain');
    try {
      // Golden zvol size, when reachable, becomes the disk-picker hint.
      let goldenSizeGib = null;
      if (ctx.adapter) {
        try {
          const ds = await ctx.adapter.queryDataset(ctx.config.goldenZvol);
          const volsize = ds && ds.volsize && (ds.volsize.parsed != null ? ds.volsize.parsed : ds.volsize);
          if (typeof volsize === 'number') goldenSizeGib = Math.round(volsize / (1024 ** 3));
        } catch (_) { /* hint only; generation must not depend on TrueNAS */ }
      }
      logEvent(ctx.db, { action: 'boot.deploy_cmd_serve' });
      return res.status(200).send(generateDeployCmd({ ctx, baseUrl: baseUrlFrom(req), goldenSizeGib }));
    } catch (err) {
      console.error('deploy.cmd generation error:', err);
      return res.status(200).send('rem FleetDeck internal error generating deploy.cmd\r\n');
    }
  });

  router.get('/boot/files/fleetdeck-safety.ps1', (req, res) => {
    res.set('Content-Type', 'text/plain');
    return res.status(200).send(generateSafetyPs1());
  });

  // Static boot assets (wimboot, WinPE media). express.static rides on the
  // `send` module, which implements Range/If-Range/206 natively — wimboot
  // fetches boot.wim with ranged requests, so this is verified by test, not
  // assumed. Unauthenticated by necessity (firmware can't log in), same
  // trust boundary as /boot/:macfile.
  router.use('/boot/files', express.static(dirs.http, {
    index: false,
    dotfiles: 'ignore',
    fallthrough: false, // a miss is a plain 404, not the SPA
  }));

  // --- authenticated management API (auth applied to /api in server.js) ---

  router.get('/api/bootfiles/status', (req, res) => {
    try {
      const status = bootFilesStatus(ctx.config);
      return res.status(200).json({
        ...status,
        activity: bootActivity(ctx.db),
        smb: {
          supported: !!(ctx.adapter && ctx.adapter.supports && ctx.adapter.supports('smbShareCreate')),
          hostPath: getSetting(ctx.db, 'bootfiles_host_path', ''),
          shareName: getSetting(ctx.db, 'bootfiles_smb_share_name', 'fleetdeck-bootfiles'),
        },
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/bootfiles/download-wimboot', async (req, res) => {
    try {
      const result = await downloadWimboot(ctx.config);
      logEvent(ctx.db, { action: 'bootfiles.wimboot_downloaded', after: result });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      logEvent(ctx.db, { action: 'bootfiles.wimboot_download_failed', after: { error: err.message } });
      return res.status(502).json({ error: err.message });
    }
  });

  // Create the SMB share used to stage ISO contents into media/. This is a
  // real TrueNAS mutation, so unlike the arm/serve paths it fully respects
  // DRY_RUN: in dry-run the exact would-be payload is returned and logged,
  // nothing executed — same contract as clientOps.js.
  router.post('/api/bootfiles/smb-share', async (req, res) => {
    try {
      if (!ctx.adapter) return res.status(500).json({ error: 'TrueNAS adapter unavailable' });
      if (!ctx.adapter.supports('smbShareCreate') || !ctx.adapter.supports('smbShareQuery')) {
        return res.status(400).json({
          error: 'This TrueNAS build does not expose sharing.smb.* over the API. ' +
            'Create the share in the TrueNAS UI instead: Shares > SMB > Add, ' +
            `path = <your bootfiles dataset>/bootfiles/http, name = fleetdeck-bootfiles.`,
        });
      }
      // FleetDeck sees its volume as /data/...; TrueNAS needs the HOST path
      // backing that mount (e.g. /mnt/Main_pool/apps/fleetdeck). Only the
      // operator knows it, hence the setting.
      const hostPath = getSetting(ctx.db, 'bootfiles_host_path', '');
      if (!hostPath) {
        return res.status(400).json({
          error: 'bootfiles_host_path is not set. In Settings, set it to the TrueNAS-side path of ' +
            'the dataset mounted at /data (e.g. /mnt/Main_pool/apps/fleetdeck), then retry.',
        });
      }
      const name = getSetting(ctx.db, 'bootfiles_smb_share_name', 'fleetdeck-bootfiles');
      const payload = {
        path: `${hostPath.replace(/\/+$/, '')}/bootfiles/http`,
        name,
        purpose: 'DEFAULT_SHARE',
        comment: 'FleetDeck boot media staging (copy Windows ISO contents into media/)',
      };

      // Idempotent: an existing share by this name is success, not an error.
      const existing = await ctx.adapter.querySmbShares([['name', '=', name]]);
      if (Array.isArray(existing) && existing.length > 0) {
        return res.status(200).json({ ok: true, existing: true, share: existing[0] });
      }

      if (ctx.config.dryRun) {
        logEvent(ctx.db, { action: 'bootfiles.smb_share.dryrun', after: { payload } });
        return res.status(200).json({ dryRun: true, payload });
      }

      const share = await ctx.adapter.createSmbShare(payload);
      logEvent(ctx.db, { action: 'bootfiles.smb_share.created', after: { payload } });
      return res.status(201).json({ ok: true, share });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createBootFilesRouter };
