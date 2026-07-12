'use strict';

const pkg = require('../../package.json');

// Daily (not per-request) check of the latest GitHub release tag against the
// running package.json version. Shows a small "update available" badge in
// Settings — NO auto-update: this is a homelab app, updates stay manual.
// Failures are silent by design (the box may have no internet at all).
const REPO = 'Rareuncommon/FleetDeck';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function normalize(v) {
  return String(v || '').replace(/^v/, '').trim();
}

function startUpdateCheck(ctx, intervalMs = CHECK_INTERVAL_MS) {
  ctx.updateInfo = { current: pkg.version, latest: null, updateAvailable: false, checkedAt: null };

  async function tick() {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'FleetDeck' },
      });
      if (!res.ok) return; // no releases yet / rate limited / offline: stay quiet
      const rel = await res.json();
      const latest = normalize(rel.tag_name);
      if (!latest) return;
      ctx.updateInfo = {
        current: pkg.version,
        latest,
        updateAvailable: latest !== normalize(pkg.version),
        url: rel.html_url || `https://github.com/${REPO}/releases`,
        checkedAt: new Date().toISOString(),
      };
    } catch (_) { /* offline homelab is a normal state, not an error */ }
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer) };
}

module.exports = { startUpdateCheck, REPO };
