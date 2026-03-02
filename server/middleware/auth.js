'use strict';

const { createHash } = require('crypto');
const { verify } = require('../../lib/crypto');
const { errorResponse } = require('../lib/errors');

const MAX_AGE_MS = 5 * 60 * 1000;
const NONCE_EXPIRY_MS = 10 * 60 * 1000;

function buildCanonicalRequest(method, path, timestamp, nonce, bodyHash) {
  return `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

function hashBody(rawBody) {
  return createHash('sha256').update(rawBody || '').digest('hex');
}

function createAuthMiddleware(db) {
  return function authMiddleware(req, res, next) {
    db.prepare('DELETE FROM myr_nonces WHERE expires_at < ?')
      .run(new Date().toISOString());

    const timestamp = req.headers['x-myr-timestamp'];
    const nonce = req.headers['x-myr-nonce'];
    const signature = req.headers['x-myr-signature'];
    const publicKey = req.headers['x-myr-public-key'];

    if (!timestamp || !nonce || !signature || !publicKey) {
      return errorResponse(res, 'auth_required',
        'Missing or invalid authentication headers');
    }

    const requestTime = new Date(timestamp).getTime();
    if (isNaN(requestTime) || Date.now() - requestTime > MAX_AGE_MS) {
      return errorResponse(res, 'auth_required',
        'Missing or invalid authentication headers',
        'Request timestamp expired');
    }

    const existing = db.prepare('SELECT nonce FROM myr_nonces WHERE nonce = ?').get(nonce);
    if (existing) {
      return errorResponse(res, 'auth_required',
        'Missing or invalid authentication headers',
        'Nonce already used');
    }

    const bodyHash = hashBody(req.rawBody);
    const canonical = buildCanonicalRequest(req.method, req.path, timestamp, nonce, bodyHash);

    if (!verify(canonical, signature, publicKey)) {
      return errorResponse(res, 'auth_required',
        'Missing or invalid authentication headers',
        'Invalid signature');
    }

    const expiresAt = new Date(requestTime + NONCE_EXPIRY_MS).toISOString();
    db.prepare('INSERT INTO myr_nonces (nonce, seen_at, expires_at) VALUES (?, ?, ?)')
      .run(nonce, new Date().toISOString(), expiresAt);

    req.auth = { publicKey };
    next();
  };
}

module.exports = { createAuthMiddleware, buildCanonicalRequest, hashBody };
