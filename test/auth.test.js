'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair } = require('../lib/crypto');
const { signRequest } = require('./helpers/signRequest');
const { buildCanonicalRequest, hashBody } = require('../server/middleware/auth');

// --- helpers ---

function request(port, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE myr_reports (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      session_ref TEXT,
      cycle_intent TEXT NOT NULL,
      domain_tags TEXT NOT NULL,
      yield_type TEXT NOT NULL,
      question_answered TEXT NOT NULL,
      evidence TEXT NOT NULL,
      what_changes_next TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.7,
      operator_rating INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      share_network INTEGER DEFAULT 0
    );

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

  return db;
}

const TEST_CONFIG = {
  node_id: 'test-node',
  operator_name: 'testoperator',
  node_url: 'https://test.myr.network',
  port: 0,
};

const TEST_PUBLIC_KEY_HEX = 'ab'.repeat(32);
const TEST_CREATED_AT = '2026-03-01T10:00:00Z';

const testKeys = generateKeypair();

// --- tests ---

describe('Authentication middleware', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      createdAt: TEST_CREATED_AT,
    });

    app.get('/myr/test-protected', (req, res) => {
      res.json({ ok: true, auth: req.auth });
    });

    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('valid authenticated request succeeds', async () => {
    const signed = signRequest({
      method: 'GET',
      path: '/myr/test-protected',
      privateKey: testKeys.privateKey,
      publicKey: testKeys.publicKey,
    });

    const { status, body } = await request(port, {
      path: '/myr/test-protected',
      headers: signed.headers,
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.auth.publicKey, testKeys.publicKey);
  });

  it('missing headers returns 401', async () => {
    const { status, body } = await request(port, {
      path: '/myr/test-protected',
    });

    assert.equal(status, 401);
    assert.equal(body.error.code, 'auth_required');
  });

  it('partial headers returns 401', async () => {
    const { status, body } = await request(port, {
      path: '/myr/test-protected',
      headers: { 'x-myr-timestamp': new Date().toISOString() },
    });

    assert.equal(status, 401);
    assert.equal(body.error.code, 'auth_required');
  });

  it('expired timestamp (>5 min old) returns 401', async () => {
    const oldTimestamp = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const signed = signRequest({
      method: 'GET',
      path: '/myr/test-protected',
      privateKey: testKeys.privateKey,
      publicKey: testKeys.publicKey,
      timestamp: oldTimestamp,
    });

    const { status, body } = await request(port, {
      path: '/myr/test-protected',
      headers: signed.headers,
    });

    assert.equal(status, 401);
    assert.ok(body.error.details.includes('expired'));
  });

  it('replayed nonce returns 401', async () => {
    const fixedNonce = crypto.randomBytes(32).toString('hex');

    const signed1 = signRequest({
      method: 'GET',
      path: '/myr/test-protected',
      privateKey: testKeys.privateKey,
      publicKey: testKeys.publicKey,
      nonce: fixedNonce,
    });

    const { status: s1 } = await request(port, {
      path: '/myr/test-protected',
      headers: signed1.headers,
    });
    assert.equal(s1, 200);

    const signed2 = signRequest({
      method: 'GET',
      path: '/myr/test-protected',
      privateKey: testKeys.privateKey,
      publicKey: testKeys.publicKey,
      nonce: fixedNonce,
    });

    const { status: s2, body } = await request(port, {
      path: '/myr/test-protected',
      headers: signed2.headers,
    });

    assert.equal(s2, 401);
    assert.ok(body.error.details.includes('Nonce'));
  });

  it('invalid signature returns 401', async () => {
    const signed = signRequest({
      method: 'GET',
      path: '/myr/test-protected',
      privateKey: testKeys.privateKey,
      publicKey: testKeys.publicKey,
    });

    signed.headers['x-myr-signature'] = 'ff'.repeat(64);

    const { status, body } = await request(port, {
      path: '/myr/test-protected',
      headers: signed.headers,
    });

    assert.equal(status, 401);
    assert.ok(body.error.details.includes('signature'));
  });

  it('nonce cleanup removes expired nonces on every request', async () => {
    db.prepare('INSERT INTO myr_nonces (nonce, seen_at, expires_at) VALUES (?, ?, ?)')
      .run('expired-test-nonce', '2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z');

    const beforeCleanup = db.prepare('SELECT nonce FROM myr_nonces WHERE nonce = ?')
      .get('expired-test-nonce');
    assert.ok(beforeCleanup);

    const signed = signRequest({
      method: 'GET',
      path: '/myr/test-protected',
      privateKey: testKeys.privateKey,
      publicKey: testKeys.publicKey,
    });

    await request(port, {
      path: '/myr/test-protected',
      headers: signed.headers,
    });

    const afterCleanup = db.prepare('SELECT nonce FROM myr_nonces WHERE nonce = ?')
      .get('expired-test-nonce');
    assert.equal(afterCleanup, undefined);
  });
});

describe('Canonical request string construction', () => {
  it('constructs correct canonical string format', () => {
    const emptyBodyHash = crypto.createHash('sha256').update('').digest('hex');
    const result = buildCanonicalRequest(
      'GET', '/myr/reports', '2026-03-02T10:00:00Z', 'abc123', emptyBodyHash,
    );

    const expected = `GET\n/myr/reports\n2026-03-02T10:00:00Z\nabc123\n${emptyBodyHash}`;
    assert.equal(result, expected);
  });

  it('includes all five components separated by newlines', () => {
    const result = buildCanonicalRequest('POST', '/myr/peers/announce', 'ts', 'nc', 'bh');
    const parts = result.split('\n');
    assert.equal(parts.length, 5);
    assert.equal(parts[0], 'POST');
    assert.equal(parts[1], '/myr/peers/announce');
    assert.equal(parts[2], 'ts');
    assert.equal(parts[3], 'nc');
    assert.equal(parts[4], 'bh');
  });

  it('hashBody returns SHA-256 of empty string for undefined/empty', () => {
    const expected = crypto.createHash('sha256').update('').digest('hex');
    assert.equal(hashBody(undefined), expected);
    assert.equal(hashBody(''), expected);
    assert.equal(hashBody(null), expected);
  });

  it('hashBody returns SHA-256 of body content', () => {
    const body = '{"test":"data"}';
    const expected = crypto.createHash('sha256').update(body).digest('hex');
    assert.equal(hashBody(body), expected);
  });
});

describe('Public endpoints bypass auth', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      createdAt: TEST_CREATED_AT,
    });

    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('/.well-known/myr-node does not require auth', async () => {
    const { status } = await request(port, { path: '/.well-known/myr-node' });
    assert.equal(status, 200);
  });

  it('/myr/health does not require auth', async () => {
    const { status } = await request(port, { path: '/myr/health' });
    assert.equal(status, 200);
  });
});
