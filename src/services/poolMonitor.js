'use strict';
const { getSetting, logEvent } = require('../db');

function startPoolMonitor(ctx, intervalMs = 60000) {
  let lastStatus = null;       // { usedPercent, used, available, checkedAt } | null
  let lastAlertAt = 0;         // ms epoch of the last time we logged a capacity warning
  const ALERT_DEBOUNCE_MS = 60 * 60 * 1000; // re-alert at most once per hour

  async function tick() {
    if (!ctx.adapter) return; // nothing to poll without a live connection
    try {
      const dataset = await ctx.adapter.queryDataset(ctx.config.poolName);
      if (!dataset || dataset.used == null || dataset.available == null) return; // can't compute, skip silently
      const used = Number(dataset.used);
      const available = Number(dataset.available);
      const total = used + available;
      if (!(total > 0)) return;
      const usedPercent = (used / total) * 100;
      lastStatus = { usedPercent, used, available, checkedAt: new Date().toISOString() };

      const thresholdPct = parseFloat(getSetting(ctx.db, 'pool_alert_threshold_pct', '85')) || 85;
      const now = Date.now();
      if (usedPercent >= thresholdPct && now - lastAlertAt > ALERT_DEBOUNCE_MS) {
        lastAlertAt = now;
        logEvent(ctx.db, {
          action: 'pool.capacity.warning',
          after: { usedPercent: Math.round(usedPercent * 10) / 10, thresholdPct, poolName: ctx.config.poolName },
        });
      }
    } catch (err) {
      console.error('[poolMonitor] check failed:', err);
    }
  }

  tick();
  const timer = setInterval(tick, intervalMs);

  return {
    stop() { clearInterval(timer); },
    getStatus() { return lastStatus; },
  };
}

module.exports = { startPoolMonitor };
