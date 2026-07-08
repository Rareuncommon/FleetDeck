const cron = require('node-cron');
const {
  listClients, getSetting, logEvent, pruneEvents,
  listExpiredSafetySnapshots, deleteSafetySnapshotRecord,
} = require('../db');
const { resetClient } = require('./clientOps');

const DEFAULT_CRON = '0 4 * * *';

async function runNightlyReset(ctx) {
  // Re-read the opted-in client list fresh on every fire (don't cache at startup).
  const clients = listClients(ctx.db).filter((c) => c.nightly_reset === 1);
  let failures = 0;

  // Sequential (not parallel) to avoid concurrent zvol destroy/clone calls on TrueNAS.
  for (const client of clients) {
    try {
      await resetClient(ctx, client.id, { force: true });
    } catch (err) {
      failures += 1;
      console.error(`[scheduler] reset failed for client ${client.id} (${client.name}):`, err);
      logEvent(ctx.db, {
        action: 'scheduler.reset.failed',
        clientId: client.id,
        after: { error: err && err.message ? err.message : String(err) },
      });
    }
  }

  logEvent(ctx.db, {
    action: 'scheduler.nightly_reset',
    after: { count: clients.length, failures },
  });

  // The events table has no other retention policy; ride along on the same
  // nightly fire rather than adding a second timer for this.
  pruneEvents(ctx.db);

  // Purge expired quarantine safety-snapshots (the undo window has closed).
  // Skip in dry-run / adapter-less mode: nothing real exists to delete.
  if (!ctx.config.dryRun && ctx.adapter) {
    const retentionDays = parseInt(getSetting(ctx.db, 'safety_snapshot_retention_days', '3'), 10) || 3;
    const expired = listExpiredSafetySnapshots(ctx.db, retentionDays);
    for (const row of expired) {
      try {
        await ctx.adapter.deleteDataset(row.zvol, { recursive: true, force: true });
        // Only drop the tracking row once the dataset is actually gone. If the
        // delete failed, keep the row so the next nightly run retries it —
        // discarding it here would orphan the quarantine dataset forever with
        // no record to find it by (the adapter has no prefix enumeration).
        deleteSafetySnapshotRecord(ctx.db, row.id);
      } catch (err) {
        console.error(`[scheduler] failed to purge expired safety snapshot ${row.zvol}:`, err);
      }
    }
  }
}

function resolveCronExpr(ctx) {
  const cronExpr = getSetting(ctx.db, 'nightly_reset_cron', DEFAULT_CRON);
  if (!cron.validate(cronExpr)) {
    console.error(`[scheduler] invalid cron "${cronExpr}", falling back to "${DEFAULT_CRON}"`);
    return DEFAULT_CRON;
  }
  return cronExpr;
}

function startScheduler(ctx) {
  let task = cron.schedule(resolveCronExpr(ctx), () => {
    runNightlyReset(ctx).catch((err) => {
      console.error('[scheduler] nightly reset run crashed:', err);
    });
  });

  // Editing nightly_reset_cron in Settings would otherwise silently do
  // nothing until the process restarts (node-cron reads the expression once
  // at schedule() time). The settings route calls this after a cron change.
  function reschedule() {
    task.stop();
    task = cron.schedule(resolveCronExpr(ctx), () => {
      runNightlyReset(ctx).catch((err) => {
        console.error('[scheduler] nightly reset run crashed:', err);
      });
    });
    console.log('[scheduler] nightly_reset_cron changed; rescheduled');
  }

  function stop() {
    task.stop();
  }

  return { stop, reschedule };
}

module.exports = { startScheduler };
