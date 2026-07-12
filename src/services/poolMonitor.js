'use strict';
const { getSetting, logEvent, insertPoolHistory, lastPoolHistoryAt } = require('../db');
const { fireWebhook } = require('./webhook');

// One history point per this interval feeds the dashboard sparkline; the
// warning events alone (hourly-debounced threshold crossings) were useless
// as a trend line.
const HISTORY_INTERVAL_MS = 5 * 60 * 1000;

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

      // Sparkline time series: bounded, one point per HISTORY_INTERVAL_MS.
      const lastPoint = lastPoolHistoryAt(ctx.db);
      if (!lastPoint || Date.now() - new Date(lastPoint).getTime() >= HISTORY_INTERVAL_MS) {
        insertPoolHistory(ctx.db, Math.round(usedPercent * 10) / 10);
      }

      const thresholdPct = parseFloat(getSetting(ctx.db, 'pool_alert_threshold_pct', '85')) || 85;
      const now = Date.now();
      if (usedPercent >= thresholdPct && now - lastAlertAt > ALERT_DEBOUNCE_MS) {
        lastAlertAt = now;
        logEvent(ctx.db, {
          action: 'pool.capacity.warning',
          after: { usedPercent: Math.round(usedPercent * 10) / 10, thresholdPct, poolName: ctx.config.poolName },
        });
        fireWebhook(ctx, 'pool_warning', {
          poolName: ctx.config.poolName,
          usedPercent: Math.round(usedPercent * 10) / 10,
          thresholdPct,
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
