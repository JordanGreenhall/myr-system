'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const crypto = require('crypto');
const { generateKeypair, fingerprint: computeFingerprint } = require('../lib/crypto');
const { signRequest } = require('./helpers/signRequest');

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
      trust_level TEXT CHECK(trust_level IN ('trusted', 'pending', 'introduced', 'revoked', 'rejected', 'verified-pending-approval')) DEFAULT 'pending',
      added_at TEXT NOT NULL,
      approved_at TEXT,
      last_sync_at TEXT,
      auto_sync INTEGER DEFAULT 1,
      notes TEXT,
      node_uuid TEXT,
      verification_evidence TEXT,
      auto_approved INTEGER DEFAULT 0
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

const OUR_PUBLIC_KEY_HEX = 'ab'.repeat(32);
const OUR_CREATED_AT = '2026-03-01T10:00:00Z';
const TEST_CONFIG = {
  node_id: 'test-node',
  operator_name: 'testoperator',
  node_url: 'https://test.myr.network',
  port: 0,
};

const peerKeys = generateKeypair();

function makeAnnounceBody(overrides = {}) {
  return {
    peer_url: 'https://newpeer.myr.network',
    public_key: peerKeys.publicKey,
    operator_name: 'newpeer',
    timestamp: new Date().toISOString(),
    nonce: crypto.randomBytes(32).toString('hex'),
    ...overrides,
  };
}

describe('POST /myr/peers/announce', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: OUR_PUBLIC_KEY_HEX,
      createdAt: OUR_CREATED_AT,
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('announce from non-registry peer returns 403 forbidden', async () => {
    const body = makeAnnounceBody();
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: peerKeys.privateKey,
      publicKey: peerKeys.publicKey,
    });

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    // Since the test keypair is not in the signed node registry,
    // the announce endpoint rejects with 403.
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
  });

  it('non-registry peer not stored in database', async () => {
    const peerKeys2 = generateKeypair();
    const body = makeAnnounceBody({
      public_key: peerKeys2.publicKey,
      operator_name: 'peer2',
      peer_url: 'https://peer2.myr.network',
    });
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: peerKeys2.privateKey,
      publicKey: peerKeys2.publicKey,
    });

    await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    const row = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?')
      .get(peerKeys2.publicKey);
    assert.equal(row, undefined, 'non-registry peer should not be stored');
  });

  it('non-registry peer gets no public key in response', async () => {
    const peerKeys3 = generateKeypair();
    const body = makeAnnounceBody({
      public_key: peerKeys3.publicKey,
      operator_name: 'peer3',
      peer_url: 'https://peer3.myr.network',
    });
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: peerKeys3.privateKey,
      publicKey: peerKeys3.publicKey,
    });

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    assert.equal(res.status, 403);
    // Should not leak our public key on rejection
    assert.ok(!res.body.our_public_key, 'should not expose our_public_key on 403');
  });

  it('400 key_mismatch when body and header keys differ', async () => {
    const otherKeys = generateKeypair();
    const body = makeAnnounceBody({
      public_key: 'ff'.repeat(32),
      peer_url: 'https://mismatch.myr.network',
    });
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: otherKeys.privateKey,
      publicKey: otherKeys.publicKey,
    });

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'key_mismatch');
  });

  it('400 invalid_request for missing required fields', async () => {
    const missingKeys = generateKeypair();
    const requiredFields = ['peer_url', 'public_key', 'operator_name', 'timestamp', 'nonce'];

    for (const field of requiredFields) {
      const body = makeAnnounceBody({
        public_key: missingKeys.publicKey,
        peer_url: `https://missing-${field}.myr.network`,
      });
      delete body[field];

      const signed = signRequest({
        method: 'POST',
        path: '/myr/peers/announce',
        body,
        privateKey: missingKeys.privateKey,
        publicKey: missingKeys.publicKey,
      });

      const res = await request(port, {
        method: 'POST',
        path: '/myr/peers/announce',
        headers: signed.headers,
        body,
      });

      assert.equal(res.status, 400, `should be 400 when missing ${field}`);
      assert.equal(res.body.error.code, 'invalid_request',
        `should be invalid_request when missing ${field}`);
      assert.ok(res.body.error.message.includes(field),
        `error message should mention missing field: ${field}`);
    }
  });

  it('non-registry peer re-announce still gets 403', async () => {
    const body = makeAnnounceBody();
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: peerKeys.privateKey,
      publicKey: peerKeys.publicKey,
    });

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    // Still 403 — registry check happens before duplicate check
    assert.equal(res.status, 403);
  });

  it('DB-seeded trusted peer re-announce still requires registry', async () => {
    const trustedKeys = generateKeypair();

    // Seed a trusted peer into the DB directly (simulating prior approval)
    db.prepare(
      `INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at)
       VALUES (?, ?, ?, 'trusted', ?, ?)`
    ).run('https://trusted-peer-old-ip.myr.network', 'trustedpeer',
      trustedKeys.publicKey, new Date().toISOString(), new Date().toISOString());

    const body = makeAnnounceBody({
      public_key: trustedKeys.publicKey,
      operator_name: 'trustedpeer',
      peer_url: 'https://trusted-peer-new-ip.myr.network',
    });
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: trustedKeys.privateKey,
      publicKey: trustedKeys.publicKey,
    });

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    // Even trusted peers must be in the registry for announce to work
    assert.equal(res.status, 403);
  });

  it('401 without auth headers', async () => {
    const body = makeAnnounceBody();

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      body,
    });

    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'auth_required');
  });
});

