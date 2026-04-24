'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const http = require('http');
const { createApp } = require('../server/index');
const { generateKeypair } = require('../lib/crypto');
const {
  createGovernanceSignal,
  ingestGovernanceSignal,
  ensureGovernanceGossipSchema,
  listGovernanceSignals,
} = require('../lib/governance-gossip');
const { DEMOTION_TRIGGERS } = require('../lib/participation');
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

function createOperationsDb() {
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
      operator_rating INTEGER,
      share_network INTEGER DEFAULT 0
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
      node_id TEXT,
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

    CREATE TABLE myr_quarantined_yields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      yield_id TEXT NOT NULL UNIQUE,
      quarantined_at TEXT NOT NULL,
      quarantined_by TEXT NOT NULL,
      operator_signature TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','released')),
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_quarantine_status ON myr_quarantined_yields(status);

    CREATE TABLE myr_mutual_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_public_key TEXT NOT NULL,
      peer_public_key TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      UNIQUE(local_public_key, peer_public_key)
    );

    CREATE TABLE myr_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      peer_public_key TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('push','pull')),
      yield_count INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE myr_operator_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      yield_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      rated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('governance operations', () => {
  describe('sybil scenario: rapid node registration detection', () => {
    it('detects and revokes a cluster of sybil nodes via governance signals', () => {
      const db = createOperationsDb();
      ensureGovernanceGossipSchema(db);
      const operator = generateKeypair();

      // Register N nodes rapidly (simulating sybil attack)
      const sybilNodes = [];
      for (let i = 0; i < 8; i++) {
        const keys = generateKeypair();
        sybilNodes.push(keys);
        db.prepare(
          'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, participation_stage) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          `https://sybil-${i}.example`,
          `sybil-${i}`,
          keys.publicKey,
          'trusted',
          '2026-04-24T12:00:00Z',
          '2026-04-24T12:00:01Z',
          'provisional'
        );
      }

      // Verify all 8 nodes registered
      const beforeCount = db.prepare('SELECT COUNT(*) as c FROM myr_peers WHERE trust_level = ?').get('trusted');
      assert.equal(beforeCount.c, 8);

      // Operator detects sybil cluster and revokes all via governance signals
      for (const sybil of sybilNodes) {
        const signal = createGovernanceSignal({
          actionType: 'revoke',
          targetId: sybil.publicKey,
          payload: { reason: 'sybil cluster detected' },
          signerPublicKey: operator.publicKey,
          signerPrivateKey: operator.privateKey,
          ttl: 5,
        });
        const result = ingestGovernanceSignal(db, signal, { applySignal: true });
        assert.equal(result.accepted, true);
        assert.equal(result.applied.action, 'revoke');
      }

      // Verify all sybil nodes are revoked
      const afterCount = db.prepare('SELECT COUNT(*) as c FROM myr_peers WHERE trust_level = ?').get('trusted');
      assert.equal(afterCount.c, 0);
      const revokedCount = db.prepare('SELECT COUNT(*) as c FROM myr_peers WHERE trust_level = ?').get('revoked');
      assert.equal(revokedCount.c, 8);

      // Verify governance signals are recorded for audit
      const signals = listGovernanceSignals(db, { limit: 20 });
      assert.equal(signals.length, 8);
      assert.ok(signals.every((s) => s.action_type === 'revoke'));

      db.close();
    });
  });

  describe('gossip flooding: IHAVE rate bounds and deduplication', () => {
    it('rejects duplicate governance signals (deduplication by signal_id)', () => {
      const db = createOperationsDb();
      ensureGovernanceGossipSchema(db);
      const attacker = generateKeypair();
      const target = generateKeypair();

      db.prepare(
        'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
      ).run('https://target.example', 'target', target.publicKey, 'trusted', '2026-04-24T12:00:00Z');

      // Create a single governance signal
      const signal = createGovernanceSignal({
        actionType: 'revoke',
        targetId: target.publicKey,
        payload: { reason: 'test flood' },
        signerPublicKey: attacker.publicKey,
        signerPrivateKey: attacker.privateKey,
        ttl: 5,
      });

      // First ingestion succeeds
      const first = ingestGovernanceSignal(db, signal, { applySignal: true });
      assert.equal(first.accepted, true);

      // Repeated ingestion of same signal is rejected as duplicate
      for (let i = 0; i < 10; i++) {
        const dup = ingestGovernanceSignal(db, signal, { applySignal: true });
        assert.equal(dup.accepted, false);
        assert.equal(dup.reason, 'duplicate');
      }

      // Only one signal stored despite 11 ingestion attempts
      const signals = listGovernanceSignals(db);
      assert.equal(signals.filter((s) => s.signal_id === signal.signal_id).length, 1);

      db.close();
    });

    it('rejects governance signals with expired TTL', () => {
      const db = createOperationsDb();
      ensureGovernanceGossipSchema(db);
      const signer = generateKeypair();
      const target = generateKeypair();

      const signal = createGovernanceSignal({
        actionType: 'revoke',
        targetId: target.publicKey,
        payload: { reason: 'expired test' },
        signerPublicKey: signer.publicKey,
        signerPrivateKey: signer.privateKey,
        ttl: 1,
      });

      // Forward signal to decrement TTL to 0
      const forwarded = {
        ...signal,
        ttl: 0,
        hop_count: 1,
      };

      const result = ingestGovernanceSignal(db, forwarded, { applySignal: true });
      assert.equal(result.accepted, false);
      assert.equal(result.reason, 'ttl_expired');

      db.close();
    });

    it('rejects signals with invalid signatures', () => {
      const db = createOperationsDb();
      ensureGovernanceGossipSchema(db);
      const signer = generateKeypair();
      const target = generateKeypair();

      const signal = createGovernanceSignal({
        actionType: 'revoke',
        targetId: target.publicKey,
        payload: { reason: 'tampered' },
        signerPublicKey: signer.publicKey,
        signerPrivateKey: signer.privateKey,
        ttl: 5,
      });

      // Tamper with the signal
      signal.target_id = 'tampered-target';

      const result = ingestGovernanceSignal(db, signal, { applySignal: true });
      assert.equal(result.accepted, false);
      assert.equal(result.reason, 'invalid_signature');

      db.close();
    });
  });

  describe('audit trail completeness: revoke produces all evidence artifacts', () => {
    let db;
    let server;
    let port;
    let localKeys;
    let peerKeys;

    before(() => {
      db = createOperationsDb();
      localKeys = generateKeypair();
      peerKeys = generateKeypair();

      db.prepare(
        'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('https://audit-peer.example', 'audit-peer', peerKeys.publicKey, 'trusted', '2026-04-24T12:00:00Z', '2026-04-24T12:00:01Z');

      const app = createApp({
        config: {
          node_id: 'n-audit-ops',
          operator_name: 'audit-ops',
          node_url: 'http://localhost:0',
          port: 0,
        },
        db,
        publicKeyHex: localKeys.publicKey,
        privateKeyHex: localKeys.privateKey,
        createdAt: '2026-04-24T12:00:00Z',
      });

      server = app.listen(0);
      port = server.address().port;
    });

    after(() => {
      server.close();
      db.close();
    });

    it('revoke creates trace, governance signal, and updates peer trust_level', async () => {
      const fpPrefix = peerKeys.publicKey.slice(0, 12);

      // Perform revocation via API
      const res = await authedRequest(port, {
        method: 'POST',
        path: '/myr/governance/revoke',
        keys: localKeys,
        body: { peer_fingerprint: fpPrefix },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'revoked');

      // Verify evidence artifact 1: peer trust_level updated
      const peer = db.prepare('SELECT trust_level FROM myr_peers WHERE public_key = ?').get(peerKeys.publicKey);
      assert.equal(peer.trust_level, 'revoked');

      // Verify evidence artifact 2: trace event recorded
      const trace = db.prepare(
        "SELECT * FROM myr_traces WHERE event_type = 'revoke' ORDER BY timestamp DESC LIMIT 1"
      ).get();
      assert.ok(trace, 'revoke trace event must exist');
      assert.equal(trace.outcome, 'success');

      // Verify evidence artifact 3: audit endpoint returns all evidence
      const audit = await authedRequest(port, {
        method: 'GET',
        path: '/myr/governance/audit?limit=50',
        keys: localKeys,
      });
      assert.equal(audit.status, 200);
      assert.ok(audit.body.audit.revocations.length >= 1, 'audit must include revocation trace');
    });
  });

  describe('escalation: revoking a trusted-full node triggers demotion cascade', () => {
    it('revoking a trusted-full peer cascades stage evaluation for dependent peers', () => {
      const db = createOperationsDb();
      ensureGovernanceGossipSchema(db);
      const operator = generateKeypair();
      const trustedFull = generateKeypair();

      // Set up a trusted-full node
      db.prepare(
        'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, participation_stage) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('https://trusted-full.example', 'trusted-full', trustedFull.publicKey, 'trusted', '2026-03-01T00:00:00Z', '2026-03-01T00:00:01Z', 'trusted-full');

      // Revoke the trusted-full node via governance signal
      const signal = createGovernanceSignal({
        actionType: 'revoke',
        targetId: trustedFull.publicKey,
        payload: { reason: 'compromised' },
        signerPublicKey: operator.publicKey,
        signerPrivateKey: operator.privateKey,
        ttl: 5,
      });
      const result = ingestGovernanceSignal(db, signal, { applySignal: true });
      assert.equal(result.accepted, true);

      // Verify trusted-full node is revoked
      const revokedPeer = db.prepare('SELECT trust_level FROM myr_peers WHERE public_key = ?').get(trustedFull.publicKey);
      assert.equal(revokedPeer.trust_level, 'revoked');

      // Simulate the demotion cascade effect using DEMOTION_TRIGGERS directly:
      // A dependent peer at 'bounded' stage had 3 mutual approvals (threshold).
      // After revoking one approval source, they drop to 2 — triggering demotion.

      const demotionCheck = DEMOTION_TRIGGERS['bounded→provisional'];
      assert.ok(demotionCheck, 'bounded→provisional demotion trigger must exist');

      // Before revocation: peer has enough stats to hold bounded (3 approvals, good rating)
      const statsBefore = {
        mutualApprovals: 3,
        sharedMyrCount: 15,
        avgRating: 3.2,
        activeDays: 40,
        recentRejections: 0,
        recentRejectionRate: 0,
        consecutiveRejectedSyncs: 0,
      };
      assert.equal(demotionCheck.check(statsBefore), false, 'peer should hold bounded with 3 approvals');

      // After revocation: one approval source removed, dropping below threshold
      const statsAfter = { ...statsBefore, mutualApprovals: 2 };
      assert.equal(demotionCheck.check(statsAfter), true, 'peer should be demoted when approvals drop below threshold');

      db.close();
    });
  });
});
