#!/usr/bin/env node
/**
 * Two-node integration test — Phases 1-3
 *
 * Spins up two real HTTP server instances (Node A and Node B) in-process,
 * with separate in-memory databases and freshly generated keypairs.
 * Walks the complete peer lifecycle:
 *
 *   Phase 1: HTTP endpoints reachable and correct
 *   Phase 2: Peer discovery, announce, approve (CLI logic)
 *   Phase 3: Report sync — A's reports appear in B's DB
 *
 * No mocks. No network stubs. Real HTTP on localhost.
 *
 * Run: node test/integration-two-node.js
 */

'use strict';

const http  = require('http');
const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { generateKeypair } = require('../lib/crypto');
const { createApp }       = require('../server/index');
const { syncPeer, httpFetch } = require('../lib/sync');

// ── Utilities ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
    results.push({ name, ok: true });
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    failed++;
    results.push({ name, ok: false, error: err.message });
  }
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS myr_reports (
      id TEXT PRIMARY KEY,
      node_id TEXT,
      timestamp TEXT,
      agent_id TEXT,
      session_ref TEXT,
      cycle_intent TEXT,
      domain_tags TEXT,
      yield_type TEXT,
      yield_question TEXT,
      question_answered TEXT,
      yield_evidence TEXT,
      evidence TEXT,
      yield_changes TEXT,
      what_changes_next TEXT,
      yield_falsified TEXT,
      yield_transferable TEXT,
      yield_confidence REAL,
      confidence REAL,
      operator_rating INTEGER,
      operator_notes TEXT,
      verified_at TEXT,
      updated_at TEXT,
      share_network INTEGER DEFAULT 1,
      source_peer TEXT,
      imported_from TEXT,
      import_verified INTEGER DEFAULT 0,
      raw_json TEXT,
      signature TEXT UNIQUE,
      signed_artifact TEXT,
      operator_signature TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS myr_peers (
      id INTEGER PRIMARY KEY,
      peer_url TEXT UNIQUE NOT NULL,
      operator_name TEXT NOT NULL,
      public_key TEXT UNIQUE NOT NULL,
      trust_level TEXT CHECK(trust_level IN ('trusted','pending','rejected')) DEFAULT 'pending',
      added_at TEXT NOT NULL,
      approved_at TEXT,
      last_sync_at TEXT,
      auto_sync INTEGER DEFAULT 1,
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS myr_nonces (
      nonce TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nonces_expires ON myr_nonces(expires_at);
  `);
  return db;
}

function startServer(app, port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
    srv.on('error', reject);
  });
}

async function fetch(url, opts = {}) {
  return httpFetch(url, opts);
}

// Signed fetch using node's keys
// NOTE: auth middleware signs req.path (pathname only, no query string)
async function signedFetch(url, { method = 'GET', body, keys, nonce, timestamp } = {}) {
  const { makeSignedHeaders } = require('../lib/sync');
  const parsed = new URL(url);
  const urlPath = parsed.pathname; // path only — matches req.path in auth middleware
  const bodyStr = body ? JSON.stringify(body) : undefined;
  const headers = makeSignedHeaders({
    method,
    urlPath,
    body: bodyStr,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    ...(nonce ? { nonce } : {}),
    ...(timestamp ? { timestamp } : {}),
  });
  return httpFetch(url, { method, headers, body: bodyStr });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  MYR Two-Node Integration Test');
  console.log('══════════════════════════════════════════════════════\n');

  // Generate fresh keypairs for both nodes
  const keysA = generateKeypair();
  const keysB = generateKeypair();

  const dbA = makeDb();
  const dbB = makeDb();

  const configA = {
    node_id: 'test-node-a',
    node_url: 'http://127.0.0.1:37190',
    operator_name: 'node-a',
    port: 37190,
  };
  const configB = {
    node_id: 'test-node-b',
    node_url: 'http://127.0.0.1:37191',
    operator_name: 'node-b',
    port: 37191,
  };

  const appA = createApp({ config: configA, db: dbA, publicKeyHex: keysA.publicKey, privateKeyHex: keysA.privateKey, createdAt: new Date().toISOString() });
  const appB = createApp({ config: configB, db: dbB, publicKeyHex: keysB.publicKey, privateKeyHex: keysB.privateKey, createdAt: new Date().toISOString() });

  const srvA = await startServer(appA, 37190);
  const srvB = await startServer(appB, 37191);

  const urlA = 'http://127.0.0.1:37190';
  const urlB = 'http://127.0.0.1:37191';

  try {

    // ── PHASE 1: HTTP Endpoints ───────────────────────────────────────────────
    console.log('Phase 1: HTTP Endpoints\n');

    await test('GET /.well-known/myr-node (Node A) returns 200', async () => {
      const r = await fetch(`${urlA}/.well-known/myr-node`);
      assert.equal(r.status, 200);
    });

    await test('/.well-known/myr-node returns correct operator_name', async () => {
      const r = await fetch(`${urlA}/.well-known/myr-node`);
      assert.equal(r.body.operator_name, 'node-a');
    });

    await test('/.well-known/myr-node returns public_key', async () => {
      const r = await fetch(`${urlA}/.well-known/myr-node`);
      assert.equal(r.body.public_key, keysA.publicKey);
    });

    await test('/.well-known/myr-node returns protocol_version', async () => {
      const r = await fetch(`${urlA}/.well-known/myr-node`);
      assert.ok(r.body.protocol_version, 'missing protocol_version');
    });

    await test('GET /myr/health (Node A) returns status ok', async () => {
      const r = await fetch(`${urlA}/myr/health`);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'ok');
    });

    await test('/myr/health returns reports_total and peers_total', async () => {
      const r = await fetch(`${urlA}/myr/health`);
      assert.ok(typeof r.body.reports_total === 'number');
      assert.ok(typeof r.body.peers_total === 'number');
    });

    await test('GET /myr/reports without auth returns 401', async () => {
      const r = await fetch(`${urlA}/myr/reports`);
      assert.equal(r.status, 401);
    });

    await test('GET /myr/reports with valid auth but unknown peer returns 403', async () => {
      const r = await signedFetch(`${urlA}/myr/reports`, { keys: keysB, nodeUrl: urlB });
      assert.equal(r.status, 403);
    });

    await test('Both nodes up — Node B health check', async () => {
      const r = await fetch(`${urlB}/myr/health`);
      assert.equal(r.body.status, 'ok');
    });

    // ── PHASE 2: Peer Discovery & Approve ────────────────────────────────────
    console.log('\nPhase 2: Peer Discovery & Mutual Approval\n');

    await test('POST /myr/peers/announce: B announces to A → pending_approval', async () => {
      const r = await signedFetch(`${urlA}/myr/peers/announce`, {
        method: 'POST',
        body: {
          peer_url: urlB,
          public_key: keysB.publicKey,
          operator_name: 'node-b',
          timestamp: new Date().toISOString(),
          nonce: require('crypto').randomBytes(16).toString('hex'),
        },
        keys: keysB,
        nodeUrl: urlB,
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'pending_approval');
    });

    await test('After announce: A has B in peers table with trust_level=pending', async () => {
      const peer = dbA.prepare('SELECT * FROM myr_peers WHERE operator_name = ?').get('node-b');
      assert.ok(peer, 'peer not found in DB');
      assert.equal(peer.trust_level, 'pending');
    });

    await test('B still cannot fetch A reports (not yet trusted)', async () => {
      const r = await signedFetch(`${urlA}/myr/reports`, { keys: keysB, nodeUrl: urlB });
      assert.equal(r.status, 403);
    });

    await test('A approves B → trust_level becomes trusted', async () => {
      dbA.prepare(
        `UPDATE myr_peers SET trust_level='trusted', approved_at=datetime('now')
         WHERE operator_name='node-b'`
      ).run();
      const peer = dbA.prepare('SELECT trust_level FROM myr_peers WHERE operator_name=?').get('node-b');
      assert.equal(peer.trust_level, 'trusted');
    });

    // Also add A as a peer in B's DB (mutual — B needs to know about A for sync to work both ways)
    await test('A announces to B → pending_approval', async () => {
      const r = await signedFetch(`${urlB}/myr/peers/announce`, {
        method: 'POST',
        body: {
          peer_url: urlA,
          public_key: keysA.publicKey,
          operator_name: 'node-a',
          timestamp: new Date().toISOString(),
          nonce: require('crypto').randomBytes(16).toString('hex'),
        },
        keys: keysA,
        nodeUrl: urlA,
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'pending_approval');
    });

    await test('B approves A → trust_level trusted', async () => {
      dbB.prepare(
        `UPDATE myr_peers SET trust_level='trusted', approved_at=datetime('now')
         WHERE operator_name='node-a'`
      ).run();
      const peer = dbB.prepare('SELECT trust_level FROM myr_peers WHERE operator_name=?').get('node-a');
      assert.equal(peer.trust_level, 'trusted');
    });

    await test('After mutual approval: B can fetch A reports list (200)', async () => {
      const r = await signedFetch(`${urlA}/myr/reports`, { keys: keysB, nodeUrl: urlB });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.reports));
    });

    await test('Duplicate announce returns 409 conflict', async () => {
      const r = await signedFetch(`${urlA}/myr/peers/announce`, {
        method: 'POST',
        body: {
          peer_url: urlB,
          public_key: keysB.publicKey,
          operator_name: 'node-b',
          timestamp: new Date().toISOString(),
          nonce: require('crypto').randomBytes(16).toString('hex'),
        },
        keys: keysB,
        nodeUrl: urlB,
      });
      assert.equal(r.status, 409);
    });

    // ── PHASE 3: Report Sync ──────────────────────────────────────────────────
    console.log('\nPhase 3: Report Sync\n');

    // Insert a signed report into Node A's DB
    // IMPORTANT: signature is computed over the canonicalized DB row (flat structure),
    // not over the nested JSON, because that's what the server returns and syncPeer verifies.
    const { sign: signReport } = require('../lib/crypto');
    const { canonicalize } = require('../lib/canonicalize');
    const nodeCrypto = require('crypto');

    const now = new Date().toISOString();
    // rowBase must include EVERY column in the DB table (with nulls for unused ones)
    // so that canonicalize(rowBase) === canonicalize(server_row_minus_sig_fields)
    const rowBase = {
      id: 'test-node-a-20260303-001',
      node_id: 'test-node-a',
      timestamp: now,
      agent_id: 'polemarch',
      session_ref: null,
      cycle_intent: 'Test two-node sync',
      domain_tags: null,
      yield_type: 'technique',
      yield_question: 'Does two-node sync work?',
      question_answered: null,
      yield_evidence: 'Integration test passed',
      evidence: null,
      yield_changes: 'Use automated sync in production',
      what_changes_next: null,
      yield_falsified: null,
      yield_transferable: null,
      yield_confidence: 0.9,
      confidence: null,
      operator_rating: null,
      operator_notes: null,
      verified_at: null,
      updated_at: null,
      share_network: 1,
      source_peer: null,
      imported_from: null,
      import_verified: 0,
      raw_json: null,
      signed_artifact: null,
      created_at: now,
    };
    // Compute signature over the canonical flat row (excluding signature fields)
    const canonical = canonicalize(rowBase);
    const sigHex  = signReport(canonical, keysA.privateKey);
    const sigHash = 'sha256:' + nodeCrypto.createHash('sha256').update(canonical).digest('hex');

    await test('Seed a signed report into Node A', async () => {
      dbA.prepare(`
        INSERT INTO myr_reports
          (id, node_id, timestamp, agent_id, cycle_intent, yield_type,
           yield_question, yield_evidence, yield_changes, yield_falsified,
           yield_transferable, yield_confidence, operator_rating, operator_notes,
           verified_at, share_network, source_peer, raw_json,
           signature, operator_signature, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        rowBase.id, rowBase.node_id, rowBase.timestamp, rowBase.agent_id,
        rowBase.cycle_intent, rowBase.yield_type,
        rowBase.yield_question, rowBase.yield_evidence, rowBase.yield_changes,
        rowBase.yield_falsified, rowBase.yield_transferable, rowBase.yield_confidence,
        rowBase.operator_rating, rowBase.operator_notes, rowBase.verified_at,
        rowBase.share_network, rowBase.source_peer, rowBase.raw_json,
        sigHash, sigHex, rowBase.created_at
      );
      const row = dbA.prepare('SELECT id FROM myr_reports WHERE id=?').get(rowBase.id);
      assert.ok(row, 'report not in DB');
    });

    await test('Node A reports list shows 1 report', async () => {
      const r = await signedFetch(`${urlA}/myr/reports`, { keys: keysB, nodeUrl: urlB });
      assert.equal(r.status, 200);
      assert.equal(r.body.reports.length, 1);
      assert.equal(r.body.total, 1);
    });

    await test('Node B can fetch the specific report by signature', async () => {
      const list = await signedFetch(`${urlA}/myr/reports`, { keys: keysB, nodeUrl: urlB });
      const sig = list.body.reports[0].signature;
      const r = await signedFetch(`${urlA}/myr/reports/${encodeURIComponent(sig)}`, {
        keys: keysB, nodeUrl: urlB
      });
      assert.equal(r.status, 200);
      assert.ok(r.body.id || r.body.signature, 'report body missing');
    });

    await test('Sync: B pulls from A using syncPeer', async () => {
      // Add A as known peer in B's peer record (need public_key stored)
      dbB.prepare(`UPDATE myr_peers SET public_key=? WHERE operator_name='node-a'`).run(keysA.publicKey);

      const peerRecord = dbB.prepare('SELECT * FROM myr_peers WHERE operator_name=?').get('node-a');
      await syncPeer({
        db: dbB,
        peer: { ...peerRecord, peer_url: urlA },
        keys: keysB,
        fetch: httpFetch,
      });
    });

    await test('After sync: report from A appears in B\'s DB', async () => {
      const row = dbB.prepare('SELECT id FROM myr_reports WHERE id=?').get(rowBase.id);
      assert.ok(row, 'synced report not found in Node B DB');
    });

    await test('Incremental sync: since= skips already-seen reports', async () => {
      const future = new Date(Date.now() + 60000).toISOString();
      const r = await signedFetch(
        `${urlA}/myr/reports?since=${encodeURIComponent(future)}`,
        { keys: keysB, nodeUrl: urlB }
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.reports.length, 0);
    });

    await test('Report with share_network=false is excluded from list', async () => {
      dbA.prepare(`UPDATE myr_reports SET share_network=0 WHERE id=?`).run(rowBase.id);
      const r = await signedFetch(`${urlA}/myr/reports`, { keys: keysB, nodeUrl: urlB });
      assert.equal(r.body.reports.length, 0);
      // Restore
      dbA.prepare(`UPDATE myr_reports SET share_network=1 WHERE id=?`).run(rowBase.id);
    });

    // ── Security spot-checks ──────────────────────────────────────────────────
    console.log('\nSecurity Spot-Checks\n');

    await test('Replayed nonce is rejected (401)', async () => {
      const { sign: signMsg } = require('../lib/crypto');
      const nonce = require('crypto').randomBytes(32).toString('hex');
      const ts = new Date().toISOString();
      const urlPath = '/myr/reports';
      const bodyHash = require('crypto').createHash('sha256').update('').digest('hex');
      const canonical = `GET\n${urlPath}\n${ts}\n${nonce}\n${bodyHash}`;
      const sig = signMsg(canonical, keysB.privateKey);
      const headers = {
        'x-myr-timestamp': ts, 'x-myr-nonce': nonce,
        'x-myr-signature': sig, 'x-myr-public-key': keysB.publicKey,
      };
      // First request — should succeed (trusted peer, 200)
      await httpFetch(`${urlA}/myr/reports`, { method: 'GET', headers });
      // Replay — same nonce, same timestamp
      const r2 = await httpFetch(`${urlA}/myr/reports`, { method: 'GET', headers });
      assert.equal(r2.status, 401);
    });

    await test('Stale timestamp (>5 min old) is rejected (401)', async () => {
      const { sign: signMsg } = require('../lib/crypto');
      const oldTs = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      const nonce = require('crypto').randomBytes(32).toString('hex');
      const urlPath = '/myr/reports';
      const bodyHash = require('crypto').createHash('sha256').update('').digest('hex');
      const canonical = `GET\n${urlPath}\n${oldTs}\n${nonce}\n${bodyHash}`;
      const sig = signMsg(canonical, keysB.privateKey);
      const headers = {
        'x-myr-timestamp': oldTs, 'x-myr-nonce': nonce,
        'x-myr-signature': sig, 'x-myr-public-key': keysB.publicKey,
      };
      const r = await httpFetch(`${urlA}/myr/reports`, { method: 'GET', headers });
      assert.equal(r.status, 401);
    });

  } finally {
    srvA.close();
    srvB.close();
  }

  // ── Results ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  ${passed + failed} tests — ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════════\n');

  if (failed > 0) {
    console.log('FAILURES:');
    results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.name}\n    ${r.error}`));
    process.exit(1);
  } else {
    console.log('  All tests passed. Phases 1-3 verified end-to-end.\n');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