// --- v1.2.0 fingerprint verification tests ---

/**
 * Create a mock discovery server that serves /.well-known/myr-node
 */
function createMockDiscoveryServer(discoveryResponse) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/.well-known/myr-node') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(discoveryResponse));
    } else if (req.url === '/myr/peers/announce' && req.method === 'POST') {
      // Accept reciprocal announces silently
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  return srv;
}

describe('POST /myr/peers/announce — v1.2.0 fingerprint verification', () => {
  let server, port, db;
  const v12Keys = generateKeypair();
  const v12Fingerprint = computeFingerprint(v12Keys.publicKey);

  function makeV12Body(peerUrl, overrides = {}) {
    return {
      peer_url: peerUrl,
      public_key: v12Keys.publicKey,
      operator_name: 'v12peer',
      fingerprint: v12Fingerprint,
      node_uuid: 'test-uuid-1234',
      protocol_version: '1.2.0',
      timestamp: new Date().toISOString(),
      nonce: crypto.randomBytes(32).toString('hex'),
      ...overrides,
    };
  }

  before(() => {
    db = createTestDb();
    const app = createApp({
      config: { ...TEST_CONFIG, auto_approve_verified_peers: false },
      db,
      publicKeyHex: OUR_PUBLIC_KEY_HEX,
      createdAt: OUR_CREATED_AT,
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('3-way check all match → trust verified-pending-approval', async () => {
    const discoveryServer = createMockDiscoveryServer({
      public_key: v12Keys.publicKey,
      fingerprint: v12Fingerprint,
      protocol_version: '1.2.0',
    });
    discoveryServer.listen(0);
    const discoveryPort = discoveryServer.address().port;

    try {
      const body = makeV12Body(`http://localhost:${discoveryPort}`);
      const signed = signRequest({
        method: 'POST',
        path: '/myr/peers/announce',
        body,
        privateKey: v12Keys.privateKey,
        publicKey: v12Keys.publicKey,
      });

      const res = await request(port, {
        method: 'POST',
        path: '/myr/peers/announce',
        headers: signed.headers,
        body,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.trust_level, 'verified-pending-approval');
      assert.equal(res.body.verification_status, 'verified');
      assert.equal(res.body.auto_approved, false);

      const row = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(v12Keys.publicKey);
      assert.equal(row.trust_level, 'verified-pending-approval');
      assert.equal(row.node_uuid, 'test-uuid-1234');
      assert.ok(row.verification_evidence, 'should have verification_evidence');
      const evidence = JSON.parse(row.verification_evidence);
      assert.equal(evidence.all_passed, true);
    } finally {
      discoveryServer.close();
    }
  });

  it('announced fingerprint mismatch → rejected with evidence', async () => {
    const mismatchKeys = generateKeypair();
    const discoveryServer = createMockDiscoveryServer({
      public_key: mismatchKeys.publicKey,
      fingerprint: computeFingerprint(mismatchKeys.publicKey),
    });
    discoveryServer.listen(0);
    const discoveryPort = discoveryServer.address().port;

    try {
      const body = makeV12Body(`http://localhost:${discoveryPort}`, {
        public_key: mismatchKeys.publicKey,
        fingerprint: 'SHA-256:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00', // wrong
      });
      const signed = signRequest({
        method: 'POST',
        path: '/myr/peers/announce',
        body,
        privateKey: mismatchKeys.privateKey,
        publicKey: mismatchKeys.publicKey,
      });

      const res = await request(port, {
        method: 'POST',
        path: '/myr/peers/announce',
        headers: signed.headers,
        body,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.trust_level, 'rejected');
      assert.equal(res.body.verification_status, 'failed');

      const row = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(mismatchKeys.publicKey);
      assert.equal(row.trust_level, 'rejected');
      const evidence = JSON.parse(row.verification_evidence);
      assert.equal(evidence.check_failed, 'announced_fingerprint_mismatch');
    } finally {
      discoveryServer.close();
    }
  });

  it('discovery doc public_key mismatch → rejected', async () => {
    const realKeys = generateKeypair();
    const otherKeys = generateKeypair();
    // Discovery doc returns a different public key than announced
    const discoveryServer = createMockDiscoveryServer({
      public_key: otherKeys.publicKey,
      fingerprint: computeFingerprint(otherKeys.publicKey),
    });
    discoveryServer.listen(0);
    const discoveryPort = discoveryServer.address().port;

    try {
      const body = makeV12Body(`http://localhost:${discoveryPort}`, {
        public_key: realKeys.publicKey,
        fingerprint: computeFingerprint(realKeys.publicKey),
      });
      const signed = signRequest({
        method: 'POST',
        path: '/myr/peers/announce',
        body,
        privateKey: realKeys.privateKey,
        publicKey: realKeys.publicKey,
      });

      const res = await request(port, {
        method: 'POST',
        path: '/myr/peers/announce',
        headers: signed.headers,
        body,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.trust_level, 'rejected');
      assert.equal(res.body.verification_status, 'failed');
    } finally {
      discoveryServer.close();
    }
  });

  it('missing fingerprint (v1.1.0) → existing registry flow, no v1.2.0 path', async () => {
    // v1.1.0 peer (no fingerprint) not in registry → 403
    const v11Keys = generateKeypair();
    const body = {
      peer_url: 'https://v11peer.myr.network',
      public_key: v11Keys.publicKey,
      operator_name: 'v11peer',
      timestamp: new Date().toISOString(),
      nonce: crypto.randomBytes(32).toString('hex'),
    };
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: v11Keys.privateKey,
      publicKey: v11Keys.publicKey,
    });

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    // Falls back to registry check — not in registry → 403
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
  });

  it('discovery doc fetch fails → trust pending, not rejected', async () => {
    const pendingKeys = generateKeypair();
    // Point to a URL that doesn't exist
    const body = makeV12Body('http://localhost:1', {
      public_key: pendingKeys.publicKey,
      fingerprint: computeFingerprint(pendingKeys.publicKey),
    });
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: pendingKeys.privateKey,
      publicKey: pendingKeys.publicKey,
    });

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.trust_level, 'pending');
    assert.equal(res.body.verification_status, 'unverified');

    const row = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(pendingKeys.publicKey);
    assert.equal(row.trust_level, 'pending');
  });
});

describe('POST /myr/peers/announce — auto-approve + reciprocal', () => {
  let server, port, db;
  const autoKeys = generateKeypair();
  const autoFingerprint = computeFingerprint(autoKeys.publicKey);
  let reciprocalReceived = false;

  before(() => {
    db = createTestDb();
    const app = createApp({
      config: {
        ...TEST_CONFIG,
        auto_approve_verified_peers: true,
        auto_approve_min_protocol_version: '1.2.0',
      },
      db,
      publicKeyHex: OUR_PUBLIC_KEY_HEX,
      createdAt: OUR_CREATED_AT,
      privateKeyHex: 'cc'.repeat(32), // dummy private key for reciprocal announce
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('auto_approve_verified_peers=true → trust becomes trusted, auto_approved=true', async () => {
    const discoveryServer = createMockDiscoveryServer({
      public_key: autoKeys.publicKey,
      fingerprint: autoFingerprint,
      protocol_version: '1.2.0',
    });
    discoveryServer.listen(0);
    const discoveryPort = discoveryServer.address().port;

    try {
      const body = {
        peer_url: `http://localhost:${discoveryPort}`,
        public_key: autoKeys.publicKey,
        operator_name: 'autopeer',
        fingerprint: autoFingerprint,
        node_uuid: 'auto-uuid',
        protocol_version: '1.2.0',
        timestamp: new Date().toISOString(),
        nonce: crypto.randomBytes(32).toString('hex'),
      };
      const signed = signRequest({
        method: 'POST',
        path: '/myr/peers/announce',
        body,
        privateKey: autoKeys.privateKey,
        publicKey: autoKeys.publicKey,
      });

      const res = await request(port, {
        method: 'POST',
        path: '/myr/peers/announce',
        headers: signed.headers,
        body,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.trust_level, 'trusted');
      assert.equal(res.body.auto_approved, true);
      assert.equal(res.body.verification_status, 'verified');

      const row = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(autoKeys.publicKey);
      assert.equal(row.trust_level, 'trusted');
      assert.equal(row.auto_approved, 1);
      assert.ok(row.approved_at, 'should have approved_at set');
    } finally {
      discoveryServer.close();
    }
  });

  it('reciprocal announce fires after auto-approve', async () => {
    const recipKeys = generateKeypair();
    const recipFingerprint = computeFingerprint(recipKeys.publicKey);
    let reciprocalCalled = false;

    const discoveryServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/myr-node') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          public_key: recipKeys.publicKey,
          fingerprint: recipFingerprint,
          protocol_version: '1.2.0',
        }));
      } else if (req.url === '/myr/peers/announce' && req.method === 'POST') {
        reciprocalCalled = true;
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        });
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    discoveryServer.listen(0);
    const discoveryPort = discoveryServer.address().port;

    try {
      const body = {
        peer_url: `http://localhost:${discoveryPort}`,
        public_key: recipKeys.publicKey,
        operator_name: 'recippeer',
        fingerprint: recipFingerprint,
        node_uuid: 'recip-uuid',
        protocol_version: '1.2.0',
        timestamp: new Date().toISOString(),
        nonce: crypto.randomBytes(32).toString('hex'),
      };
      const signed = signRequest({
        method: 'POST',
        path: '/myr/peers/announce',
        body,
        privateKey: recipKeys.privateKey,
        publicKey: recipKeys.publicKey,
      });

      const res = await request(port, {
        method: 'POST',
        path: '/myr/peers/announce',
        headers: signed.headers,
        body,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.auto_approved, true);

      // Wait briefly for the fire-and-forget reciprocal announce
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(reciprocalCalled, true, 'reciprocal announce should have been called');
    } finally {
      discoveryServer.close();
    }
  });
});
