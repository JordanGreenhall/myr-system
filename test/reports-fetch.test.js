'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair, verify } = require('../lib/crypto');
const { canonicalize } = require('../lib/canonicalize');
const { authedRequest, request } = require('./helpers/peerRequest');

const serverKeys = generateKeypair();
const trustedKeys = generateKeypair();
const pendingKeys = generateKeypair();
const unknownKeys = generateKeypair();

const TEST_CONFIG = {
  operator_name: 'testoperator',
  node_url: 'https://test.myr.network',
  port: 0,
};

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

const SHARED_ROW = {
  id: 'r1', timestamp: '2026-03-01T10:00:00Z', agent_id: 'a1', node_id: 'n1',
  session_ref: null, cycle_intent: 'rate limiting', domain_tags: 'security',
  yield_type: 'technique', question_answered: 'how?', evidence: 'token bucket',
  what_changes_next: 'implement', confidence: 0.8, operator_rating: 4,
  created_at: '2026-03-01T10:00:00Z', updated_at: '2026-03-01T10:00:00Z',
  share_network: 1,
};

const PRIVATE_ROW = {
  id: 'r4', timestamp: '2026-03-01T12:00:00Z', agent_id: 'a1', node_id: 'n1',
  session_ref: null, cycle_intent: 'internal notes', domain_tags: 'internal',
  yield_type: 'pattern', question_answered: 'secret?', evidence: 'classified',
  what_changes_next: 'hide', confidence: 0.9, operator_rating: 2,
  created_at: '2026-03-01T12:00:00Z', updated_at: '2026-03-01T12:00:00Z',
  share_network: 0,
};

function computeSignature(row) {
  const obj = { ...row };
  delete obj.signature;
  delete obj.operator_signature;
  const canonical = canonicalize(obj);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  return 'sha256:' + hash;
}

const SHARED_SIG = computeSignature(SHARED_ROW);
const PRIVATE_SIG = computeSignature(PRIVATE_ROW);

function seedData(db) {
  const ins = db.prepare(`
    INSERT INTO myr_reports (id, timestamp, agent_id, node_id, session_ref, cycle_intent,
      domain_tags, yield_type, question_answered, evidence, what_changes_next,
      confidence, operator_rating, created_at, updated_at, share_network)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of [SHARED_ROW, PRIVATE_ROW]) {
    ins.run(row.id, row.timestamp, row.agent_id, row.node_id, row.session_ref,
      row.cycle_intent, row.domain_tags, row.yield_type, row.question_answered,
      row.evidence, row.what_changes_next, row.confidence, row.operator_rating,
      row.created_at, row.updated_at, row.share_network);
  }

  const insPeer = db.prepare(`
    INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  insPeer.run('https://trusted.myr.network', 'trusted-op',
    trustedKeys.publicKey, 'trusted', '2026-02-28T12:00:00Z');
  insPeer.run('https://pending.myr.network', 'pending-op',
    pendingKeys.publicKey, 'pending', '2026-03-01T08:00:00Z');
}

// ---------- Tests ----------

describe('GET /myr/reports/:signature', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    seedData(db);
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: serverKeys.publicKey,
      createdAt: '2026-03-01T10:00:00Z',
      privateKeyHex: serverKeys.privateKey,
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  // --- Happy path ---

  it('trusted peer can fetch a shared report', async () => {
    const { status, body } = await authedRequest(port, {
      path: `/myr/reports/${SHARED_SIG}`,
      keys: trustedKeys,
    });
    assert.equal(status, 200);
    assert.equal(body.signature, SHARED_SIG);
    assert.equal(body.id, 'r1');
  });

  it('response contains all report fields', async () => {
    const { status, body } = await authedRequest(port, {
      path: `/myr/reports/${SHARED_SIG}`,
      keys: trustedKeys,
    });
    assert.equal(status, 200);

    const expectedFields = [
      'id', 'timestamp', 'agent_id', 'node_id', 'session_ref',
      'cycle_intent', 'domain_tags', 'yield_type', 'question_answered',
      'evidence', 'what_changes_next', 'confidence', 'operator_rating',
      'created_at', 'updated_at', 'share_network', 'signature',
    ];

    for (const field of expectedFields) {
      assert.ok(field in body, `missing field: ${field}`);
    }

    assert.equal(body.cycle_intent, 'rate limiting');
    assert.equal(body.operator_rating, 4);
    assert.equal(body.share_network, 1);
  });

  it('X-MYR-Signature header is present and valid', async () => {
    const { status, headers, rawBody } = await authedRequest(port, {
      path: `/myr/reports/${SHARED_SIG}`,
      keys: trustedKeys,
    });
    assert.equal(status, 200);

    const responseSig = headers['x-myr-signature'];
    assert.ok(responseSig, 'X-MYR-Signature header must be present');
    assert.ok(responseSig.length > 0, 'signature must not be empty');

    const valid = verify(rawBody, responseSig, serverKeys.publicKey);
    assert.ok(valid, 'response signature must verify against server public key');
  });

  // --- Error cases ---

  it('returns 403 report_not_shared for private report', async () => {
    const { status, body } = await authedRequest(port, {
      path: `/myr/reports/${PRIVATE_SIG}`,
      keys: trustedKeys,
    });
    assert.equal(status, 403);
    assert.equal(body.error.code, 'report_not_shared');
  });

  it('returns 404 report_not_found for missing signature', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/reports/sha256:0000000000000000000000000000000000000000000000000000000000000000',
      keys: trustedKeys,
    });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'report_not_found');
  });

  it('returns 403 peer_not_trusted for untrusted peer', async () => {
    const { status, body } = await authedRequest(port, {
      path: `/myr/reports/${SHARED_SIG}`,
      keys: pendingKeys,
    });
    assert.equal(status, 403);
    assert.equal(body.error.code, 'peer_not_trusted');
  });

  it('returns 403 unknown_peer for unrecognized public key', async () => {
    const { status, body } = await authedRequest(port, {
      path: `/myr/reports/${SHARED_SIG}`,
      keys: unknownKeys,
    });
    assert.equal(status, 403);
    assert.equal(body.error.code, 'unknown_peer');
  });

  it('returns 401 auth_required without auth headers', async () => {
    const { status, body } = await request(port, {
      path: `/myr/reports/${SHARED_SIG}`,
    });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'auth_required');
  });
});
