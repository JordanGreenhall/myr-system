'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair, sign, verify } = require('../lib/crypto');
const { buildIdentityDocument, verifyIdentityDocument, identityFingerprint } = require('../lib/identity');
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
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: JSON.parse(data),
          });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
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
      signed_by TEXT,
      operator_signature TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      share_network INTEGER DEFAULT 0,
      week_label TEXT
    );

    CREATE TABLE myr_peers (
      id INTEGER PRIMARY KEY,
      peer_url TEXT NOT NULL DEFAULT '',
      operator_name TEXT NOT NULL DEFAULT '',
      public_key TEXT UNIQUE NOT NULL,
      fingerprint TEXT,
      trust_level TEXT DEFAULT 'pending',
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

const serverKeys = generateKeypair();
const peerKeys = generateKeypair();

const TEST_CONFIG = {
  node_id: 'test-node',
  operator_name: 'testoperator',
  node_url: 'https://test.myr.network',
  port: 0,
};

const TEST_CREATED_AT = '2026-03-01T10:00:00Z';

// ---------------------------------------------------------------------------
// 1. Request signing: canonical string construction, sig verification
// ---------------------------------------------------------------------------

describe('request signing (v1.0)', () => {
  it('canonical string has 5 newline-separated components', () => {
    const bodyHash = crypto.createHash('sha256').update('{"test":1}').digest('hex');
    const result = buildCanonicalRequest('POST', '/myr/peer/introduce', '2026-03-23T00:00:00Z', 'abc123', bodyHash);
    const parts = result.split('\n');
    assert.equal(parts.length, 5);
    assert.equal(parts[0], 'POST');
    assert.equal(parts[1], '/myr/peer/introduce');
    assert.equal(parts[2], '2026-03-23T00:00:00Z');
    assert.equal(parts[3], 'abc123');
    assert.equal(parts[4], bodyHash);
  });

  it('signed request is verified by the auth middleware', async () => {
    const db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: serverKeys.publicKey,
      privateKeyHex: serverKeys.privateKey,
      createdAt: TEST_CREATED_AT,
    });

    // Add a test-only route after auth middleware
    app.get('/myr/test-auth', (req, res) => {
      res.json({ ok: true, publicKey: req.auth.publicKey });
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const signed = signRequest({
        method: 'GET',
        path: '/myr/test-auth',
        privateKey: peerKeys.privateKey,
        publicKey: peerKeys.publicKey,
      });

      const { status, body } = await request(port, {
        path: '/myr/test-auth',
        headers: signed.headers,
      });

      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.publicKey, peerKeys.publicKey);
    } finally {
      server.close();
      db.close();
    }
  });

  it('invalid signature is rejected', async () => {
    const db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: serverKeys.publicKey,
      privateKeyHex: serverKeys.privateKey,
      createdAt: TEST_CREATED_AT,
    });

    app.get('/myr/test-auth', (req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const signed = signRequest({
        method: 'GET',
        path: '/myr/test-auth',
        privateKey: peerKeys.privateKey,
        publicKey: peerKeys.publicKey,
      });

      signed.headers['x-myr-signature'] = 'ff'.repeat(64);

      const { status } = await request(port, {
        path: '/myr/test-auth',
        headers: signed.headers,
      });

      assert.equal(status, 401);
    } finally {
      server.close();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Nonce deduplication: same nonce rejected on second use
// ---------------------------------------------------------------------------

describe('nonce deduplication (v1.0)', () => {
  it('same nonce on second request returns 401', async () => {
    const db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: serverKeys.publicKey,
      privateKeyHex: serverKeys.privateKey,
      createdAt: TEST_CREATED_AT,
    });

    app.get('/myr/test-nonce', (req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const fixedNonce = crypto.randomBytes(32).toString('hex');

      const signed1 = signRequest({
        method: 'GET',
        path: '/myr/test-nonce',
        privateKey: peerKeys.privateKey,
        publicKey: peerKeys.publicKey,
        nonce: fixedNonce,
      });

      const { status: s1 } = await request(port, {
        path: '/myr/test-nonce',
        headers: signed1.headers,
      });
      assert.equal(s1, 200);

      // Same nonce again
      const signed2 = signRequest({
        method: 'GET',
        path: '/myr/test-nonce',
        privateKey: peerKeys.privateKey,
        publicKey: peerKeys.publicKey,
        nonce: fixedNonce,
      });

      const { status: s2, body } = await request(port, {
        path: '/myr/test-nonce',
        headers: signed2.headers,
      });

      assert.equal(s2, 401);
      assert.ok(body.error.details.includes('Nonce'));
    } finally {
      server.close();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Timestamp validation: >5min old requests rejected
// ---------------------------------------------------------------------------

describe('timestamp validation (v1.0)', () => {
  it('request with timestamp >5 minutes old is rejected', async () => {
    const db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: serverKeys.publicKey,
      privateKeyHex: serverKeys.privateKey,
      createdAt: TEST_CREATED_AT,
    });

    app.get('/myr/test-ts', (req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const oldTimestamp = new Date(Date.now() - 6 * 60 * 1000).toISOString();

      const signed = signRequest({
        method: 'GET',
        path: '/myr/test-ts',
        privateKey: peerKeys.privateKey,
        publicKey: peerKeys.publicKey,
        timestamp: oldTimestamp,
      });

      const { status, body } = await request(port, {
        path: '/myr/test-ts',
        headers: signed.headers,
      });

      assert.equal(status, 401);
      assert.ok(body.error.details.includes('expired'));
    } finally {
      server.close();
      db.close();
    }
  });

  it('request with fresh timestamp is accepted', async () => {
    const db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: serverKeys.publicKey,
      privateKeyHex: serverKeys.privateKey,
      createdAt: TEST_CREATED_AT,
    });

    app.get('/myr/test-ts2', (req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const signed = signRequest({
        method: 'GET',
        path: '/myr/test-ts2',
        privateKey: peerKeys.privateKey,
        publicKey: peerKeys.publicKey,
      });

      const { status } = await request(port, {
        path: '/myr/test-ts2',
        headers: signed.headers,
      });

      assert.equal(status, 200);
    } finally {
      server.close();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Rate limiting: 61st request/minute returns 429
// ---------------------------------------------------------------------------

describe('rate limiting (v1.0)', () => {
  it('61st request in a window returns 429 with Retry-After header', async () => {
    const db = createTestDb();
    // Set rate limit to 5 for fast testing
    const app = createApp({
      config: { ...TEST_CONFIG, rateLimitMax: 5, rateLimitWindowMs: 60000 },
      db,
      publicKeyHex: serverKeys.publicKey,
      privateKeyHex: serverKeys.privateKey,
      createdAt: TEST_CREATED_AT,
    });

    app.get('/myr/test-rate', (req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    const port = server.address().port;

    try {
      // Send 5 requests (should all succeed)
      for (let i = 0; i < 5; i++) {
        const signed = signRequest({
          method: 'GET',
          path: '/myr/test-rate',
          privateKey: peerKeys.privateKey,
          publicKey: peerKeys.publicKey,
        });

        const { status } = await request(port, {
          path: '/myr/test-rate',
          headers: signed.headers,
        });
        assert.equal(status, 200, `request ${i + 1} should succeed`);
      }

      // 6th request should be rate-limited
      const signed6 = signRequest({
        method: 'GET',
        path: '/myr/test-rate',
        privateKey: peerKeys.privateKey,
        publicKey: peerKeys.publicKey,
      });

      const { status, headers, body } = await request(port, {
        path: '/myr/test-rate',
        headers: signed6.headers,
      });

      assert.equal(status, 429);
      assert.ok(headers['retry-after'], 'should include Retry-After header');
      assert.equal(body.error.code, 'rate_limit_exceeded');
    } finally {
      server.close();
      db.close();
    }
  });

  it('different peers have independent rate limits', async () => {
    const db = createTestDb();
    const peer2Keys = generateKeypair();

    const app = createApp({
      config: { ...TEST_CONFIG, rateLimitMax: 2, rateLimitWindowMs: 60000 },
      db,
      publicKeyHex: serverKeys.publicKey,
      privateKeyHex: serverKeys.privateKey,
      createdAt: TEST_CREATED_AT,
    });

    app.get('/myr/test-rate2', (req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    const port = server.address().port;

    try {
      // Exhaust peer1's limit
      for (let i = 0; i < 2; i++) {
        const signed = signRequest({
          method: 'GET',
          path: '/myr/test-rate2',
          privateKey: peerKeys.privateKey,
          publicKey: peerKeys.publicKey,
        });
        await request(port, { path: '/myr/test-rate2', headers: signed.headers });
      }

      // peer1's 3rd request should fail
      const signedFail = signRequest({
        method: 'GET',
        path: '/myr/test-rate2',
        privateKey: peerKeys.privateKey,
        publicKey: peerKeys.publicKey,
      });
      const { status: failStatus } = await request(port, {
        path: '/myr/test-rate2',
        headers: signedFail.headers,
      });
      assert.equal(failStatus, 429);

      // peer2's first request should still succeed
      const signedPeer2 = signRequest({
        method: 'GET',
        path: '/myr/test-rate2',
        privateKey: peer2Keys.privateKey,
        publicKey: peer2Keys.publicKey,
      });
      const { status: peer2Status } = await request(port, {
        path: '/myr/test-rate2',
        headers: signedPeer2.headers,
      });
      assert.equal(peer2Status, 200);
    } finally {
      server.close();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Report signature verification: tampered report rejected on import
// ---------------------------------------------------------------------------

describe('report signature verification (v1.0)', () => {
  it('identity document with tampered fields is rejected by introduce endpoint', async () => {
    const db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: serverKeys.publicKey,
      privateKeyHex: serverKeys.privateKey,
      createdAt: TEST_CREATED_AT,
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      // Build a valid identity document, then tamper with it
      const doc = buildIdentityDocument({
        publicKey: peerKeys.publicKey,
        privateKey: peerKeys.privateKey,
        operator_name: 'legitimate-peer',
        node_url: 'https://legit.myr.network',
      });

      // Tamper: change operator_name after signing
      const tampered = { ...doc, operator_name: 'evil-attacker' };

      const { status, body } = await request(port, {
        method: 'POST',
        path: '/myr/peer/introduce',
        body: { identity_document: tampered },
      });

      assert.equal(status, 400);
      assert.ok(body.error.message.includes('signature verification failed'));
    } finally {
      server.close();
      db.close();
    }
  });

  it('valid identity document is accepted by introduce endpoint', async () => {
    const db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: serverKeys.publicKey,
      privateKeyHex: serverKeys.privateKey,
      createdAt: TEST_CREATED_AT,
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const doc = buildIdentityDocument({
        publicKey: peerKeys.publicKey,
        privateKey: peerKeys.privateKey,
        operator_name: 'legitimate-peer',
        node_url: 'https://legit.myr.network',
      });

      const { status, body } = await request(port, {
        method: 'POST',
        path: '/myr/peer/introduce',
        body: { identity_document: doc },
      });

      assert.equal(status, 200);
      assert.equal(body.status, 'introduced');
      assert.equal(body.trust_level, 'introduced');
      assert.ok(body.our_identity, 'should return our identity document');
      assert.ok(verifyIdentityDocument(body.our_identity), 'our identity doc should verify');
    } finally {
      server.close();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// V1.0 discovery and health endpoints
// ---------------------------------------------------------------------------

describe('v1.0 discovery endpoint', () => {
  it('returns protocol_version 1.0.0 with fingerprint and capabilities', async () => {
    const db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: serverKeys.publicKey,
      privateKeyHex: serverKeys.privateKey,
      createdAt: TEST_CREATED_AT,
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const { status, body } = await request(port, { path: '/.well-known/myr-node' });

      assert.equal(status, 200);
      assert.equal(body.protocol_version, '1.0.0');
      assert.equal(body.public_key, serverKeys.publicKey);
      assert.equal(body.fingerprint, identityFingerprint(serverKeys.publicKey));
      assert.deepEqual(body.capabilities, ['report-sync', 'peer-discovery', 'incremental-sync']);
      assert.equal(body.operator_name, 'testoperator');
      assert.equal(body.node_url, 'https://test.myr.network');
    } finally {
      server.close();
      db.close();
    }
  });
});

describe('v1.0 health endpoint with liveness signature', () => {
  it('includes liveness_signature that verifies against public key', async () => {
    const db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: serverKeys.publicKey,
      privateKeyHex: serverKeys.privateKey,
      createdAt: TEST_CREATED_AT,
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const { status, body } = await request(port, { path: '/myr/health' });

      assert.equal(status, 200);
      assert.equal(body.status, 'ok');
      assert.ok(body.public_key, 'should include public_key');
      assert.ok(body.timestamp, 'should include timestamp');
      assert.ok(body.nonce, 'should include nonce');
      assert.ok(body.liveness_signature, 'should include liveness_signature');

      // Verify the liveness signature
      const isValid = verify(
        body.timestamp + body.nonce,
        body.liveness_signature,
        body.public_key,
      );
      assert.ok(isValid, 'liveness_signature should verify against public key');

      // Timestamp should be fresh (within 5 seconds)
      const ts = new Date(body.timestamp).getTime();
      assert.ok(Date.now() - ts < 5000, 'timestamp should be fresh');
    } finally {
      server.close();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Peer introduce + approve flow
// ---------------------------------------------------------------------------

describe('peer introduce + approve flow (v1.0)', () => {
  it('full introduce → approve flow works', async () => {
    const db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: serverKeys.publicKey,
      privateKeyHex: serverKeys.privateKey,
      createdAt: TEST_CREATED_AT,
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      // Step 1: Introduce
      const peerDoc = buildIdentityDocument({
        publicKey: peerKeys.publicKey,
        privateKey: peerKeys.privateKey,
        operator_name: 'test-peer',
        node_url: 'https://test-peer.myr.network',
      });

      const { status: introStatus, body: introBody } = await request(port, {
        method: 'POST',
        path: '/myr/peer/introduce',
        body: { identity_document: peerDoc },
      });

      assert.equal(introStatus, 200);
      assert.equal(introBody.trust_level, 'introduced');

      // Step 2: Approve (requires auth)
      const peerFingerprint = identityFingerprint(peerKeys.publicKey);

      const signed = signRequest({
        method: 'POST',
        path: '/myr/peer/approve',
        body: JSON.stringify({ peer_fingerprint: peerFingerprint, trust_level: 'trusted' }),
        privateKey: peerKeys.privateKey,
        publicKey: peerKeys.publicKey,
      });

      const { status: approveStatus, body: approveBody } = await request(port, {
        method: 'POST',
        path: '/myr/peer/approve',
        headers: signed.headers,
        body: { peer_fingerprint: peerFingerprint, trust_level: 'trusted' },
      });

      assert.equal(approveStatus, 200);
      assert.equal(approveBody.status, 'approved');
      assert.equal(approveBody.trust_level, 'trusted');

      // Verify peer is now trusted in DB
      const peer = db.prepare('SELECT trust_level FROM myr_peers WHERE public_key = ?').get(peerKeys.publicKey);
      assert.equal(peer.trust_level, 'trusted');
    } finally {
      server.close();
      db.close();
    }
  });
});
