'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair } = require('../lib/crypto');
const { authedRequest, request } = require('./helpers/peerRequest');

const trustedKeys = generateKeypair();
const pendingKeys = generateKeypair();
const unknownKeys = generateKeypair();

const TEST_CONFIG = {
  operator_name: 'testoperator',
  node_url: 'https://test.myr.network',
  port: 0,
};

const TEST_PUBLIC_KEY_HEX = 'ab'.repeat(32);
const TEST_CREATED_AT = '2026-03-01T10:00:00Z';

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
      trust_level TEXT CHECK(trust_level IN ('trusted', 'pending', 'rejected')) DEFAULT 'pending',
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

function seedData(db) {
  const ins = db.prepare(`
    INSERT INTO myr_reports (id, timestamp, agent_id, node_id, cycle_intent,
      domain_tags, yield_type, question_answered, evidence, what_changes_next,
      confidence, operator_rating, created_at, updated_at, share_network)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  ins.run('r1', '2026-03-01T10:00:00Z', 'a1', 'n1',
    'rate limiting', 'security', 'technique', 'how?', 'token bucket', 'implement',
    0.8, 4, '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', 1);

  ins.run('r2', '2026-03-01T11:00:00Z', 'a1', 'n1',
    'peer discovery', 'networking', 'insight', 'find peers?', 'DNS-SD', 'test',
    0.7, 3, '2026-03-01T11:00:00Z', '2026-03-01T11:00:00Z', 1);

  ins.run('r3', '2026-03-02T09:00:00Z', 'a1', 'n1',
    'auth middleware', 'security', 'technique', 'authenticate?', 'Ed25519', 'deploy',
    0.9, 5, '2026-03-02T09:00:00Z', '2026-03-02T09:00:00Z', 1);

  // Private report — must NOT appear in listings
  ins.run('r4', '2026-03-01T12:00:00Z', 'a1', 'n1',
    'internal notes', 'internal', 'pattern', 'secret?', 'classified', 'hide',
    0.9, 2, '2026-03-01T12:00:00Z', '2026-03-01T12:00:00Z', 0);

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

describe('GET /myr/reports', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    seedData(db);
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

  // --- Happy path ---

  it('authenticated trusted peer receives reports', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/reports',
      keys: trustedKeys,
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.reports));
    assert.equal(typeof body.total, 'number');
  });

  it('returns only reports with share_network=1', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/reports',
      keys: trustedKeys,
    });
    assert.equal(status, 200);
    assert.equal(body.reports.length, 3);
    assert.equal(body.total, 3);
    for (const r of body.reports) {
      assert.notEqual(r.method_name, 'internal notes',
        'private report must not appear');
    }
  });

  it('filters by since parameter', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/reports?since=2026-03-01T10:30:00Z',
      keys: trustedKeys,
    });
    assert.equal(status, 200);
    assert.equal(body.reports.length, 2);
    assert.equal(body.since, '2026-03-01T10:30:00Z');
    for (const r of body.reports) {
      assert.ok(r.created_at > '2026-03-01T10:30:00Z');
    }
  });

  it('limit parameter caps result count', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/reports?limit=2',
      keys: trustedKeys,
    });
    assert.equal(status, 200);
    assert.equal(body.reports.length, 2);
    assert.equal(body.total, 3);
  });

  it('limit defaults to 100 and caps at 500', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/reports?limit=9999',
      keys: trustedKeys,
    });
    assert.equal(status, 200);
    assert.ok(body.reports.length <= 500);
  });

  it('orders results by created_at ASC', async () => {
    const { body } = await authedRequest(port, {
      path: '/myr/reports',
      keys: trustedKeys,
    });
    for (let i = 1; i < body.reports.length; i++) {
      assert.ok(
        body.reports[i].created_at >= body.reports[i - 1].created_at,
        'results must be ordered by created_at ASC',
      );
    }
  });

  // --- Response structure ---

  it('response structure matches spec', async () => {
    const { body } = await authedRequest(port, {
      path: '/myr/reports',
      keys: trustedKeys,
    });

    assert.ok('reports' in body);
    assert.ok('total' in body);
    assert.ok('since' in body);

    const report = body.reports[0];
    const required = [
      'signature', 'operator_name', 'created_at',
      'method_name', 'operator_rating', 'size_bytes', 'url',
    ];
    for (const field of required) {
      assert.ok(field in report, `missing report field: ${field}`);
    }

    assert.ok(report.signature.startsWith('sha256:'));
    assert.equal(report.url, '/myr/reports/' + report.signature);
    assert.equal(report.operator_name, 'testoperator');
    assert.equal(typeof report.size_bytes, 'number');
    assert.ok(report.size_bytes > 0);
  });

  it('since is null when omitted', async () => {
    const { body } = await authedRequest(port, {
      path: '/myr/reports',
      keys: trustedKeys,
    });
    assert.equal(body.since, null);
  });

  // --- Auth / trust errors ---

  it('returns 401 without auth headers', async () => {
    const { status, body } = await request(port, {
      path: '/myr/reports',
    });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'auth_required');
  });

  it('returns 403 unknown_peer for unrecognized public key', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/reports',
      keys: unknownKeys,
    });
    assert.equal(status, 403);
    assert.equal(body.error.code, 'unknown_peer');
  });

  it('returns 403 peer_not_trusted for pending peer', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/reports',
      keys: pendingKeys,
    });
    assert.equal(status, 403);
    assert.equal(body.error.code, 'peer_not_trusted');
  });

  // --- Validation errors ---

  it('returns 400 for invalid since parameter', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/reports?since=not-a-date',
      keys: trustedKeys,
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
  });

  it('returns 400 for non-numeric limit', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/reports?limit=abc',
      keys: trustedKeys,
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
  });

  it('returns 400 for limit < 1', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/reports?limit=0',
      keys: trustedKeys,
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
  });
});

describe('GET /myr/reports (empty database)', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    const insPeer = db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    insPeer.run('https://trusted.myr.network', 'trusted-op',
      trustedKeys.publicKey, 'trusted', '2026-02-28T12:00:00Z');

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

  it('returns empty array when no shared reports exist', async () => {
    const { status, body } = await authedRequest(port, {
      path: '/myr/reports',
      keys: trustedKeys,
    });
    assert.equal(status, 200);
    assert.deepEqual(body.reports, []);
    assert.equal(body.total, 0);
  });
});
