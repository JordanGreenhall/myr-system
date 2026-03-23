'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair, sign, fingerprint: computeFingerprint } = require('../lib/crypto');
const { verifyLivenessProof, verifyNode } = require('../lib/liveness');
const { authedRequest } = require('./helpers/peerRequest');

// --- helpers ---

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(body) });
      });
    }).on('error', reject);
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
  `);

  return db;
}

const TEST_KEYS = generateKeypair();
const TEST_CONFIG = {
  node_id: 'test-node',
  node_name: 'Test Node',
  operator_name: 'testoperator',
  node_url: 'https://test.myr.network',
  port: 0,
  keys_path: '/nonexistent',
};

// --- liveness_proof on /myr/health ---

describe('GET /myr/health liveness_proof', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: TEST_KEYS.publicKey,
      privateKeyHex: TEST_KEYS.privateKey,
      createdAt: '2026-03-01T10:00:00Z',
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('liveness_proof signature is valid against node public_key', async () => {
    const { status, body } = await get(port, '/myr/health');
    assert.equal(status, 200);

    assert.ok(body.liveness_proof, 'response must include liveness_proof');
    assert.ok(body.liveness_proof.timestamp, 'liveness_proof must include timestamp');
    assert.ok(body.liveness_proof.nonce, 'liveness_proof must include nonce');
    assert.ok(body.liveness_proof.signature, 'liveness_proof must include signature');

    // Verify the signature: sign(timestamp + nonce, privateKey)
    const result = verifyLivenessProof(body.liveness_proof, TEST_KEYS.publicKey);
    assert.equal(result.verified, true, `Expected verified=true, got reason: ${result.reason}`);
  });

  it('liveness_proof timestamp is fresh (< 5 min)', async () => {
    const { body } = await get(port, '/myr/health');
    const proof = body.liveness_proof;
    const ageSec = (Date.now() - new Date(proof.timestamp).getTime()) / 1000;
    assert.ok(ageSec < 300, `Timestamp should be fresh, but is ${ageSec}s old`);
  });

  it('liveness_proof nonce is 32 bytes hex (64 chars)', async () => {
    const { body } = await get(port, '/myr/health');
    assert.equal(body.liveness_proof.nonce.length, 64);
    assert.match(body.liveness_proof.nonce, /^[0-9a-f]{64}$/);
  });

  it('preserves existing flat fields alongside liveness_proof', async () => {
    const { body } = await get(port, '/myr/health');
    // Flat fields from pre-1.5 must still be present
    assert.ok('timestamp' in body, 'flat timestamp must exist');
    assert.ok('nonce' in body, 'flat nonce must exist');
    assert.ok('liveness_signature' in body, 'flat liveness_signature must exist');
    // New nested block
    assert.ok('liveness_proof' in body, 'liveness_proof block must exist');
  });
});

// --- verifyLivenessProof unit tests ---

describe('verifyLivenessProof()', () => {
  it('returns verified:true for a valid, fresh proof', () => {
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomBytes(32).toString('hex');
    const signature = sign(timestamp + nonce, TEST_KEYS.privateKey);

    const result = verifyLivenessProof(
      { timestamp, nonce, signature },
      TEST_KEYS.publicKey,
    );
    assert.equal(result.verified, true);
  });

  it('fails for stale timestamp (> 5 min)', () => {
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const nonce = crypto.randomBytes(32).toString('hex');
    const signature = sign(staleTime + nonce, TEST_KEYS.privateKey);

    const result = verifyLivenessProof(
      { timestamp: staleTime, nonce, signature },
      TEST_KEYS.publicKey,
    );
    assert.equal(result.verified, false);
    assert.ok(result.reason.includes('stale'), `Expected 'stale' in reason, got: ${result.reason}`);
  });

  it('fails for tampered signature', () => {
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomBytes(32).toString('hex');
    // Sign the correct message but then tamper with the signature
    const realSig = sign(timestamp + nonce, TEST_KEYS.privateKey);
    const tamperedSig = realSig.slice(0, -4) + 'dead';

    const result = verifyLivenessProof(
      { timestamp, nonce, signature: tamperedSig },
      TEST_KEYS.publicKey,
    );
    assert.equal(result.verified, false);
    assert.ok(result.reason.includes('Signature verification failed'),
      `Expected signature failure reason, got: ${result.reason}`);
  });

  it('fails for wrong public key', () => {
    const otherKeys = generateKeypair();
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomBytes(32).toString('hex');
    const signature = sign(timestamp + nonce, TEST_KEYS.privateKey);

    const result = verifyLivenessProof(
      { timestamp, nonce, signature },
      otherKeys.publicKey, // wrong key
    );
    assert.equal(result.verified, false);
    assert.ok(result.reason.includes('Signature verification failed'));
  });

  it('fails when liveness_proof is null (pre-1.5 node)', () => {
    const result = verifyLivenessProof(null, TEST_KEYS.publicKey);
    assert.equal(result.verified, false);
    assert.ok(result.reason.includes('pre-1.5'));
  });

  it('fails when signature field is missing', () => {
    const result = verifyLivenessProof(
      { timestamp: new Date().toISOString(), nonce: 'abc' },
      TEST_KEYS.publicKey,
    );
    assert.equal(result.verified, false);
    assert.ok(result.reason.includes('missing'));
  });
});

// --- /myr/health/verify endpoint ---

describe('GET /myr/health/verify', () => {
  let server, port, db;
  // Peer node keys and server
  const peerKeys = generateKeypair();
  let peerServer, peerPort;

  before(() => {
    db = createTestDb();

    // Create peer node server that returns valid liveness_proof
    const peerApp = createApp({
      config: {
        ...TEST_CONFIG,
        operator_name: 'peeroperator',
        node_url: 'http://peer.test',
      },
      db: createTestDb(), // separate db for peer
      publicKeyHex: peerKeys.publicKey,
      privateKeyHex: peerKeys.privateKey,
      createdAt: '2026-03-01T10:00:00Z',
    });
    peerServer = peerApp.listen(0);
    peerPort = peerServer.address().port;

    // Add peer to our db with fingerprint-resolvable public key
    const peerFingerprint = computeFingerprint(peerKeys.publicKey);
    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run(`http://localhost:${peerPort}`, 'peeroperator', peerKeys.publicKey, 'trusted', '2026-03-01T00:00:00Z');

    // Main server (with auth keys for authenticated requests)
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: TEST_KEYS.publicKey,
      privateKeyHex: TEST_KEYS.privateKey,
      createdAt: '2026-03-01T10:00:00Z',
    });
    server = app.listen(0);
    port = server.address().port;

    // Add our own key as a trusted peer so auth passes
    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run('http://localhost', 'self', TEST_KEYS.publicKey, 'trusted', '2026-03-01T00:00:00Z');
  });

  after(() => {
    server.close();
    peerServer.close();
    db.close();
  });

  it('self-verify returns verified:true when no fingerprint provided', async () => {
    const { status, body } = await authedRequest(port, {
      method: 'GET',
      path: '/myr/health/verify',
      keys: TEST_KEYS,
    });
    assert.equal(status, 200);
    assert.equal(body.verified, true);
    assert.equal(body.operator_name, 'testoperator');
    assert.equal(body.latency_ms, 0);
    assert.ok(body.fingerprint);
    assert.ok(body.timestamp);
  });

  it('verifies a peer by fingerprint (fetches peer /myr/health)', async () => {
    const peerFingerprint = computeFingerprint(peerKeys.publicKey);
    const { status, body } = await authedRequest(port, {
      method: 'GET',
      path: `/myr/health/verify?fingerprint=${encodeURIComponent(peerFingerprint)}`,
      keys: TEST_KEYS,
    });
    assert.equal(status, 200);
    assert.equal(body.verified, true);
    assert.equal(body.operator_name, 'peeroperator');
    assert.ok(body.latency_ms >= 0);
    assert.ok(body.timestamp);
  });

  it('returns verified:false on unreachable peer', async () => {
    // Insert a peer with an unreachable URL
    const unreachableKeys = generateKeypair();
    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run('http://localhost:1', 'ghost', unreachableKeys.publicKey, 'trusted', '2026-03-01T00:00:00Z');

    const fp = computeFingerprint(unreachableKeys.publicKey);
    const { status, body } = await authedRequest(port, {
      method: 'GET',
      path: `/myr/health/verify?fingerprint=${encodeURIComponent(fp)}`,
      keys: TEST_KEYS,
    });
    assert.equal(status, 200);
    assert.equal(body.verified, false);
    assert.ok(body.reason, 'should include a reason for failure');
  });

  it('returns 404 for unknown fingerprint', async () => {
    const { status, body } = await authedRequest(port, {
      method: 'GET',
      path: '/myr/health/verify?fingerprint=SHA-256:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
      keys: TEST_KEYS,
    });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'peer_not_found');
  });
});

