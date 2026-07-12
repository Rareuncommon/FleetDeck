'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const { wizardStatus, applyStep, runDiagnostics } = require('../services/setupWizard');
const { bootDirs } = require('../services/bootFiles');
const { tftpFetch } = require('../services/tftp');
const { getSetting, logEvent } = require('../db');

// The exact embed script + build command for snponly.efi. FleetDeck cannot
// compile it (needs a build toolchain), so per the automation boundary this
// is rendered as a copy-paste block with every value prefilled from live
// config — never a fake "Build" button.
function snponlyBuild(ctx, hostHeader) {
  const chainUrl = `http://${hostHeader}/boot/\${net0/mac:hexhyp}.ipxe`;
  const embed = [
    '#!ipxe',
    'dhcp',
    `chain ${chainUrl}`,
  ].join('\n') + '\n';

  const hostPath = getSetting(ctx.db, 'bootfiles_host_path', '');
  const outDir = hostPath
    ? `${hostPath.replace(/\/+$/, '')}/bootfiles/tftp`
    : '<TrueNAS-side path of your /data volume>/bootfiles/tftp';

  const command = [
    `cat > /tmp/fleetdeck-embed.ipxe <<'EOF'`,
    embed.trimEnd(),
    'EOF',
    `docker run --rm \\`,
    `  -v /tmp/fleetdeck-embed.ipxe:/embed.ipxe:ro \\`,
    `  -v ${outDir}:/out \\`,
    `  debian:bookworm bash -c '\\`,
    `    apt-get update && apt-get install -y --no-install-recommends \\`,
    `      git gcc make binutils perl liblzma-dev mtools ca-certificates && \\`,
    `    git clone --depth 1 https://github.com/ipxe/ipxe && \\`,
    `    make -C ipxe/src bin-x86_64-efi/snponly.efi EMBED=/embed.ipxe && \\`,
    `    cp ipxe/src/bin-x86_64-efi/snponly.efi /out/'`,
  ].join('\n');

  return { embed, chainUrl, outDir, command };
}

function createSetupRouter(ctx) {
  const router = express.Router();

  router.get('/api/setup/status', async (req, res) => {
    try {
      return res.status(200).json({
        dryRun: ctx.config.dryRun,
        adapterAvailable: !!ctx.adapter,
        steps: await wizardStatus(ctx),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/setup/apply/:stepId', async (req, res) => {
    try {
      const result = await applyStep(ctx, req.params.stepId, req.body || {});
      return res.status(200).json(result);
    } catch (err) {
      // Precondition errors ("create the portal first") are client-fixable.
      const status = /first|unavailable|manual|Unknown setup step/i.test(err.message) ? 400 : 500;
      return res.status(status).json({ error: err.message });
    }
  });

  router.get('/api/setup/snponly-build', (req, res) => {
    try {
      return res.status(200).json(snponlyBuild(ctx, req.get('host')));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Alternative to building: upload a prebuilt snponly.efi straight into the
  // TFTP directory. Raw body, capped well above any plausible iPXE binary.
  router.post('/api/setup/upload-snponly',
    express.raw({ type: '*/*', limit: '16mb' }),
    (req, res) => {
      try {
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length < 64 * 1024) {
          return res.status(400).json({ error: 'Upload too small to be a real snponly.efi (expected ≥64 KiB binary)' });
        }
        // UEFI PE binaries start with the MZ DOS stub — cheap sanity gate
        // against uploading the wrong file (e.g. an .ipxe script) here.
        if (body[0] !== 0x4d || body[1] !== 0x5a) {
          return res.status(400).json({ error: 'Not a PE/EFI binary (missing MZ header) — this should be the compiled snponly.efi, not a script' });
        }
        const dirs = bootDirs(ctx.config);
        const dest = path.join(dirs.tftp, 'snponly.efi');
        const tmp = `${dest}.tmp-${Date.now()}`;
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, dest);
        logEvent(ctx.db, { action: 'setup.snponly_uploaded', after: { size: body.length } });
        return res.status(200).json({ ok: true, size: body.length });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

  router.get('/api/setup/diagnostics', async (req, res) => {
    try {
      return res.status(200).json({ checks: await runDiagnostics(ctx, { tftpFetch }) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSetupRouter };
