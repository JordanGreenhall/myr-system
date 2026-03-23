'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { errorResponse, STATUS_CODES } = require('../server/lib/errors');

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
  `);

  return db;
}

function seedTestData(db) {
  const insertReport = db.prepare(`
    INSERT INTO myr_reports (id, timestamp, agent_id, node_id, cycle_intent, domain_tags,
      yield_type, question_answered, evidence, what_changes_next, confidence,
      created_at, updated_at, share_network)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertReport.run('r1', '2026-03-01T10:00:00Z', 'agent1', 'n1',
    'test intent', 'testing', 'technique', 'does it work?', 'yes', 'keep going',
    0.8, '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', 1);
  insertReport.run('r2', '2026-03-01T11:00:00Z', 'agent1', 'n1',
    'test intent 2', 'testing', 'insight', 'is it fast?', 'sort of', 'optimize',
    0.6, '2026-03-01T11:00:00Z', '2026-03-01T11:00:00Z', 1);
  insertReport.run('r3', '2026-03-01T12:00:00Z', 'agent1', 'n1',
    'private intent', 'internal', 'pattern', 'secret?', 'yes', 'hide it',
    0.9, '2026-03-01T12:00:00Z', '2026-03-01T12:00:00Z', 0);

  const insertPeer = db.prepare(`
    INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, last_sync_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertPeer.run('https://gary.myr.network', 'gary', 'aa'.repeat(32),
    'trusted', '2026-02-28T12:00:00Z', '2026-03-01T10:30:00Z');
  insertPeer.run('https://jared.myr.network', 'jared', 'bb'.repeat(32),
    'pending', '2026-03-01T08:00:00Z', null);
  insertPeer.run('https://eve.myr.network', 'eve', 'cc'.repeat(32),
    'trusted', '2026-02-27T08:00:00Z', '2026-03-01T09:00:00Z');
}

const TEST_CONFIG = {
  node_id: 'test-node',
  node_name: 'Test Node',
  operator_name: 'testoperator',
  node_url: 'https://test.myr.network',
  port: 0,
  keys_path: '/nonexistent',
};

const TEST_PUBLIC_KEY = 'ab'.repeat(32);
const TEST_CREATED_AT = '2026-03-01T10:00:00Z';

// --- tests ---

describe('server/lib/errors', () => {
  it('STATUS_CODES maps error codes to HTTP status codes', () => {
    assert.equal(STATUS_CODES.internal_error, 500);
    assert.equal(STATUS_CODES.not_found, 404);
    assert.equal(STATUS_CODES.auth_required, 401);
    assert.equal(STATUS_CODES.rate_limit_exceeded, 429);
    assert.equal(STATUS_CODES.conflict, 409);
    assert.equal(STATUS_CODES.invalid_request, 400);
  });
});

describe('GET /.well-known/myr-node', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: TEST_PUBLIC_KEY,
      createdAt: TEST_CREATED_AT,
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('returns 200 with correct JSON structure', async () => {
    const { status, body } = await get(port, '/.well-known/myr-node');
    assert.equal(status, 200);
    assert.equal(body.protocol_version, '1.0.0');
    assert.equal(body.node_url, 'https://test.myr.network');
    assert.equal(body.operator_name, 'testoperator');
    assert.equal(body.public_key, TEST_PUBLIC_KEY);
    assert.equal(body.public_key.length, 64);
    assert.deepEqual(body.capabilities,
      ['report-sync', 'peer-discovery', 'incremental-sync']);
    assert.equal(body.created_at, TEST_CREATED_AT);
    assert.equal(body.rate_limits.requests_per_minute, 60);
    assert.equal(body.rate_limits.min_sync_interval_minutes, 15);
  });

  it('has all required top-level fields', async () => {
    const { body } = await get(port, '/.well-known/myr-node');
    const required = [
      'protocol_version', 'node_url', 'operator_name', 'public_key',
      'capabilities', 'created_at', 'rate_limits',
    ];
    for (const field of required) {
      assert.ok(field in body, `missing field: ${field}`);
    }
  });
});

describe('GET /.well-known/myr-node (error cases)', () => {
  it('returns 500 when public key cannot be loaded', async () => {
    const db = createTestDb();
    const app = createApp({
      config: { ...TEST_CONFIG, keys_path: '/nonexistent' },
      db,
    });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const { status, body } = await get(port, '/.well-known/myr-node');
      assert.equal(status, 500);
      assert.equal(body.error.code, 'internal_error');
      assert.ok(body.error.message.includes('Node configuration invalid'));
      assert.ok(body.error.details);
    } finally {
      server.close();
      db.close();
    }
  });

  it('returns 500 when operator_name is missing', async () => {
    const db = createTestDb();
    const app = createApp({
      config: { ...TEST_CONFIG, operator_name: null, node_name: '' },
      db,
      publicKeyHex: TEST_PUBLIC_KEY,
      createdAt: TEST_CREATED_AT,
    });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const { status, body } = await get(port, '/.well-known/myr-node');
      assert.equal(status, 500);
      assert.equal(body.error.code, 'internal_error');
      assert.ok(body.error.details.includes('operator_name'));
    } finally {
      server.close();
      db.close();
    }
  });
});

describe('GET /myr/health', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    seedTestData(db);
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: TEST_PUBLIC_KEY,
      createdAt: TEST_CREATED_AT,
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('returns 200 with correct JSON structure', async () => {
    const { status, body } = await get(port, '/myr/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.node_url, 'https://test.myr.network');
    assert.equal(body.operator_name, 'testoperator');
  });

  it('has all required top-level fields', async () => {
    const { body } = await get(port, '/myr/health');
    const required = [
      'status', 'node_url', 'operator_name', 'last_sync_at',
      'peers_active', 'peers_total', 'reports_total',
      'reports_shared', 'uptime_seconds',
    ];
    for (const field of required) {
      assert.ok(field in body, `missing field: ${field}`);
    }
  });

  it('returns correct peer counts', async () => {
    const { body } = await get(port, '/myr/health');
    assert.equal(body.peers_total, 3);
    assert.equal(body.peers_active, 2);
  });

  it('returns correct report counts', async () => {
    const { body } = await get(port, '/myr/health');
    assert.equal(body.reports_total, 3);
    assert.equal(body.reports_shared, 2);
  });

  it('returns most recent last_sync_at', async () => {
    const { body } = await get(port, '/myr/health');
    assert.equal(body.last_sync_at, '2026-03-01T10:30:00Z');
  });

  it('returns uptime_seconds as a non-negative integer', async () => {
    const { body } = await get(port, '/myr/health');
    assert.equal(typeof body.uptime_seconds, 'number');
    assert.ok(body.uptime_seconds >= 0);
  });
});

describe('GET /myr/health (empty database)', () => {
  it('returns zeros when no data exists', async () => {
    const db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: TEST_PUBLIC_KEY,
      createdAt: TEST_CREATED_AT,
    });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const { status, body } = await get(port, '/myr/health');
      assert.equal(status, 200);
      assert.equal(body.status, 'ok');
      assert.equal(body.peers_active, 0);
      assert.equal(body.peers_total, 0);
      assert.equal(body.reports_total, 0);
      assert.equal(body.reports_shared, 0);
      assert.equal(body.last_sync_at, null);
    } finally {
      server.close();
      db.close();
    }
  });
});

describe('Server lifecycle', () => {
  it('starts on a configured port', async () => {
    const db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: TEST_PUBLIC_KEY,
      createdAt: TEST_CREATED_AT,
    });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      assert.ok(port > 0, 'should bind to a port');
      const { status } = await get(port, '/myr/health');
      assert.equal(status, 200);
    } finally {
      server.close();
      db.close();
    }
  });

  it('graceful shutdown closes the server', async () => {
    const db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: TEST_PUBLIC_KEY,
      createdAt: TEST_CREATED_AT,
    });
    const server = app.listen(0);
    const port = server.address().port;

    const { status } = await get(port, '/myr/health');
    assert.equal(status, 200);

    await new Promise((resolve) => server.close(resolve));

    await assert.rejects(
      () => get(port, '/myr/health'),
      (err) => {
        assert.ok(
          err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET',
          `expected ECONNREFUSED or ECONNRESET, got ${err.code}`,
        );
        return true;
      },
    );

    db.close();
  });
});