// --- verifyNode() library function ---

describe('verifyNode()', () => {
  it('verifies a live node with valid liveness_proof', async () => {
    const keys = generateKeypair();
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomBytes(32).toString('hex');
    const signature = sign(timestamp + nonce, keys.privateKey);

    const mockFetch = async (url) => {
      if (url.includes('/.well-known/myr-node')) {
        return {
          public_key: keys.publicKey,
          operator_name: 'mockoperator',
          fingerprint: computeFingerprint(keys.publicKey),
        };
      }
      if (url.includes('/myr/health')) {
        return {
          status: 'ok',
          liveness_proof: { timestamp, nonce, signature },
        };
      }
    };

    const result = await verifyNode('http://mock.node', { fetchFn: mockFetch });
    assert.equal(result.verified, true);
    assert.equal(result.operator_name, 'mockoperator');
    assert.ok(result.latency_ms >= 0);
  });

  it('returns verified:false for unreachable node', async () => {
    const mockFetch = async () => {
      const err = new Error('connection refused');
      err.code = 'ECONNREFUSED';
      throw err;
    };

    const result = await verifyNode('http://dead.node', { fetchFn: mockFetch });
    assert.equal(result.verified, false);
    assert.ok(result.reason.includes('Could not reach'));
  });

  it('returns verified:false when no liveness_proof (pre-1.5)', async () => {
    const keys = generateKeypair();
    const mockFetch = async (url) => {
      if (url.includes('/.well-known/myr-node')) {
        return {
          public_key: keys.publicKey,
          operator_name: 'oldnode',
          fingerprint: computeFingerprint(keys.publicKey),
        };
      }
      return { status: 'ok' }; // no liveness_proof
    };

    const result = await verifyNode('http://old.node', { fetchFn: mockFetch });
    assert.equal(result.verified, false);
    assert.ok(result.reason.includes('pre-1.5'));
  });

  it('returns verified:false for bad signature', async () => {
    const keys = generateKeypair();
    const otherKeys = generateKeypair();
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomBytes(32).toString('hex');
    // Sign with wrong key
    const signature = sign(timestamp + nonce, otherKeys.privateKey);

    const mockFetch = async (url) => {
      if (url.includes('/.well-known/myr-node')) {
        return {
          public_key: keys.publicKey, // claims this key
          operator_name: 'impersonator',
          fingerprint: computeFingerprint(keys.publicKey),
        };
      }
      return {
        status: 'ok',
        liveness_proof: { timestamp, nonce, signature }, // signed by different key
      };
    };

    const result = await verifyNode('http://bad.node', { fetchFn: mockFetch });
    assert.equal(result.verified, false);
    assert.ok(result.reason.includes('Signature verification failed'));
  });
});
