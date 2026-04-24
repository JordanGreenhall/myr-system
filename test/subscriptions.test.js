'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair } = require('../lib/crypto');
const { createSignedSignal } = require('../lib/subscriptions');
const { authedRequest } = require('./helpers/peerRequest');

const localKeys = generateKeypair();
const peerKeys = generateKeypair();

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
      peer_url TEXT,
      operator_name TEXT NOT NULL,
      public_key TEXT UNIQUE NOT NULL,
      trust_level TEXT DEFAULT 'pending',
      added_at TEXT NOT NULL,
      approved_at TEXT,
      last_sync_at TEXT,
      auto_sync INTEGER DEFAULT 1
    );

    CREATE TABLE myr_nonces (
      nonce TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX idx_nonces_expires ON myr_nonces(expires_at);

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
  `);

  return db;
}

function seed(db) {
  const insertReport = db.prepare(`
    INSERT INTO myr_reports (
      id, timestamp, agent_id, node_id, cycle_intent, domain_tags, yield_type,
      question_answered, evidence, what_changes_next, confidence, operator_rating,
      created_at, updated_at, share_network
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertReport.run(
    'r-crypto',
    '2026-04-17T10:00:00Z',
    'agent-1',
    'node-1',
    'crypto sync',
    JSON.stringify(['cryptography']),
    'insight',
    'what changed?',
    'new curve attack',
    'harden checks',
    0.8,
    4,
    '2026-04-17T10:00:00Z',
    '2026-04-17T10:00:00Z',
    1
  );
  insertReport.run(
    'r-bio',
    '2026-04-17T11:00:00Z',
    'agent-1',
    'node-1',
    'bio sync',
    JSON.stringify(['biology']),
    'insight',
    'what changed?',
    'lab observation',
    'rerun experiment',
    0.7,
    3,
    '2026-04-17T11:00:00Z',
    '2026-04-17T11:00:00Z',
    1
  );

  db.prepare(`
    INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at)
    VALUES (?, ?, ?, 'trusted', ?)
  `).run('http://peer-a.test', 'peer-a', peerKeys.publicKey, '2026-04-17T09:00:00Z');
}

describe('Demand signals and subscription routing', () => {
  let db;
  let server;
  let port;

  before(() => {
    db = createTestDb();
    seed(db);
    const app = createApp({
      config: {
        operator_name: 'local-op',
        node_url: 'http://localhost',
        port: 0,
        subscription_propagation_hops: 2,
      },
      db,
      publicKeyHex: localKeys.publicKey,
      privateKeyHex: localKeys.privateKey,
      createdAt: '2026-04-17T09:00:00Z',
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('local operator can create and list subscriptions', async () => {
    const createRes = await authedRequest(port, {
      method: 'POST',
      path: '/myr/subscriptions',
      keys: localKeys,
      body: {
        tags: ['cryptography'],
        intent_description: 'only crypto-demanded yield',
      },
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.subscription.status, 'active');
    assert.deepEqual(createRes.body.subscription.tags, ['cryptography']);

    const listRes = await authedRequest(port, {
      path: '/myr/subscriptions',
      keys: localKeys,
    });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.subscriptions.length, 1);
    assert.equal(listRes.body.subscriptions[0].status, 'active');
  });

  it('trusted peer receives only reports matching active subscriptions', async () => {
    const signal = createSignedSignal({
      ownerPublicKey: peerKeys.publicKey,
      ownerOperatorName: 'peer-a',
      tags: ['cryptography'],
      intentDescription: 'peer demand',
      privateKey: peerKeys.privateKey,
    });

    const subRes = await authedRequest(port, {
      method: 'POST',
      path: '/myr/subscriptions',
      keys: peerKeys,
      body: {
        ...signal,
        hops_remaining: 0,
      },
    });
    assert.equal(subRes.status, 200);

    const reportsRes = await authedRequest(port, {
      path: '/myr/reports',
      keys: peerKeys,
    });
    assert.equal(reportsRes.status, 200);
    assert.equal(reportsRes.body.filtered_by_subscriptions, true);
    assert.equal(reportsRes.body.total, 1);
    assert.equal(reportsRes.body.reports[0].method_name, 'crypto sync');
  });

  it('rejects remote subscription signals with invalid signature', async () => {
    const signal = createSignedSignal({
      ownerPublicKey: peerKeys.publicKey,
      ownerOperatorName: 'peer-a',
      tags: ['biology'],
      privateKey: peerKeys.privateKey,
    });

    const badRes = await authedRequest(port, {
      method: 'POST',
      path: '/myr/subscriptions',
      keys: peerKeys,
      body: {
        ...signal,
        signal_signature: '00'.repeat(64),
        hops_remaining: 0,
      },
    });
    assert.equal(badRes.status, 400);
    assert.equal(badRes.body.error.code, 'invalid_signature');
  });
});
