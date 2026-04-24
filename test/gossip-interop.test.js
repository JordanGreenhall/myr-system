'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { canonicalize } = require('../lib/canonicalize');
const { generateKeypair } = require('../lib/crypto');
const { syncPeer, httpFetch } = require('../lib/sync');

function createSyncDb() {
  const db = new Database(':memory:');
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
      imported_from TEXT,
      import_verified INTEGER DEFAULT 0,
      signed_by TEXT,
      signed_artifact TEXT,
      signature TEXT
    );

    CREATE TABLE myr_peers (
      id INTEGER PRIMARY KEY,
      peer_url TEXT UNIQUE NOT NULL,
      operator_name TEXT NOT NULL,
      public_key TEXT UNIQUE NOT NULL,
      trust_level TEXT DEFAULT 'pending',
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

    CREATE TABLE myr_traces (
      trace_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_fingerprint TEXT,
      target_fingerprint TEXT,
      artifact_signature TEXT,
      outcome TEXT NOT NULL,
      rejection_reason TEXT,
      metadata TEXT
    );
  `);
  return db;
}

function makeReport({ id, nodeId, domainTag }) {
  const ts = '2026-04-24T14:00:00Z';
  const wire = {
    id,
    timestamp: ts,
    agent_id: 'interop-test',
    node_id: nodeId,
    session_ref: null,
    cycle_intent: `Intent ${id}`,
    domain_tags: domainTag,
    yield_type: 'technique',
    question_answered: `Question ${id}`,
    evidence: `Evidence ${id}`,
    what_changes_next: 'Next step',
    confidence: 0.8,
    operator_rating: null,
    created_at: ts,
    updated_at: ts,
  };
  const canonical = canonicalize(wire);
  const signature = 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex');
  return { ...wire, signature };
}

function insertReport(db, report, { shareNetwork = 1 } = {}) {
  db.prepare(`
    INSERT INTO myr_reports (
      id, timestamp, agent_id, node_id, session_ref, cycle_intent,
      domain_tags, yield_type, question_answered, evidence, what_changes_next,
      confidence, operator_rating, created_at, updated_at, share_network,
      imported_from, signed_by, signed_artifact, signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    report.id,
    report.timestamp,
    report.agent_id,
    report.node_id,
    report.session_ref,
    report.cycle_intent,
    report.domain_tags,
    report.yield_type,
    report.question_answered,
    report.evidence,
    report.what_changes_next,
    report.confidence,
    report.operator_rating,
    report.created_at,
    report.updated_at,
    shareNetwork,
    null,
    null,
    report.signature,
    report.signature
  );
}

