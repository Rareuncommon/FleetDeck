'use strict';

const { getSetting, logEvent } = require('../db');

// Generic outbound webhook (item 30). Deliberately NOT Discord/Slack-shaped:
// the payload is a plain { event, ts, ...data } JSON object that both accept
// via their own incoming-webhook adapters (Discord: use a service like a
// relay or their /slack-compatible endpoint; docs note how to adapt if a
// formatted embed is wanted). Event types the operator can subscribe to via
// webhook_events (comma-separated): pool_warning, reset_failed,
// nightly_summary.
const KNOWN_EVENTS = ['pool_warning', 'reset_failed', 'nightly_summary'];

function subscribedEvents(db) {
  const raw = getSetting(db, 'webhook_events', KNOWN_EVENTS.join(','));
  return new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean));
}

// Fire-and-forget with a hard timeout: a dead webhook receiver must never
// stall or crash a poller/scheduler code path. Failures are audited once
// per call, not thrown.
async function fireWebhook(ctx, event, data = {}) {
  try {
    const url = getSetting(ctx.db, 'webhook_url', '');
    if (!url) return false;
    if (!subscribedEvents(ctx.db).has(event)) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, ts: new Date().toISOString(), ...data }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`webhook receiver returned ${res.status}`);
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    try {
      logEvent(ctx.db, { action: 'webhook.failed', after: { event, error: err.message } });
    } catch (_) { /* never let webhook bookkeeping throw */ }
    return false;
  }
}

module.exports = { fireWebhook, KNOWN_EVENTS };
