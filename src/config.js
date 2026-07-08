'use strict';

function truthyFlag(v, defaultValue) {
  if (v === undefined || v === '') return defaultValue;
  return v === '1' || v.toLowerCase() === 'true';
}

function deriveTruenasHost(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch (_) {
    return null;
  }
}

function loadConfig(env = process.env) {
  const truenasUrl = env.TRUENAS_URL || 'wss://192.168.1.36:8444/websocket';

  // Fail fast: an empty ADMIN_PASSWORD lets safeEqual('', '') succeed (login
  // with no password), and an empty COOKIE_SECRET makes session cookies
  // trivially forgeable (HMAC with a known/empty key). Never default these.
  if (!env.ADMIN_PASSWORD) {
    throw new Error('ADMIN_PASSWORD is required and must not be empty');
  }
  if (!env.COOKIE_SECRET) {
    throw new Error('COOKIE_SECRET is required and must not be empty');
  }

  return {
    truenasUrl,
    truenasApiKey: env.TRUENAS_API_KEY || '',
    truenasHost: deriveTruenasHost(truenasUrl),
    adminPassword: env.ADMIN_PASSWORD,
    cookieSecret: env.COOKIE_SECRET,
    httpPort: Number(env.HTTP_PORT) || 8080,
    httpBind: env.HTTP_BIND || '0.0.0.0',
    dryRun: truthyFlag(env.DRY_RUN, true),
    dbPath: env.DB_PATH || './data/fleetdeck.sqlite3',
    iqnPrefix: env.IQN_PREFIX || 'iqn.2005-10.org.freenas.ctl',
    goldenZvol: env.GOLDEN_ZVOL || 'Main_pool/iscsi/win-golden',
    clientZvolRoot: env.CLIENT_ZVOL_ROOT || 'Main_pool/iscsi',
    // Root pool dataset (e.g. "Main_pool") for pool-capacity alerting — defaults
    // to CLIENT_ZVOL_ROOT's first path segment, override if it ever differs.
    poolName: env.POOL_NAME || (env.CLIENT_ZVOL_ROOT || 'Main_pool/iscsi').split('/')[0],
  };
}

module.exports = { loadConfig };
