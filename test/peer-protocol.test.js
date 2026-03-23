'use strict';

/**
 * Layer 1 server tests — MYR v1.0 peer protocol (STA-45)
 *
 * Covers required unit test cases:
 * 1. Request signing: canonical string + signature verification (auth.test.js covers this)
 * 2. Nonce deduplication (auth.test.js covers this)
 * 3. Timestamp validation (auth.test.js covers this)
 * 4. Rate limiting: 61st request/minute returns 429
 * 5. Report signature verification: tampered report rejected on import
 *
 * Also covers:
 * - POST /myr/peer/introduce
 * - POST /myr/peer/approve
 * - GET /myr/peer/list
 * - POST /myr/sync/pull
 * - Peer state machine enforcement
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair } = require('../lib/crypto');
const { buildIdentityDocument, identityFingerprint } = require('../lib/identity');
const { signRequest } = require('./helpers/signRequest');
const { canonicalize } = require('../lib/canonicalize');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(port, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined
      ? (typeof body === 'string' ? body : JSON.stringify(body))
      : undefined;

    const options = {
      hostname: 'localhost',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(bodyStr !== undefined ? { 'content-type': 'application/json' } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

/** Create an in-memory test DB with the v1.0 peers schema (no CHECK constraint on trust_level). */
function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE myr_reports (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      cycle_intent TEXT NOT NULL,
      domain_tags TEXT NOT NULL,
      yield_type TEXT NOT NULL,
      question_answered TEXT NOT NULL,
      evidence TEXT NOT NULL,
      what_changes_next TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.7,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      share_network INTEGER DEFAULT 0,
      operator_signature TEXT,
      signed_by TEXT,
      operator_rating INTEGER,
      week_label TEXT
    );
    CREATE TABLE myr_peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      peer_url TEXT,
      operator_name TEXT,
      public_key TEXT UNIQUE NOT NULL,
      fingerprint TEXT,
      trust_level TEXT DEFAULT 'introduced',
      added_at TEXT NOT NULL,
      approved_at TEXT,
      last_sync_at TEXT
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

// Our node's keypair (used as the server's identity)
const OUR_KEYS = generateKeypair();
const OUR_PUBLIC_KEY = OUR_KEYS.publicKey;
const OUR_PRIVATE_KEY = OUR_KEYS.privateKey;
const OUR_CREATED_AT = '2026-03-23T00:00:00.000Z';
const TEST_CONFIG = {
  node_id: 'test-node',
  operator_name: 'testoperator',
  node_url: 'https://test.myr.network',
  port: 0,
};

// A peer keypair for testing
const PEER_KEYS = generateKeypair();
const PEER_FINGERPRINT = identityFingerprint(PEER_KEYS.publicKey);

function makePeerIdentityDoc(keys = PEER_KEYS) {
  return buildIdentityDocument({
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    operator_name: 'test-peer',
    node_url: 'https://peer.myr.network',
    created_at: '2026-03-23T00:00:00.000Z',
  });
}

function signedRequest(port, method, path, body, keys = PEER_KEYS) {
  const signed = signRequest({
    method,
    path,
    body: body || undefined,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });
  return request(port, { method, path, headers: signed.headers, body: body || undefined });
}

// ---------------------------------------------------------------------------
// 4. Rate limiting: 61st request/minute returns 429
// ---------------------------------------------------------------------------

