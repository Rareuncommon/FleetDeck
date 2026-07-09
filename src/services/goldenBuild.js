'use strict';

const {
  getSetting,
  getActiveGoldenBuildSession,
  insertGoldenBuildSession,
  closeActiveGoldenBuildSession,
  closeExpiredGoldenBuildSessions,
  logEvent,
} = require('../db');
const { normalizeMac } = require('./mac');
const { goldenTargetName } = require('./ipxeTemplate');

const DEFAULT_DURATION_MINUTES = 240;

// Is anything currently connected to the golden target's iSCSI LUN? Mirrors
// clientOps.assertNoActiveSession's approach, including the sessionsGranular
// degradation, but scoped to the golden target instead of a client target.
// Two initiators sanhook-ing the same LUN concurrently risks filesystem
// corruption on the golden zvol, so arming refuses when this returns true.
async function goldenTargetHasSession(ctx) {
  const adapter = ctx.adapter;
  // No live TrueNAS connection: we can't perform this belt-and-suspenders
  // check. The DB single-active-session guard still holds, so we allow arming
  // but record that the check was skipped (see armGoldenBuild's event).
  if (!adapter) return null;
  const target = goldenTargetName(ctx.config.goldenZvol);
  // Count-only builds can't say WHICH target a session is on, so any active
  // session is treated as possibly-the-golden-one — fail safe.
  if (adapter.sessionsGranular === false) {
    const count = await adapter.sessionCount();
    return count > 0;
  }
  const sessions = await adapter.listSessions();
  return (sessions || []).some((s) => {
    const t = s && s.target ? String(s.target) : '';
    return t === target || t.endsWith(`:${target}`);
  });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Arm Golden Build Mode for a MAC. This mutates ONLY FleetDeck's own DB and
// what boot.js serves next — it performs no TrueNAS mutation (no clone,
// target, or extent), so it is intentionally NOT gated by DRY_RUN, matching
// boot-script serving (also never DRY_RUN gated) rather than the mutating
// actions in clientOps.js. See the route + PR notes: DRY_RUN's contract is
// "FleetDeck won't mutate TrueNAS", which this honours — the actual writes to
// golden are performed by the booted machine, on the operator's explicit
// instruction, not by FleetDeck.
async function armGoldenBuild(ctx, { mac, durationMinutes }) {
  const winpe = getSetting(ctx.db, 'winpe_chain_url', '');
  if (!winpe) {
    throw httpError(400,
      'winpe_chain_url is not set; configure it in Settings before arming Golden Build Mode');
  }

  const normMac = normalizeMac(mac); // throws on a malformed MAC

  // Friendly pre-check (the atomic insert below is the real race guard).
  const existing = getActiveGoldenBuildSession(ctx.db);
  if (existing) {
    throw httpError(409, existing.mac === normMac
      ? `Golden Build Mode is already armed for ${normMac}; end it before re-arming`
      : `Golden Build Mode is already armed for a different machine (${existing.mac}); end that session first`);
  }

  const truenasSession = await goldenTargetHasSession(ctx);
  if (truenasSession === true) {
    throw httpError(409,
      'An iSCSI session is already connected to the golden target; refusing to arm to avoid two ' +
      'concurrent writers corrupting the golden zvol. Disconnect it first.');
  }

  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + durationMinutes * 60000);
  let session;
  try {
    session = insertGoldenBuildSession(ctx.db, {
      mac: normMac,
      startedAt: startedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    if (err.code === 'GOLDEN_BUILD_ACTIVE') {
      throw httpError(409, 'A golden build session was armed concurrently; try again');
    }
    throw err;
  }

  logEvent(ctx.db, {
    action: 'golden_build.armed',
    after: {
      mac: normMac,
      duration_minutes: durationMinutes,
      expires_at: session.expires_at,
      session_id: session.id,
      // truenasSession === null means the adapter was unavailable and the
      // golden-target session check could not be performed.
      truenas_session_check: truenasSession === null ? 'skipped_adapter_unavailable' : 'clear',
    },
  });
  return session;
}

// End the current active session early (reason 'manual'). Idempotent: returns
// null and logs nothing if none is active.
function endGoldenBuild(ctx, { reason = 'manual' } = {}) {
  const ended = closeActiveGoldenBuildSession(ctx.db, reason);
  if (ended) {
    logEvent(ctx.db, {
      action: 'golden_build.ended',
      after: { mac: ended.mac, reason, session_id: ended.id },
    });
  }
  return ended;
}

// Background expiry, piggybacked on the session poller's cadence. NOTE: expiry
// only prevents the sanhook script from being served on a FUTURE PXE attempt.
// It cannot forcibly disconnect an iSCSI session already connected to the
// golden zvol — that machine keeps its live connection until it reboots or is
// disconnected manually in TrueNAS.
function expireGoldenBuild(ctx) {
  const expired = closeExpiredGoldenBuildSessions(ctx.db, new Date().toISOString());
  for (const s of expired) {
    logEvent(ctx.db, {
      action: 'golden_build.expired',
      after: { mac: s.mac, session_id: s.id, expires_at: s.expires_at },
    });
  }
  return expired;
}

module.exports = {
  armGoldenBuild, endGoldenBuild, expireGoldenBuild, goldenTargetHasSession,
  DEFAULT_DURATION_MINUTES,
};
