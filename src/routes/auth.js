'use strict';

const express = require('express');
const crypto = require('crypto');
const { signSession, COOKIE_NAME } = require('../middleware/requireAuth');
const { getSetting, getAdminByUsername, countAdmins, logEvent } = require('../db');

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  // Hash both sides so timingSafeEqual gets equal-length buffers regardless of
  // input length, avoiding a length-based early return / throw.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// scrypt with a per-hash random salt, stored as "salt:hash" hex. Node's
// built-in scrypt keeps this dependency-free; parameters are the Node
// defaults (N=16384), fine for a handful of local admin accounts.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Per-IP lockout: unchanged from the single-password era — it counts failed
// attempts regardless of which username they guess at.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30 * 1000;
const attempts = new Map();

function isLocked(ip) {
  const rec = attempts.get(ip);
  return !!(rec && rec.lockedUntil && Date.now() < rec.lockedUntil);
}

function recordFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  attempts.set(ip, rec);
}

function recordSuccess(ip) {
  attempts.delete(ip);
}

const DEFAULT_SESSION_MINUTES = 12 * 60;

function createAuthRouter(ctx) {
  const router = express.Router();
  const { adminPassword, cookieSecret } = ctx.config;

  router.post('/api/auth/login', (req, res) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    if (isLocked(ip)) {
      return res.status(429).json({ error: 'Too many failed attempts; try again shortly' });
    }
    const body = req.body || {};
    const password = body.password;
    if (typeof password !== 'string') {
      recordFailure(ip);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Multi-admin: once ANY named account exists, the admins table is the
    // only path and the env password stops working (otherwise removing an
    // ex-admin's account would still leave the shared password usable).
    // With the table empty, legacy single-password login continues untouched
    // so existing deployments upgrade without a lockout.
    let username = null;
    if (countAdmins(ctx.db) > 0) {
      const uname = typeof body.username === 'string' ? body.username.trim() : '';
      const admin = uname ? getAdminByUsername(ctx.db, uname) : null;
      if (!admin || !verifyPassword(password, admin.password_hash)) {
        recordFailure(ip);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      username = admin.username;
    } else {
      if (!safeEqual(password, adminPassword)) {
        recordFailure(ip);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      username = 'admin';
    }

    recordSuccess(ip);
    // Cookie lifetime from settings (item 39), replacing the hardcoded 12h;
    // read at login time so a change applies to the next login, no restart.
    const minutes = parseInt(getSetting(ctx.db, 'session_timeout_minutes', String(DEFAULT_SESSION_MINUTES)), 10);
    const ttlMs = (Number.isInteger(minutes) && minutes > 0 ? minutes : DEFAULT_SESSION_MINUTES) * 60 * 1000;
    const value = signSession(cookieSecret, Date.now() + ttlMs, username);
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}`);
    logEvent(ctx.db, { action: 'auth.login', actor: username });
    return res.status(200).json({ ok: true, username });
  });

  router.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return res.status(200).json({ ok: true });
  });

  return router;
}

module.exports = { createAuthRouter, hashPassword, verifyPassword };
