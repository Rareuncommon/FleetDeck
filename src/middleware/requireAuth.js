'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'fleetdeck_session';

function hmac(cookieSecret, data) {
  return crypto.createHmac('sha256', cookieSecret).update(data).digest('hex');
}

// Cookie format: "<expMs>.<usernameBase64url>.<hmac(exp.user)>". The username
// travels in the (signed) cookie so multi-admin features — audit actor, the
// per-admin "what's new" marker — know who is acting without a server-side
// session store. Old two-part cookies simply fail verification and force a
// re-login, which is the acceptable cost of the upgrade.
function signSession(cookieSecret, expiresAtMs, username = 'admin') {
  const exp = String(expiresAtMs);
  const user = Buffer.from(String(username), 'utf8').toString('base64url');
  return `${exp}.${user}.${hmac(cookieSecret, `${exp}.${user}`)}`;
}

// Returns the username on success, false on any failure — callers that only
// care about validity can keep truthiness-testing the result.
function verifySession(cookieSecret, cookieValue) {
  if (typeof cookieValue !== 'string') return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 3) return false;
  const [exp, user, sig] = parts;
  if (!/^\d+$/.test(exp) || !/^[A-Za-z0-9_-]+$/.test(user) || !/^[0-9a-f]+$/i.test(sig)) return false;

  const expected = hmac(cookieSecret, `${exp}.${user}`);
  const sigBuf = Buffer.from(sig, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  if (Number(exp) <= Date.now()) return false;

  try {
    return Buffer.from(user, 'base64url').toString('utf8') || false;
  } catch (_) {
    return false;
  }
}

// Express does not populate req.cookies without cookie-parser (not a dependency
// here), so we parse the raw Cookie header ourselves.
function parseCookies(req) {
  const header = req && req.headers && req.headers.cookie;
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch (_) {
      // leave value as-is if it is not valid percent-encoding
    }
    out[name] = value;
  }
  return out;
}

function requireAuth(cookieSecret) {
  return function (req, res, next) {
    const cookies = parseCookies(req);
    const value = cookies[COOKIE_NAME];
    const user = value && verifySession(cookieSecret, value);
    if (user) {
      req.adminUser = user; // audit actor + per-admin state downstream
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
  };
}

module.exports = { requireAuth, signSession, verifySession, parseCookies, COOKIE_NAME };
