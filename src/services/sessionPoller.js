'use strict';

const { listClients, updateClient } = require('../db');

function isBooted(client, sessions) {
  return sessions.some((session) => {
    const target = session && session.target;
    if (!target) return false;
    // TrueNAS may report the full IQN (e.g. "iqn.2005-10.org...:client01")
    // rather than the bare target_name. Anchor the suffix match on the ':'
    // separator so a target named "pc1" isn't matched by a session for
    // "pc10" or "mypc1" (plain endsWith(target_name) would false-positive).
    return target === client.target_name || target.endsWith(`:${client.target_name}`);
  });
}

// Warn once per process, not per tick — the degraded mode is a property of
// the TrueNAS build and won't change until restart/re-introspection.
let warnedCountOnlySessions = false;

async function pollOnce(ctx) {
  const { db, adapter } = ctx;
  // On a count-only build (sessionsGranular === false, strict so adapters
  // without the property keep the granular path) listSessions() normalizes to
  // [], which would flip every client to 'offline' forever. Don't pretend to
  // know: report 'unknown' and skip the pointless RPC. Space usage below is
  // per-dataset and unaffected, so it still updates normally.
  const granular = adapter.sessionsGranular !== false;
  if (!granular && !warnedCountOnlySessions) {
    warnedCountOnlySessions = true;
    console.error(
      '[sessionPoller] this TrueNAS build only reports an iSCSI session count, not per-target ' +
        "sessions — client status will show 'unknown' instead of booted/offline."
    );
  }
  const [sessions, clients] = await Promise.all([
    granular ? adapter.listSessions() : Promise.resolve([]),
    Promise.resolve(listClients(db)),
  ]);

  for (const client of clients) {
    // One client's failure (e.g. its zvol was retired mid-poll) must not
    // abort status/space updates for the rest of the fleet this tick.
    try {
      const status = granular
        ? (isBooted(client, sessions) ? 'booted' : 'offline')
        : 'unknown';

      let spaceUsed = client.space_used_bytes;
      const dataset = await adapter.queryDataset(client.zvol);
      if (dataset && dataset.used != null) {
        spaceUsed = dataset.used;
      }

      const fields = {};
      if (status !== client.status) fields.status = status;
      if (spaceUsed !== client.space_used_bytes) fields.space_used_bytes = spaceUsed;

      if (Object.keys(fields).length > 0) {
        updateClient(db, client.id, fields);
      }
    } catch (err) {
      console.error(`[sessionPoller] failed to poll client ${client.id} (${client.name}):`, err);
    }
  }
}

function startSessionPoller(ctx, intervalMs = 10000) {
  const tick = async () => {
    // DRY_RUN only gates mutating TrueNAS calls (see clientOps.js); read-only
    // polling must still run so the dashboard reflects live session/space data.
    // Only skip when there's no live adapter to poll at all.
    if (!ctx.adapter) return;
    try {
      await pollOnce(ctx);
    } catch (err) {
      console.error('[sessionPoller] poll tick failed:', err);
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);

  return function stop() {
    clearInterval(timer);
  };
}

module.exports = { startSessionPoller };
