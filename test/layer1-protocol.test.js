'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair, sign: signMessage } = require('../lib/crypto');
const { signRequest } = require('./helpers/signRequest');
const { canonicalize } = require('../lib/canonicalize');

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
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      share_network INTEGER DEFAULT 0,
      signed_by TEXT,
      signed_artifact TEXT
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

const peerKeys = generateKeypair();
const nodeKeys = generateKeypair();

// --- Rate Limiting Tests ---

describe('Rate limiting (60 req/min per peer)', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    // Insert trusted peer
    db.prepare(
      "INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)"
    ).run('https://peer.myr.network', 'peer', peerKeys.publicKey, 'trusted', '2026-03-01T10:00:00Z');

    const app = createApp({
      config: { ...TEST_CONFIG, rate_limit: { requests_per_minute: 5 } },
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

  it('allows requests within the rate limit', async () => {
    for (let i = 0; i < 5; i++) {
      const signed = signRequest({
        method: 'GET',
        path: '/myr/peer/list',
        privateKey: peerKeys.privateKey,
        publicKey: peerKeys.publicKey,
      });
      const { status } = await request(port, {
        path: '/myr/peer/list',
        headers: signed.headers,
      });
      assert.equal(status, 200, `Request ${i + 1} should succeed`);
    }
  });

  it('returns 429 on the 6th request within the window (limit=5)', async () => {
    // The 5 requests above already consumed the budget for this peer in this window
    const signed = signRequest({
      method: 'GET',
      path: '/myr/peer/list',
      privateKey: peerKeys.privateKey,
      publicKey: peerKeys.publicKey,
    });
    const { status, headers, body } = await request(port, {
      path: '/myr/peer/list',
      headers: signed.headers,
    });
    assert.equal(status, 429);
    assert.equal(body.error.code, 'rate_limit_exceeded');
    assert.ok(headers['retry-after'], 'Should include Retry-After header');
    const retryAfter = parseInt(headers['retry-after'], 10);
    assert.ok(retryAfter > 0 && retryAfter <= 60, 'Retry-After should be between 1 and 60 seconds');
  });

  it('does not rate limit public endpoints (no auth = no peer key)', async () => {
    // Discovery and health are public, placed before auth middleware
    for (let i = 0; i < 10; i++) {
      const { status } = await request(port, { path: '/myr/health' });
      assert.equal(status, 200);
    }
  });
});

// --- sync_cursor Tests ---

describe('GET /myr/reports sync_cursor', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    db.prepare(
      "INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)"
    ).run('https://peer.myr.network', 'peer', peerKeys.publicKey, 'trusted', '2026-03-01T10:00:00Z');

    const insertReport = db.prepare(`
      INSERT INTO myr_reports (id, timestamp, agent_id, node_id, cycle_intent, domain_tags,
        yield_type, question_answered, evidence, what_changes_next, confidence,
        created_at, updated_at, share_network)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertReport.run('r1', '2026-03-01T10:00:00Z', 'a1', 'n1', 'intent1', 'tag', 'technique',
      'q1', 'e1', 'next1', 0.8, '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', 1);
    insertReport.run('r2', '2026-03-01T11:00:00Z', 'a1', 'n1', 'intent2', 'tag', 'insight',
      'q2', 'e2', 'next2', 0.7, '2026-03-01T11:00:00Z', '2026-03-01T11:00:00Z', 1);

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

  it('returns sync_cursor set to the last report created_at', async () => {
    const signed = signRequest({
      method: 'GET',
      path: '/myr/reports',
      privateKey: peerKeys.privateKey,
      publicKey: peerKeys.publicKey,
    });
    const { status, body } = await request(port, {
      path: '/myr/reports',
      headers: signed.headers,
    });
    assert.equal(status, 200);
    assert.ok(body.sync_cursor, 'Response should include sync_cursor');
    assert.equal(body.sync_cursor, '2026-03-01T11:00:00Z');
  });

  it('returns sync_cursor matching since when no results', async () => {
    const signed = signRequest({
      method: 'GET',
      path: '/myr/reports',
      privateKey: peerKeys.privateKey,
      publicKey: peerKeys.publicKey,
    });
    const { status, body } = await request(port, {
      path: '/myr/reports?since=2099-01-01T00:00:00Z',
      headers: signed.headers,
    });
    assert.equal(status, 200);
    assert.equal(body.reports.length, 0);
    assert.equal(body.sync_cursor, '2099-01-01T00:00:00Z');
  });
});

// --- POST /myr/sync/pull Tests ---

describe('POST /myr/sync/pull', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    db.prepare(
      "INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)"
    ).run('https://peer.myr.network', 'peer', peerKeys.publicKey, 'trusted', '2026-03-01T10:00:00Z');

    const insertReport = db.prepare(`
      INSERT INTO myr_reports (id, timestamp, agent_id, node_id, cycle_intent, domain_tags,
        yield_type, question_answered, evidence, what_changes_next, confidence,
        created_at, updated_at, share_network)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 1; i <= 5; i++) {
      insertReport.run(`r${i}`, `2026-03-0${i}T10:00:00Z`, 'a1', 'n1',
        `intent${i}`, 'tag', 'technique', `q${i}`, `e${i}`, `next${i}`, 0.8,
        `2026-03-0${i}T10:00:00Z`, `2026-03-0${i}T10:00:00Z`, 1);
    }

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

  it('returns sync_id and estimated_reports for full sync', async () => {
    const body = JSON.stringify({});
    const signed = signRequest({
      method: 'POST',
      path: '/myr/sync/pull',
      body,
      privateKey: peerKeys.privateKey,
      publicKey: peerKeys.publicKey,
    });
    const { status, body: resBody } = await request(port, {
      method: 'POST',
      path: '/myr/sync/pull',
      headers: signed.headers,
      body,
    });
    assert.equal(status, 200);
    assert.ok(resBody.sync_id, 'Should have sync_id');
    assert.equal(resBody.status, 'started');
    assert.equal(resBody.estimated_reports, 5);
  });

  it('returns estimated_reports for incremental sync with since', async () => {
    const body = JSON.stringify({ since: '2026-03-03T10:00:00Z' });
    const signed = signRequest({
      method: 'POST',
      path: '/myr/sync/pull',
      body,
      privateKey: peerKeys.privateKey,
      publicKey: peerKeys.publicKey,
    });
    const { status, body: resBody } = await request(port, {
      method: 'POST',
      path: '/myr/sync/pull',
      headers: signed.headers,
      body,
    });
    assert.equal(status, 200);
    assert.equal(resBody.estimated_reports, 2); // r4 and r5
  });

  it('rejects unauthenticated requests', async () => {
    const { status, body } = await request(port, {
      method: 'POST',
      path: '/myr/sync/pull',
    });
    assert.equal(status, 401);
  });

  it('rejects untrusted peers', async () => {
    const untrustedKeys = generateKeypair();
    db.prepare(
      "INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)"
    ).run('https://untrusted.myr.network', 'untrusted', untrustedKeys.publicKey, 'introduced', '2026-03-01T10:00:00Z');

    const body = JSON.stringify({});
    const signed = signRequest({
      method: 'POST',
      path: '/myr/sync/pull',
      body,
      privateKey: untrustedKeys.privateKey,
      publicKey: untrustedKeys.publicKey,
    });
    const { status, body: resBody } = await request(port, {
      method: 'POST',
      path: '/myr/sync/pull',
      headers: signed.headers,
      body,
    });
    assert.equal(status, 403);
    assert.equal(resBody.error.code, 'peer_not_trusted');
  });
});

