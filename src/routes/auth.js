'use strict';

const express = require('express');
const crypto = require('crypto');
const { signSession, COOKIE_NAME } = require('../middleware/requireAuth');

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  // Hash both sides so timingSafeEqual gets equal-length buffers regardless of
  // input length, avoiding a length-based early return / throw.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Single-admin-password logins have no other brute-force defense. A small
// in-memory per-IP lockout (fine for this single-process app) blunts naive
// password guessing without needing an external store.
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

function createAuthRouter({ adminPassword, cookieSecret, sessionTtlMs = 12 * 60 * 60 * 1000 }) {
  const router = express.Router();

  router.post('/api/auth/login', (req, res) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    if (isLocked(ip)) {
      return res.status(429).json({ error: 'Too many failed attempts; try again shortly' });
    }
    const password = req.body && req.body.password;
    if (typeof password !== 'string' || !safeEqual(password, adminPassword)) {
      recordFailure(ip);
      return res.status(401).json({ error: 'Invalid password' });
    }
    recordSuccess(ip);
    const value = signSession(cookieSecret, Date.now() + sessionTtlMs);
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}`);
    return res.status(200).json({ ok: true });
  });

  router.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return res.status(200).json({ ok: true });
  });

  return router;
}

module.exports = { createAuthRouter };
