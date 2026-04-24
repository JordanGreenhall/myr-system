'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const http = require('http');
const { createApp } = require('../server/index');
const { generateKeypair } = require('../lib/crypto');
const { authedRequest } = require('./helpers/peerRequest');

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
  db.exec(`
    CREATE TABLE myr_reports (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      cycle_intent TEXT NOT NULL,
      domain_tags TEXT NOT NULL,
      cycle_context TEXT,
      yield_type TEXT NOT NULL,
      question_answered TEXT NOT NULL,
      evidence TEXT NOT NULL,
      what_changes_next TEXT NOT NULL,
      what_was_falsified TEXT,
      confidence REAL NOT NULL DEFAULT 0.7,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      operator_rating INTEGER
    );

    CREATE VIRTUAL TABLE myr_fts USING fts5(
      id,
      cycle_intent,
      cycle_context,
      question_answered,
      evidence,
      what_changes_next,
      what_was_falsified,
      domain_tags,
      content=myr_reports,
      content_rowid=rowid
    );

    CREATE TRIGGER myr_fts_insert AFTER INSERT ON myr_reports BEGIN
      INSERT INTO myr_fts(rowid, id, cycle_intent, question_answered, evidence, what_changes_next, domain_tags)
      VALUES (new.rowid, new.id, new.cycle_intent, new.question_answered, new.evidence, new.what_changes_next, new.domain_tags);
    END;

    CREATE TABLE myr_peers (
      id INTEGER PRIMARY KEY,
      peer_url TEXT,
      operator_name TEXT,
      public_key TEXT UNIQUE NOT NULL,
      trust_level TEXT DEFAULT 'pending',
      added_at TEXT NOT NULL,
      approved_at TEXT,
      participation_stage TEXT DEFAULT 'local-only',
      stage_changed_at TEXT,
      stage_evidence TEXT
    );

    CREATE TABLE myr_nonces (
      nonce TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE myr_traces (
      trace_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('introduce','approve','share','sync_pull','sync_push','verify','reject','discover','relay_sync','revoke','quarantine','stage_change')),
      actor_fingerprint TEXT NOT NULL,
      target_fingerprint TEXT,
      artifact_signature TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','rejected')),
      rejection_reason TEXT,
      metadata TEXT DEFAULT '{}'
    );
  `);
  return db;
}

describe('governance endpoints', () => {
  let db;
  let server;
  let port;
  let localKeys;
  let peerKeys;

  before(() => {
    db = createTestDb();
    localKeys = generateKeypair();
    peerKeys = generateKeypair();

    db.prepare(`
      INSERT INTO myr_reports (
        id, timestamp, agent_id, node_id, cycle_intent, domain_tags,
        yield_type, question_answered, evidence, what_changes_next, confidence,
        created_at, updated_at, operator_rating
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'r-governance-1',
      '2026-04-16T00:00:00Z',
      'agent1',
      'n1',
      'Check governance',
      '["governance","sync"]',
      'insight',
      'What governance guardrails are needed?',
      'Trace and quarantine tools enabled',
      'Use explicit governance endpoints',
      0.9,
      '2026-04-16T00:00:00Z',
      '2026-04-16T00:00:00Z',
      5
    );

    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      'https://peer.example',
      'peer1',
      peerKeys.publicKey,
      'trusted',
      '2026-04-16T00:00:00Z',
      '2026-04-16T00:01:00Z'
    );

    const app = createApp({
      config: {
        node_id: 'n-local',
        operator_name: 'local',
        node_url: 'http://localhost:0',
        port: 0,
      },
      db,
      publicKeyHex: localKeys.publicKey,
      privateKeyHex: localKeys.privateKey,
      createdAt: '2026-04-16T00:00:00Z',
    });

    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('POST /myr/governance/revoke revokes a peer', async () => {
    const fpPrefix = peerKeys.publicKey.slice(0, 12);
    const res = await authedRequest(port, {
      method: 'POST',
      path: '/myr/governance/revoke',
      keys: localKeys,
      body: { peer_fingerprint: fpPrefix },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'revoked');

    const row = db.prepare('SELECT trust_level FROM myr_peers WHERE public_key = ?').get(peerKeys.publicKey);
    assert.equal(row.trust_level, 'revoked');
  });

  it('POST /myr/governance/quarantine excludes yield from recall', async () => {
    const q = await authedRequest(port, {
      method: 'POST',
      path: '/myr/governance/quarantine',
      keys: localKeys,
      body: { yield_id: 'r-governance-1', reason: 'pending operator review' },
    });

    assert.equal(q.status, 200);
    assert.equal(q.body.status, 'quarantined');

    const recallRes = await get(port, '/myr/recall?intent=governance');
    assert.equal(recallRes.status, 200);
    assert.ok(!recallRes.body.results.some((r) => r.id === 'r-governance-1'));
    assert.ok(!recallRes.body.falsifications.some((r) => r.id === 'r-governance-1'));
  });

  it('GET /myr/governance/audit returns governance trail', async () => {
    const res = await authedRequest(port, {
      method: 'GET',
      path: '/myr/governance/audit?limit=50',
      keys: localKeys,
    });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.audit.approvals));
    assert.ok(Array.isArray(res.body.audit.revocations));
    assert.ok(Array.isArray(res.body.audit.sync_events));
    assert.ok(Array.isArray(res.body.audit.quarantines));
    assert.ok(Array.isArray(res.body.audit.quarantined_yields));
    assert.ok(res.body.audit.revocations.length >= 1);
    assert.ok(res.body.audit.quarantined_yields.length >= 1);
  });
});