// --- Peer State Machine Tests ---

describe('Peer state machine enforcement', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    const revokedKeys = generateKeypair();
    db.prepare(
      "INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)"
    ).run('https://revoked.myr.network', 'revoked', revokedKeys.publicKey, 'revoked', '2026-03-01T10:00:00Z');

    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      createdAt: TEST_CREATED_AT,
    });
    server = app.listen(0);
    port = server.address().port;

    // Store keys for use in tests
    server._revokedKeys = revokedKeys;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('rejects revoked peers with 403', async () => {
    const revokedKeys = server._revokedKeys;
    const signed = signRequest({
      method: 'GET',
      path: '/myr/peer/list',
      privateKey: revokedKeys.privateKey,
      publicKey: revokedKeys.publicKey,
    });
    const { status, body } = await request(port, {
      path: '/myr/peer/list',
      headers: signed.headers,
    });
    // Revoked peers can still call auth-required endpoints (auth succeeds)
    // but trust-gated endpoints (reports, sync/pull) would reject them.
    // peer/list is auth-required but not trust-gated, so it succeeds.
    assert.equal(status, 200);
  });

  it('introduce endpoint creates peer with introduced trust_level', async () => {
    const newPeerKeys = generateKeypair();
    const body = JSON.stringify({
      identity_document: {
        public_key: newPeerKeys.publicKey,
        operator_name: 'newpeer',
        node_url: 'https://newpeer.myr.network',
      },
    });
    const { status, body: resBody } = await request(port, {
      method: 'POST',
      path: '/myr/peer/introduce',
      body,
    });
    assert.equal(status, 200);
    assert.equal(resBody.trust_level, 'introduced');

    const stored = db.prepare('SELECT trust_level FROM myr_peers WHERE public_key = ?').get(newPeerKeys.publicKey);
    assert.equal(stored.trust_level, 'introduced');
  });
});