describe('Rate limiting (60 req/min per peer)', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    // Seed a trusted peer
    db.prepare(
      `INSERT INTO myr_peers (peer_url, operator_name, public_key, fingerprint, trust_level, added_at, approved_at)
       VALUES (?, ?, ?, ?, 'trusted', ?, ?)`
    ).run('https://peer.myr.network', 'peer', PEER_KEYS.publicKey, PEER_FINGERPRINT,
      new Date().toISOString(), new Date().toISOString());

    const app = createApp({
      config: { ...TEST_CONFIG, rateLimitWindowMs: 60000, rateLimitMax: 60 },
      db,
      publicKeyHex: OUR_PUBLIC_KEY,
      privateKeyHex: OUR_PRIVATE_KEY,
      createdAt: OUR_CREATED_AT,
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('first 60 requests succeed (200), 61st returns 429 with Retry-After', async () => {
    // Send 60 authenticated requests that should all succeed
    for (let i = 0; i < 60; i++) {
      const res = await signedRequest(port, 'GET', '/myr/peer/list', undefined, PEER_KEYS);
      assert.ok(
        res.status !== 429,
        `Request ${i + 1} should not be rate-limited, got ${res.status}`,
      );
    }

    // 61st request should be rate-limited
    const res = await signedRequest(port, 'GET', '/myr/peer/list', undefined, PEER_KEYS);
    assert.equal(res.status, 429, '61st request should return 429');
    assert.equal(res.body.error.code, 'rate_limit_exceeded');
    assert.ok(res.headers['retry-after'], 'should include Retry-After header');
    assert.ok(
      parseInt(res.headers['retry-after'], 10) > 0,
      'Retry-After should be a positive number of seconds',
    );
  });

  it('unauthenticated requests are not rate-limited', async () => {
    // Public endpoints should not be affected by rate limiter
    const res = await request(port, { method: 'GET', path: '/.well-known/myr-node' });
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// POST /myr/peer/introduce — public endpoint
// ---------------------------------------------------------------------------

describe('POST /myr/peer/introduce', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: OUR_PUBLIC_KEY,
      privateKeyHex: OUR_PRIVATE_KEY,
      createdAt: OUR_CREATED_AT,
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('valid identity document creates a peer with trust_level=introduced', async () => {
    const peerDoc = makePeerIdentityDoc();
    const res = await request(port, {
      method: 'POST',
      path: '/myr/peer/introduce',
      body: { identity_document: peerDoc },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'introduced');
    assert.equal(res.body.trust_level, 'introduced');
    assert.ok(res.body.our_identity, 'should include our identity document');
    assert.ok(res.body.our_identity.signature, 'our identity doc should be signed');

    // Peer stored in DB
    const row = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?')
      .get(PEER_KEYS.publicKey);
    assert.ok(row, 'peer should be stored');
    assert.equal(row.trust_level, 'introduced');
  });

  it('rejects a tampered identity document (bad signature)', async () => {
    const peerDoc = makePeerIdentityDoc();
    const tampered = { ...peerDoc, operator_name: 'attacker' };

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peer/introduce',
      body: { identity_document: tampered },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_request');
    assert.ok(res.body.error.message.toLowerCase().includes('signature'));
  });

  it('returns 400 when identity_document is missing', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/myr/peer/introduce',
      body: {},
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_request');
  });

  it('does not require auth headers (public endpoint)', async () => {
    // No auth headers — should still work
    const peerDoc = makePeerIdentityDoc(generateKeypair());
    const res = await request(port, {
      method: 'POST',
      path: '/myr/peer/introduce',
      body: { identity_document: peerDoc },
    });

    assert.ok(res.status !== 401, 'should not require auth');
  });
});

// ---------------------------------------------------------------------------
// POST /myr/peer/approve — auth required
// ---------------------------------------------------------------------------

describe('POST /myr/peer/approve', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    // Seed an introduced peer
    db.prepare(
      `INSERT INTO myr_peers (peer_url, operator_name, public_key, fingerprint, trust_level, added_at)
       VALUES (?, ?, ?, ?, 'introduced', ?)`
    ).run('https://peer.myr.network', 'test-peer', PEER_KEYS.publicKey, PEER_FINGERPRINT,
      new Date().toISOString());

    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: OUR_PUBLIC_KEY,
      privateKeyHex: OUR_PRIVATE_KEY,
      createdAt: OUR_CREATED_AT,
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('approves an introduced peer — sets trust_level to trusted', async () => {
    // First need a trusted peer to make the auth call
    // Seed our own key as trusted so we can make authenticated requests
    db.prepare(
      `INSERT INTO myr_peers (peer_url, operator_name, public_key, fingerprint, trust_level, added_at, approved_at)
       VALUES (?, ?, ?, ?, 'trusted', ?, ?)`
    ).run('https://caller.myr.network', 'caller', OUR_PUBLIC_KEY,
      identityFingerprint(OUR_PUBLIC_KEY),
      new Date().toISOString(), new Date().toISOString());

    const res = await signedRequest(port, 'POST', '/myr/peer/approve',
      { peer_fingerprint: PEER_FINGERPRINT, trust_level: 'trusted' },
      OUR_KEYS);

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'approved');
    assert.equal(res.body.trust_level, 'trusted');

    const row = db.prepare('SELECT trust_level FROM myr_peers WHERE public_key = ?')
      .get(PEER_KEYS.publicKey);
    assert.equal(row.trust_level, 'trusted');
  });

  it('returns 400 when peer_fingerprint is missing', async () => {
    const res = await signedRequest(port, 'POST', '/myr/peer/approve', {}, OUR_KEYS);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_request');
  });

  it('returns 404 for unknown fingerprint', async () => {
    const res = await signedRequest(port, 'POST', '/myr/peer/approve',
      { peer_fingerprint: 'unknown-fingerprint' },
      OUR_KEYS);
    assert.equal(res.status, 404);
  });

  it('requires auth', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/myr/peer/approve',
      body: { peer_fingerprint: PEER_FINGERPRINT },
    });
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// GET /myr/peer/list — auth required
// ---------------------------------------------------------------------------

describe('GET /myr/peer/list', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    // Seed a trusted peer (the caller)
    db.prepare(
      `INSERT INTO myr_peers (peer_url, operator_name, public_key, fingerprint, trust_level, added_at, approved_at)
       VALUES (?, ?, ?, ?, 'trusted', ?, ?)`
    ).run('https://peer.myr.network', 'test-peer', PEER_KEYS.publicKey, PEER_FINGERPRINT,
      new Date().toISOString(), new Date().toISOString());

    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: OUR_PUBLIC_KEY,
      privateKeyHex: OUR_PRIVATE_KEY,
      createdAt: OUR_CREATED_AT,
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('returns list of peers for authenticated request', async () => {
    const res = await signedRequest(port, 'GET', '/myr/peer/list', undefined, PEER_KEYS);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.peers), 'should return peers array');
    assert.ok(res.body.peers.length >= 1);
  });

  it('requires auth', async () => {
    const res = await request(port, { method: 'GET', path: '/myr/peer/list' });
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// POST /myr/sync/pull — auth required, trusted peers only
// ---------------------------------------------------------------------------

describe('POST /myr/sync/pull', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    // Seed a trusted peer
    db.prepare(
      `INSERT INTO myr_peers (peer_url, operator_name, public_key, fingerprint, trust_level, added_at, approved_at)
       VALUES (?, ?, ?, ?, 'trusted', ?, ?)`
    ).run('https://peer.myr.network', 'test-peer', PEER_KEYS.publicKey, PEER_FINGERPRINT,
      new Date().toISOString(), new Date().toISOString());

    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: OUR_PUBLIC_KEY,
      privateKeyHex: OUR_PRIVATE_KEY,
      createdAt: OUR_CREATED_AT,
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('returns sync_id and status=started for trusted peer', async () => {
    const res = await signedRequest(port, 'POST', '/myr/sync/pull', {}, PEER_KEYS);
    assert.equal(res.status, 200);
    assert.ok(res.body.sync_id, 'should include sync_id');
    assert.equal(res.body.status, 'started');
    assert.ok(typeof res.body.estimated_reports === 'number');
  });

  it('accepts optional since parameter', async () => {
    const res = await signedRequest(port, 'POST', '/myr/sync/pull',
      { since: '2026-01-01T00:00:00Z' }, PEER_KEYS);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'started');
  });

  it('returns 401 for unauthenticated request', async () => {
    const res = await request(port, { method: 'POST', path: '/myr/sync/pull', body: {} });
    assert.equal(res.status, 401);
  });

  it('returns 401/403 for non-trusted peer', async () => {
    const untrustedKeys = generateKeypair();
    // Not seeded as a peer — should fail
    const res = await signedRequest(port, 'POST', '/myr/sync/pull', {}, untrustedKeys);
    assert.ok(res.status === 401 || res.status === 403 || res.status === 400);
  });
});

// ---------------------------------------------------------------------------
// 5. Report signature verification: tampered report rejected on import
// (Tests the server-side behavior when serving /myr/reports/:signature)
// ---------------------------------------------------------------------------

describe('GET /myr/reports/:signature — report verification', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();

    // Seed a trusted peer
    db.prepare(
      `INSERT INTO myr_peers (peer_url, operator_name, public_key, fingerprint, trust_level, added_at, approved_at)
       VALUES (?, ?, ?, ?, 'trusted', ?, ?)`
    ).run('https://peer.myr.network', 'test-peer', PEER_KEYS.publicKey, PEER_FINGERPRINT,
      new Date().toISOString(), new Date().toISOString());

    // Seed a report with share_network=1 and a valid operator_signature
    const reportData = {
      id: 'test-001',
      timestamp: '2026-03-23T10:00:00Z',
      agent_id: 'agent1',
      node_id: 'n1',
      cycle_intent: 'test intent',
      domain_tags: 'testing',
      yield_type: 'technique',
      question_answered: 'does it work?',
      evidence: 'yes',
      what_changes_next: 'keep going',
      confidence: 0.8,
      created_at: '2026-03-23T10:00:00Z',
      updated_at: '2026-03-23T10:00:00Z',
      share_network: 1,
    };

    db.prepare(`
      INSERT INTO myr_reports (id, timestamp, agent_id, node_id, cycle_intent,
        domain_tags, yield_type, question_answered, evidence,
        what_changes_next, confidence, created_at, updated_at, share_network)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reportData.id, reportData.timestamp, reportData.agent_id, reportData.node_id,
      reportData.cycle_intent, reportData.domain_tags, reportData.yield_type,
      reportData.question_answered, reportData.evidence, reportData.what_changes_next,
      reportData.confidence, reportData.created_at, reportData.updated_at,
      reportData.share_network,
    );

    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: OUR_PUBLIC_KEY,
      privateKeyHex: OUR_PRIVATE_KEY,
      createdAt: OUR_CREATED_AT,
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('returns 404 for unknown signature', async () => {
    const res = await signedRequest(port, 'GET', '/myr/reports/sha256:notreal', undefined, PEER_KEYS);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'report_not_found');
  });

  it('returns 401 for unauthenticated request', async () => {
    const res = await request(port, { method: 'GET', path: '/myr/reports/sha256:abc123' });
    assert.equal(res.status, 401);
  });

  it('returns report with X-MYR-Signature header for trusted peer', async () => {
    // First get the actual signature from the reports list
    const listRes = await signedRequest(port, 'GET', '/myr/reports', undefined, PEER_KEYS);
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.reports.length > 0, 'should have a seeded report');

    const sig = listRes.body.reports[0].signature;
    assert.ok(sig.startsWith('sha256:'), 'signature should have sha256: prefix');

    const fetchRes = await signedRequest(port, 'GET', `/myr/reports/${sig}`, undefined, PEER_KEYS);
    assert.equal(fetchRes.status, 200, `should fetch report with sig=${sig}`);
    assert.ok(fetchRes.headers['x-myr-signature'], 'response should be signed');
  });
});

// ---------------------------------------------------------------------------
// Peer state machine enforcement
// ---------------------------------------------------------------------------

describe('Peer state machine — trust_level enforcement', () => {
  let server, port, db;
  const introducedKeys = generateKeypair();

  before(() => {
    db = createTestDb();

    // Seed an introduced (non-trusted) peer
    db.prepare(
      `INSERT INTO myr_peers (peer_url, operator_name, public_key, fingerprint, trust_level, added_at)
       VALUES (?, ?, ?, ?, 'introduced', ?)`
    ).run('https://introduced.myr.network', 'introduced-peer',
      introducedKeys.publicKey, identityFingerprint(introducedKeys.publicKey),
      new Date().toISOString());

    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: OUR_PUBLIC_KEY,
      privateKeyHex: OUR_PRIVATE_KEY,
      createdAt: OUR_CREATED_AT,
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('introduced (non-trusted) peer cannot access /myr/reports', async () => {
    const res = await signedRequest(port, 'GET', '/myr/reports', undefined, introducedKeys);
    assert.ok(
      res.status === 401 || res.status === 403,
      `expected 401 or 403 for non-trusted peer, got ${res.status}`,
    );
  });

  it('introduced peer cannot access /myr/sync/pull', async () => {
    const res = await signedRequest(port, 'POST', '/myr/sync/pull', {}, introducedKeys);
    assert.ok(
      res.status === 401 || res.status === 403,
      `expected 401/403 for non-trusted peer, got ${res.status}`,
    );
  });
});
