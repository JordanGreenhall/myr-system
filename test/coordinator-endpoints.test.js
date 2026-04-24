'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair } = require('../lib/crypto');
const { authedRequest, request } = require('./helpers/peerRequest');

const trustedKeys = generateKeypair();
const unknownKeys = generateKeypair();

const TEST_CONFIG = {
  node_id: 'test-node',
  operator_name: 'testoperator',
  node_url: 'https://test.myr.network',
  port: 0,
};

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE myr_peers (
      id INTEGER PRIMARY KEY,
      peer_url TEXT UNIQUE NOT NULL,
      operator_name TEXT NOT NULL,
      public_key TEXT UNIQUE NOT NULL,
      trust_level TEXT CHECK(trust_level IN ('trusted', 'pending', 'introduced', 'revoked', 'rejected')) DEFAULT 'pending',
      added_at TEXT NOT NULL,
      approved_at TEXT,
      last_sync_at TEXT,
      auto_sync INTEGER DEFAULT 1,
      notes TEXT
    );

    CREATE TABLE myr_nonces (
      nonce TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX idx_nonces_expires ON myr_nonces(expires_at);
  `);

  db.prepare(`
    INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at)
    VALUES (?, ?, ?, 'trusted', ?, ?)
  `).run(
    'https://trusted.myr.network',
    'trusted-peer',
    trustedKeys.publicKey,
    '2026-03-01T10:00:00Z',
    '2026-03-01T10:00:00Z',
  );

  return db;
}

describe('Coordinator endpoints', () => {
  let server;
  let port;
  let db;

  before(() => {
    db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: 'ab'.repeat(32),
      createdAt: '2026-03-01T10:00:00Z',
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('requires auth for GET /myr/coordinator/domains', async () => {
    const { status, body } = await request(port, { path: '/myr/coordinator/domains' });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'auth_required');
  });

  it('requires trusted peer for GET /myr/coordinator/route', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/coordinator/route?domain=security',
      keys: unknownKeys,
    });
    assert.equal(status, 403);
    assert.equal(body.error.code, 'unknown_peer');
  });

  it('registers domains and returns routed peers for trusted callers', async () => {
    const register = await authedRequest(port, {
      method: 'POST',
      path: '/myr/coordinator/register',
      keys: trustedKeys,
      body: {
        domains: ['security', 'performance'],
        peer_url: 'https://trusted.myr.network',
      },
    });

    assert.equal(register.status, 200);
    assert.equal(register.body.status, 'ok');

    const route = await authedRequest(port, {
      path: '/myr/coordinator/route?domain=security',
      keys: trustedKeys,
    });

    assert.equal(route.status, 200);
    assert.equal(route.body.status, 'ok');
    assert.equal(route.body.domain, 'security');
    assert.equal(route.body.peerCount, 1);
    assert.equal(route.body.peers[0].publicKey, trustedKeys.publicKey);
  });

  it('rejects missing domain query on route endpoint', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/coordinator/route',
      keys: trustedKeys,
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
  });
});