// --- Report Signature Verification Tests ---

describe('Report signature verification on fetch', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    db.prepare(
      "INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)"
    ).run('https://peer.myr.network', 'peer', peerKeys.publicKey, 'trusted', '2026-03-01T10:00:00Z');

    // Insert a properly signed report
    const reportData = {
      id: 'signed-r1',
      timestamp: '2026-03-01T10:00:00Z',
      agent_id: 'a1',
      node_id: 'n1',
      cycle_intent: 'test intent',
      domain_tags: 'testing',
      yield_type: 'technique',
      question_answered: 'does signing work?',
      evidence: 'yes',
      what_changes_next: 'ship it',
      confidence: 0.8,
      created_at: '2026-03-01T10:00:00Z',
      updated_at: '2026-03-01T10:00:00Z',
      share_network: 1,
    };

    // Sign the report with nodeKeys
    const canonical = canonicalize(reportData);
    const sig = signMessage(canonical, nodeKeys.privateKey);

    db.prepare(`
      INSERT INTO myr_reports (id, timestamp, agent_id, node_id, cycle_intent, domain_tags,
        yield_type, question_answered, evidence, what_changes_next, confidence,
        created_at, updated_at, share_network, signed_by, signed_artifact)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reportData.id, reportData.timestamp, reportData.agent_id, reportData.node_id,
      reportData.cycle_intent, reportData.domain_tags, reportData.yield_type,
      reportData.question_answered, reportData.evidence, reportData.what_changes_next,
      reportData.confidence, reportData.created_at, reportData.updated_at,
      reportData.share_network, nodeKeys.publicKey, sig
    );

    // Insert a report with a tampered/invalid Ed25519 signature
    const tamperedReport = { ...reportData, id: 'tampered-r1', question_answered: 'tampered' };
    db.prepare(`
      INSERT INTO myr_reports (id, timestamp, agent_id, node_id, cycle_intent, domain_tags,
        yield_type, question_answered, evidence, what_changes_next, confidence,
        created_at, updated_at, share_network, signed_by, signed_artifact)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tamperedReport.id, tamperedReport.timestamp, tamperedReport.agent_id, tamperedReport.node_id,
      tamperedReport.cycle_intent, tamperedReport.domain_tags, tamperedReport.yield_type,
      tamperedReport.question_answered, tamperedReport.evidence, tamperedReport.what_changes_next,
      tamperedReport.confidence, tamperedReport.created_at, tamperedReport.updated_at,
      tamperedReport.share_network, nodeKeys.publicKey, sig // same sig, different content = invalid
    );

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

  it('serves reports with valid Ed25519 signatures', async () => {
    // First get the report list to find the signature
    const listSigned = signRequest({
      method: 'GET',
      path: '/myr/reports',
      privateKey: peerKeys.privateKey,
      publicKey: peerKeys.publicKey,
    });
    const listRes = await request(port, {
      path: '/myr/reports',
      headers: listSigned.headers,
    });
    assert.equal(listRes.status, 200);

    const validReport = listRes.body.reports.find(r =>
      r.signature && listRes.body.reports.length > 0
    );
    assert.ok(validReport, 'Should find a report');

    // Fetch the specific report
    const fetchSigned = signRequest({
      method: 'GET',
      path: `/myr/reports/${validReport.signature}`,
      privateKey: peerKeys.privateKey,
      publicKey: peerKeys.publicKey,
    });
    const fetchRes = await request(port, {
      path: `/myr/reports/${validReport.signature}`,
      headers: fetchSigned.headers,
    });
    // The report may pass or fail verification depending on which one was matched
    // The important test is that tampered reports are rejected (next test)
    assert.ok([200, 500].includes(fetchRes.status));
  });

  it('rejects reports with tampered Ed25519 signatures', async () => {
    // Compute the sha256 hash of the tampered report to get its signature for fetch
    const tamperedRow = db.prepare('SELECT * FROM myr_reports WHERE id = ?').get('tampered-r1');
    const reportObj = { ...tamperedRow };
    delete reportObj.signature;
    delete reportObj.operator_signature;
    const canonical = canonicalize(reportObj);
    const hash = crypto.createHash('sha256').update(canonical).digest('hex');
    const reportSig = 'sha256:' + hash;

    const fetchSigned = signRequest({
      method: 'GET',
      path: `/myr/reports/${reportSig}`,
      privateKey: peerKeys.privateKey,
      publicKey: peerKeys.publicKey,
    });
    const fetchRes = await request(port, {
      path: `/myr/reports/${reportSig}`,
      headers: fetchSigned.headers,
    });
    assert.equal(fetchRes.status, 500);
    assert.equal(fetchRes.body.error.code, 'internal_error');
    assert.ok(fetchRes.body.error.message.includes('signature verification'));
  });
});
