'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair } = require('../lib/crypto');
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
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function authedGet(port, path, keys) {
  const signed = signRequest({
    method: 'GET',
    path,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });
  return request(port, { method: 'GET', path, headers: signed.headers });
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
      imported_from TEXT
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
    CREATE TABLE myr_traces (
      trace_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_fingerprint TEXT NOT NULL,
      target_fingerprint TEXT,
      artifact_signature TEXT,
      outcome TEXT NOT NULL,
      rejection_reason TEXT,
      metadata TEXT DEFAULT '{}'
    );
    CREATE TABLE myr_nonces (
      nonce TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE myr_routing_cycles (
      cycle_id TEXT PRIMARY KEY,
      peer_public_key TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      bytes_sent INTEGER NOT NULL DEFAULT 0,
      bytes_received INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

const TEST_CONFIG = {
  node_id: 'metrics-node',
  node_name: 'Metrics Node',
  operator_name: 'metrics-operator',
  node_url: 'https://metrics.myr.network',
  port: 0,
};

describe('GET /myr/metrics', () => {
  const localKeys = generateKeypair();
  const trustedPeerKeys = generateKeypair();
  const unknownKeys = generateKeypair();
  let server;
  let port;
  let db;

  before(() => {
    db = createTestDb();

    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, last_sync_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('https://peer1.myr.network', 'peer1', trustedPeerKeys.publicKey, 'trusted', '2026-04-01T00:00:00Z', new Date().toISOString());
    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, last_sync_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('https://peer2.myr.network', 'peer2', generateKeypair().publicKey, 'pending', '2026-04-01T00:00:00Z', null);

    db.prepare(`
      INSERT INTO myr_reports (
        id, timestamp, agent_id, node_id, cycle_intent, domain_tags, yield_type,
        question_answered, evidence, what_changes_next, confidence, created_at, updated_at, share_network, imported_from
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'm1', '2026-04-01T00:00:00Z', 'a1', 'n1', 'local report', '["ops","security"]',
      'insight', 'q1', 'e1', 'n1', 0.8, '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', 1, null
    );
    db.prepare(`
      INSERT INTO myr_reports (
        id, timestamp, agent_id, node_id, cycle_intent, domain_tags, yield_type,
        question_answered, evidence, what_changes_next, confidence, created_at, updated_at, share_network, imported_from
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'm2', '2026-04-01T00:10:00Z', 'a2', 'n2', 'imported report', 'ops',
      'pattern', 'q2', 'e2', 'n2', 0.7, '2026-04-01T00:10:00Z', '2026-04-01T00:10:00Z', 0, 'peer1'
    );

    db.prepare(`
      INSERT INTO myr_traces (
        trace_id, timestamp, event_type, actor_fingerprint, target_fingerprint,
        artifact_signature, outcome, rejection_reason, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('t1', '2026-04-01T00:15:00Z', 'sync_pull', 'a', 'b', null, 'success', null, '{}');
    db.prepare(`
      INSERT INTO myr_traces (
        trace_id, timestamp, event_type, actor_fingerprint, target_fingerprint,
        artifact_signature, outcome, rejection_reason, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('t2', '2026-04-01T00:16:00Z', 'gossip_ihave', 'a', 'b', null, 'sent', null, '{}');

    db.prepare(`
      INSERT INTO myr_routing_cycles (
        cycle_id, peer_public_key, started_at, ended_at, bytes_sent, bytes_received
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('c1', trustedPeerKeys.publicKey, '2026-04-01T00:00:00Z', '2026-04-01T00:01:00Z', 10, 20);

    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: localKeys.publicKey,
      privateKeyHex: localKeys.privateKey,
      createdAt: '2026-04-01T00:00:00Z',
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('rejects unauthenticated callers', async () => {
    const { status, body } = await request(port, { path: '/myr/metrics' });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'auth_required');
  });

  it('allows trusted peers and returns required metrics sections', async () => {
    const { status, body } = await authedGet(port, '/myr/metrics', trustedPeerKeys);
    assert.equal(status, 200);

    assert.ok(body.node);
    assert.ok(body.peers);
    assert.ok(body.reports);
    assert.ok(body.sync);
    assert.ok(body.gossip);

    assert.equal(typeof body.node.uptime_seconds, 'number');
    assert.equal(typeof body.peers.total, 'number');
    assert.equal(typeof body.peers.trusted, 'number');
    assert.equal(typeof body.peers.active_gossip_view, 'number');
    assert.equal(typeof body.reports.local, 'number');
    assert.equal(typeof body.reports.imported, 'number');
    assert.equal(typeof body.reports.by_domain, 'object');
    assert.ok('last_sync_at' in body.sync);
    assert.ok('sync_lag_seconds' in body.sync);
    assert.ok('messages_per_cycle' in body.sync);
    assert.equal(typeof body.gossip.active_view_size, 'number');
    assert.equal(typeof body.gossip.passive_view_size, 'number');
    assert.equal(typeof body.gossip.ihave_sent, 'number');
    assert.equal(typeof body.gossip.ihave_received, 'number');
    assert.equal(typeof body.gossip.iwant_sent, 'number');
    assert.equal(typeof body.gossip.iwant_received, 'number');
    assert.ok(body.slo);
    assert.ok(body.onboarding);
    assert.ok(body.governance);
    assert.ok('slo_sync_freshness_compliant_pct' in body);
    assert.ok('slo_gossip_health_compliant_pct' in body);
    assert.ok('slo_governance_propagation_p99_seconds' in body);
    assert.ok('slo_onboarding_success_p95_seconds' in body);
    assert.ok('slo_uptime_pct' in body);
    assert.equal(typeof body.slo_uptime_pct, 'number');
  });

  it('rejects unknown authenticated peers', async () => {
    const { status, body } = await authedGet(port, '/myr/metrics', unknownKeys);
    assert.equal(status, 403);
    assert.equal(body.error.code, 'unknown_peer');
  });
});