describe('Gossip mixed-mode interop', () => {
  let localDb;
  let localKeys;

  let gossipDb;
  let gossipServer;
  let gossipPort;
  let gossipPeerKeys;

  let legacyServer;
  let legacyPort;
  let legacyPeerKeys;
  let legacyReport;

  before(() => {
    localDb = createSyncDb();
    localKeys = generateKeypair();

    // Gossip-capable peer (new protocol endpoints)
    gossipDb = createSyncDb();
    gossipPeerKeys = generateKeypair();

    const gossipReport = makeReport({ id: 'gossip-r1', nodeId: 'gossip-node', domainTag: 'gossip' });
    insertReport(gossipDb, gossipReport, { shareNetwork: 1 });
    gossipDb.prepare(
      "INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at) VALUES (?, ?, ?, 'trusted', ?, ?)"
    ).run('http://local-requester', 'requester', localKeys.publicKey, '2026-04-24T14:00:00Z', '2026-04-24T14:00:00Z');

    const gossipApp = createApp({
      config: {
        node_id: 'gossip-node',
        operator_name: 'gossip-peer',
        node_url: 'http://127.0.0.1',
        port: 0,
      },
      db: gossipDb,
      publicKeyHex: gossipPeerKeys.publicKey,
      privateKeyHex: gossipPeerKeys.privateKey,
      createdAt: '2026-04-24T14:00:00Z',
    });
    gossipServer = gossipApp.listen(0);
    gossipPort = gossipServer.address().port;

    // Legacy pull-only peer (no gossip capabilities in discovery)
    legacyPeerKeys = generateKeypair();
    legacyReport = makeReport({ id: 'legacy-r1', nodeId: 'legacy-node', domainTag: 'legacy' });
    legacyServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${legacyPort || 0}`);
      if (req.method === 'GET' && url.pathname === '/.well-known/myr-node') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          protocol_version: '1.2.0',
          node_url: `http://127.0.0.1:${legacyPort}`,
          operator_name: 'legacy-peer',
          public_key: legacyPeerKeys.publicKey,
          capabilities: ['report-sync', 'peer-discovery', 'incremental-sync'],
          created_at: '2026-04-24T14:00:00Z',
          rate_limits: { requests_per_minute: 60, min_sync_interval_minutes: 15 },
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/myr/reports') {
        const sig = legacyReport.signature;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          reports: [{
            signature: sig,
            operator_name: 'legacy-peer',
            created_at: legacyReport.created_at,
            method_name: legacyReport.cycle_intent,
            url: `/myr/reports/${encodeURIComponent(sig)}`,
          }],
          total: 1,
          sync_cursor: legacyReport.created_at,
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname === `/myr/reports/${encodeURIComponent(legacyReport.signature)}`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ...legacyReport, signature: legacyReport.signature }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    legacyServer.listen(0);
    legacyPort = legacyServer.address().port;

    localDb.prepare(
      "INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at) VALUES (?, ?, ?, 'trusted', ?, ?)"
    ).run(`http://127.0.0.1:${gossipPort}`, 'gossip-peer', gossipPeerKeys.publicKey, '2026-04-24T14:00:00Z', '2026-04-24T14:00:00Z');

    localDb.prepare(
      "INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at) VALUES (?, ?, ?, 'trusted', ?, ?)"
    ).run(`http://127.0.0.1:${legacyPort}`, 'legacy-peer', legacyPeerKeys.publicKey, '2026-04-24T14:00:00Z', '2026-04-24T14:00:00Z');
  });

  after(() => {
    gossipServer.close();
    legacyServer.close();
    gossipDb.close();
    localDb.close();
  });

  it('uses gossip bloom anti-entropy for gossip-capable peers and falls back to pull for legacy peers', async () => {
    const gossipPeer = localDb.prepare('SELECT * FROM myr_peers WHERE operator_name = ?').get('gossip-peer');
    const legacyPeer = localDb.prepare('SELECT * FROM myr_peers WHERE operator_name = ?').get('legacy-peer');

    const gossipCalls = { bloom: 0, list: 0 };
    const gossipFetch = async (url, options) => {
      if (url.includes('/myr/sync/bloom')) gossipCalls.bloom++;
      if (url.includes('/myr/reports?')) gossipCalls.list++;
      return httpFetch(url, options);
    };

    const gossipResult = await syncPeer({
      db: localDb,
      peer: gossipPeer,
      keys: localKeys,
      fetch: gossipFetch,
    });

    assert.equal(gossipResult.imported, 1);
    assert.ok(gossipCalls.bloom > 0, 'gossip-capable peer should use bloom anti-entropy');
    assert.equal(gossipCalls.list, 0, 'gossip-capable peer should not rely on /myr/reports list path');

    const legacyCalls = { bloom: 0, list: 0 };
    const legacyFetch = async (url, options) => {
      if (url.includes('/myr/sync/bloom')) legacyCalls.bloom++;
      if (url.includes('/myr/reports?')) legacyCalls.list++;
      return httpFetch(url, options);
    };

    const legacyResult = await syncPeer({
      db: localDb,
      peer: legacyPeer,
      keys: localKeys,
      fetch: legacyFetch,
    });

    assert.equal(legacyResult.imported, 1);
    assert.equal(legacyCalls.bloom, 0, 'legacy peer should not receive bloom requests');
    assert.ok(legacyCalls.list > 0, 'legacy peer should use /myr/reports pull path');
  });
});
