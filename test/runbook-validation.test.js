'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair, fingerprint: computeFingerprint } = require('../lib/crypto');
const { signRequest } = require('./helpers/signRequest');

function request(port, { method = 'GET', path: urlPath, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: urlPath,
        method,
        headers: {
          ...headers,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function authedRequest(port, { method = 'GET', path: urlPath, body, keys }) {
  const signPath = urlPath.split('?')[0];
  const signed = signRequest({
    method,
    path: signPath,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    body: body === undefined ? undefined : body,
  });
  return request(port, {
    method,
    path: urlPath,
    headers: signed.headers,
    body,
  });
}

function createTestDb(target = ':memory:') {
  const db = new Database(target);
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
  `);
  return db;
}

describe('Runbook validation simulations', () => {
  it('simulates node crash recovery and verifies health + metrics after WAL restart', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myr-runbook-wal-'));
    const dbPath = path.join(tmp, 'myr.db');
    const localKeys = generateKeypair();

    let db = createTestDb(dbPath);
    db.prepare(`
      INSERT INTO myr_reports (
        id, timestamp, agent_id, node_id, cycle_intent, domain_tags, yield_type,
        question_answered, evidence, what_changes_next, confidence, created_at, updated_at, share_network, imported_from
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'wal-1', '2026-04-01T00:00:00Z', 'agent', 'node', 'crash simulation', 'ops',
      'insight', 'q', 'e', 'next', 0.8, '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', 1, null
    );
    db.close();

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    let server;
    try {
      const app = createApp({
        config: { node_id: 'runbook-node', node_name: 'Runbook Node', operator_name: 'ops', node_url: 'http://localhost', port: 0 },
        db,
        publicKeyHex: localKeys.publicKey,
        privateKeyHex: localKeys.privateKey,
        createdAt: '2026-04-01T00:00:00Z',
      });
      server = app.listen(0);
      const port = server.address().port;

      const health = await request(port, { path: '/myr/health' });
      const metrics = await authedRequest(port, { path: '/myr/metrics', keys: localKeys });

      assert.equal(health.status, 200);
      assert.equal(metrics.status, 200);
      assert.ok(metrics.body.reports.local >= 1);
    } finally {
      if (server) server.close();
      db.close();
    }
  });

  it('simulates key compromise runbook with revoke + rotate + governance audit validation', async () => {
    const localKeys = generateKeypair();
    const compromisedPeer = generateKeypair();
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, last_sync_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('https://compromised.node', 'compromised', compromisedPeer.publicKey, 'trusted', now, now, now);

    let server;
    try {
      const app = createApp({
        config: { node_id: 'runbook-node', node_name: 'Runbook Node', operator_name: 'ops', node_url: 'http://localhost', port: 0 },
        db,
        publicKeyHex: localKeys.publicKey,
        privateKeyHex: localKeys.privateKey,
        createdAt: '2026-04-01T00:00:00Z',
      });
      server = app.listen(0);
      const port = server.address().port;

      const revokeRes = await authedRequest(port, {
        method: 'POST',
        path: '/myr/governance/revoke',
        keys: localKeys,
        body: { peer_fingerprint: computeFingerprint(compromisedPeer.publicKey) },
      });
      assert.equal(revokeRes.status, 200);
      assert.equal(revokeRes.body.status, 'revoked');

      const rotateRes = await authedRequest(port, {
        method: 'POST',
        path: '/myr/governance/key-rotate',
        keys: localKeys,
        body: { node_id: 'runbook-node' },
      });
      assert.equal(rotateRes.status, 200);
      assert.equal(rotateRes.body.status, 'rotation_announced');
      assert.ok(rotateRes.body.announcement);

      const auditRes = await authedRequest(port, {
        method: 'GET',
        path: '/myr/governance/audit?limit=50',
        keys: localKeys,
      });
      assert.equal(auditRes.status, 200);
      assert.ok(auditRes.body.audit.revocations.length >= 1);
      assert.ok(auditRes.body.audit.governance_signals.some((s) => s.action_type === 'revoke'));
      assert.ok(auditRes.body.audit.governance_signals.some((s) => s.action_type === 'key_rotation'));
    } finally {
      if (server) server.close();
      db.close();
    }
  });

  it('simulates gossip contamination recovery by flushing peer state and re-bootstrapping sync health', async () => {
    const localKeys = generateKeypair();
    const stalePeer = generateKeypair();
    const db = createTestDb();
    const staleTime = '2026-03-01T00:00:00Z';
    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, last_sync_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('https://stale.node', 'stale-node', stalePeer.publicKey, 'introduced', staleTime, null, staleTime);

    let server;
    try {
      const app = createApp({
        config: { node_id: 'runbook-node', node_name: 'Runbook Node', operator_name: 'ops', node_url: 'http://localhost', port: 0 },
        db,
        publicKeyHex: localKeys.publicKey,
        privateKeyHex: localKeys.privateKey,
        createdAt: '2026-04-01T00:00:00Z',
      });
      server = app.listen(0);
      const port = server.address().port;

      const preHealth = await request(port, { path: '/myr/health/network' });
      assert.equal(preHealth.status, 200);
      assert.ok(preHealth.body.metrics.reachability_ratio <= 0.5);

      const flushRes = await authedRequest(port, {
        method: 'POST',
        path: '/myr/governance/revoke',
        keys: localKeys,
        body: { peer_fingerprint: computeFingerprint(stalePeer.publicKey) },
      });
      assert.equal(flushRes.status, 200);

      const rebootstrapRes = await request(port, {
        method: 'POST',
        path: '/myr/peer/introduce',
        body: {
          identity_document: {
            public_key: stalePeer.publicKey,
            operator_name: 'stale-node',
            node_url: 'https://stale.node',
            fingerprint: computeFingerprint(stalePeer.publicKey),
            protocol_version: '1.2.0',
          },
        },
      });
      assert.equal(rebootstrapRes.status, 200);
      assert.equal(rebootstrapRes.body.trust_level, 'trusted');

      const syncPullRes = await authedRequest(port, {
        method: 'POST',
        path: '/myr/sync/pull',
        keys: stalePeer,
        body: {},
      });
      assert.equal(syncPullRes.status, 200);

      const postHealth = await request(port, { path: '/myr/health/network' });
      assert.equal(postHealth.status, 200);
      assert.ok(postHealth.body.metrics.reachability_ratio >= preHealth.body.metrics.reachability_ratio);
    } finally {
      if (server) server.close();
      db.close();
    }
  });
});
