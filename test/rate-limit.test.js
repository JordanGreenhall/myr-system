'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair, fingerprint: computeFingerprint } = require('../lib/crypto');

function request(port, { method = 'GET', path = '/', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost',
      port,
      path,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = raw;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function createMinimalDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE myr_peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      peer_url TEXT,
      operator_name TEXT,
      public_key TEXT UNIQUE NOT NULL,
      trust_level TEXT DEFAULT 'pending',
      added_at TEXT NOT NULL,
      approved_at TEXT,
      notes TEXT
    );
    CREATE TABLE myr_nonces (
      nonce TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  return db;
}

async function withRateLimitServer(run) {
  const db = createMinimalDb();
  const localKeys = generateKeypair();
  const app = createApp({
    config: {
      node_id: 'rl-node',
      node_name: 'Rate Limit Node',
      operator_name: 'rate-limit-operator',
      node_url: 'http://localhost:0',
      port: 0,
      rate_limit: {
        unauthenticated_requests_per_minute: 30,
      },
    },
    db,
    publicKeyHex: localKeys.publicKey,
    privateKeyHex: localKeys.privateKey,
    createdAt: '2026-04-24T00:00:00Z',
  });

  const server = app.listen(0);
  const port = server.address().port;
  try {
    await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}

describe('unauthenticated endpoint rate limiting', () => {
  it('returns 429 on the 31st request to /myr/health within one minute', async () => {
    await withRateLimitServer(async (port) => {
      for (let i = 0; i < 30; i++) {
        const res = await request(port, { path: '/myr/health' });
        assert.equal(res.status, 200);
      }

      const overLimit = await request(port, { path: '/myr/health' });
      assert.equal(overLimit.status, 429);
      assert.equal(overLimit.body.error.code, 'rate_limit_exceeded');
      assert.ok(overLimit.headers['retry-after']);
    });
  });

  it('returns 429 on the 31st request to /myr/peer/introduce within one minute', async () => {
    await withRateLimitServer(async (port) => {
      const peerKeys = generateKeypair();
      const body = {
        identity_document: {
          public_key: peerKeys.publicKey,
          operator_name: 'peer-a',
          node_url: 'https://peer-a.example',
          fingerprint: computeFingerprint(peerKeys.publicKey),
          protocol_version: '1.2.0',
        },
      };

      for (let i = 0; i < 30; i++) {
        const res = await request(port, { method: 'POST', path: '/myr/peer/introduce', body });
        assert.equal(res.status, 200);
      }

      const overLimit = await request(port, { method: 'POST', path: '/myr/peer/introduce', body });
      assert.equal(overLimit.status, 429);
      assert.equal(overLimit.body.error.code, 'rate_limit_exceeded');
    });
  });
});
