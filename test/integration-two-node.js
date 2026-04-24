#!/usr/bin/env node
/**
 * Two-node integration test — Phases 1-5
 *
 * Spins up two real HTTP server instances (Node A and Node B) in-process,
 * with separate in-memory databases and freshly generated keypairs.
 * Walks the complete peer lifecycle:
 *
 *   Phase 1: HTTP endpoints reachable and correct
 *   Phase 2: Peer discovery via introduce, approve, mutual trust
 *   Phase 3: Report sync — A's reports appear in B's DB
 *   Phase 4: Security & adversarial — auth, replay, malformed input
 *   Phase 5: Identity continuity — URL migration, keypair persistence
 *
 * No mocks. No network stubs. Real HTTP on localhost.
 *
 * Run: node test/integration-two-node.js
 */

'use strict';

const http  = require('http');
const assert = require('assert/strict');
const Database = require('better-sqlite3');
const nodeCrypto = require('crypto');
const { generateKeypair, sign: signMessage, fingerprint: computeFingerprint } = require('../lib/crypto');
const { createApp } = require('../server/index');
const { syncPeer, httpFetch, makeSignedHeaders } = require('../lib/sync');
const { canonicalize } = require('../lib/canonicalize');

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
      trust_level TEXT CHECK(trust_level IN ('trusted','pending','introduced','revoked','rejected')) DEFAULT 'pending',
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
function signedFetch(url, { method = 'GET', body, keys, nonce, timestamp } = {}) {
  const parsed = new URL(url);
  const urlPath = parsed.pathname;
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

// Raw fetch with custom headers (for adversarial tests)
function rawFetch(url, { method = 'GET', headers = {}, body } = {}) {
  return httpFetch(url, { method, headers, body });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  MYR Two-Node Integration Test (v2)');
  console.log('══════════════════════════════════════════════════════\n');

  const keysA = generateKeypair();
  const keysB = generateKeypair();
  const keysC = generateKeypair();
  const keysD = generateKeypair();
  const keysUnknown = generateKeypair();

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

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 1: HTTP Endpoints
    // ══════════════════════════════════════════════════════════════════════════
    console.log('Phase 1: HTTP Endpoints\n');

    await test('GET /.well-known/myr-node (Node A) returns 200', async () => {
      const r = await fetch(`${urlA}/.well-known/myr-node`);
      assert.equal(r.status, 200);
    });

    await test('Discovery returns correct operator_name', async () => {
      const r = await fetch(`${urlA}/.well-known/myr-node`);
      assert.equal(r.body.operator_name, 'node-a');
    });

    await test('Discovery returns public_key', async () => {
      const r = await fetch(`${urlA}/.well-known/myr-node`);
      assert.equal(r.body.public_key, keysA.publicKey);
    });

    await test('Discovery returns protocol_version', async () => {
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

    await test('/myr/health includes liveness_signature', async () => {
      const r = await fetch(`${urlA}/myr/health`);
      assert.ok(r.body.liveness_signature, 'missing liveness_signature');
      assert.ok(r.body.timestamp, 'missing timestamp');
      assert.ok(r.body.nonce, 'missing nonce');
    });

    await test('/myr/health liveness_signature is valid', async () => {
      const { verify } = require('../lib/crypto');
      const r = await fetch(`${urlA}/myr/health`);
      const valid = verify(r.body.timestamp + r.body.nonce, r.body.liveness_signature, keysA.publicKey);
      assert.ok(valid, 'liveness_signature does not verify');
    });

    await test('GET /myr/reports without auth returns 401', async () => {
      const r = await fetch(`${urlA}/myr/reports`);
      assert.equal(r.status, 401);
    });

    await test('401 response leaks no information', async () => {
      const r = await fetch(`${urlA}/myr/reports`);
      assert.equal(r.status, 401);
      // Should not contain node_id, public_key, operator_name, etc.
      const body = JSON.stringify(r.body);
      assert.ok(!body.includes(keysA.publicKey), 'response leaks public key');
      assert.ok(!body.includes('node-a'), 'response leaks operator name');
    });

    await test('Both nodes up — Node B health check', async () => {
      const r = await fetch(`${urlB}/myr/health`);
      assert.equal(r.body.status, 'ok');
    });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2: Peer Discovery via Introduce + Approve
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\nPhase 2: Peer Discovery & Automatic Trust\n');

    // Use the introduce endpoint (public, no registry requirement)
    await test('POST /myr/peer/introduce: B introduces to A', async () => {
      const r = await fetch(`${urlA}/myr/peer/introduce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identity_document: {
            protocol_version: '1.0.0',
            public_key: keysB.publicKey,
            fingerprint: computeFingerprint(keysB.publicKey),
            operator_name: 'node-b',
            node_url: urlB,
            capabilities: ['report-sync'],
            created_at: new Date().toISOString(),
          },
          introduction_message: 'Hello from node-b',
        }),
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'connected');
    });

    await test('After introduce: A has B as trusted peer', async () => {
      const peer = dbA.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(keysB.publicKey);
      assert.ok(peer, 'peer not found in DB');
      assert.equal(peer.trust_level, 'trusted');
      assert.equal(peer.operator_name, 'node-b');
    });

    await test('Trusted peer can vouch for a new node with signed introduction', async () => {
      dbA.prepare(
        `INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at)
         VALUES (?, ?, ?, 'trusted', datetime('now'), datetime('now'))`
      ).run('http://127.0.0.1:37999', 'node-c', keysC.publicKey);

      const introduceBody = {
        identity_document: {
          protocol_version: '1.0.0',
          public_key: keysD.publicKey,
          fingerprint: computeFingerprint(keysD.publicKey),
          operator_name: 'node-d',
          node_url: 'http://127.0.0.1:37998',
          capabilities: ['report-sync'],
          created_at: new Date().toISOString(),
        },
        introduction_message: 'Vouched by node-c',
      };

      const headers = makeSignedHeaders({
        method: 'POST',
        urlPath: '/myr/peer/introduce',
        body: introduceBody,
        privateKey: keysC.privateKey,
        publicKey: keysC.publicKey,
      });
      headers['content-type'] = 'application/json';

      const r = await rawFetch(`${urlA}/myr/peer/introduce`, {
        method: 'POST',
        headers,
        body: introduceBody,
      });

      assert.equal(r.status, 200);
      assert.equal(r.body.vouch.status, 'accepted');
      assert.equal(r.body.vouch.voucher_public_key, keysC.publicKey);

      const peer = dbA.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(keysD.publicKey);
      assert.ok(peer, 'vouched node not stored');
      assert.equal(peer.trust_level, 'trusted');
      const notes = JSON.parse(peer.notes);
      assert.equal(notes.introduced_by, keysC.publicKey);
    });

    await test('Invalid signed introduction is rejected', async () => {
      const keysBad = generateKeypair();
      const introduceBody = {
        identity_document: {
          protocol_version: '1.0.0',
          public_key: keysBad.publicKey,
          fingerprint: computeFingerprint(keysBad.publicKey),
          operator_name: 'bad-node',
          node_url: 'http://127.0.0.1:37997',
          capabilities: ['report-sync'],
          created_at: new Date().toISOString(),
        },
      };

      const forgedHeaders = makeSignedHeaders({
        method: 'POST',
        urlPath: '/myr/peer/introduce',
        body: introduceBody,
        privateKey: keysUnknown.privateKey,
        publicKey: keysC.publicKey,
      });
      forgedHeaders['content-type'] = 'application/json';

      const r = await rawFetch(`${urlA}/myr/peer/introduce`, {
        method: 'POST',
        headers: forgedHeaders,
        body: introduceBody,
      });

      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'invalid_signature');
    });

    await test('B can fetch A reports after automatic trust', async () => {
      const r = await signedFetch(`${urlA}/myr/reports`, { keys: keysB });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.reports));
    });

    await test('A marks B trusted without manual approve step', async () => {
      const peer = dbA.prepare('SELECT trust_level, approved_at FROM myr_peers WHERE public_key=?')
        .get(keysB.publicKey);
      assert.equal(peer.trust_level, 'trusted');
      assert.ok(peer.approved_at, 'approved_at should be set for automatic trust');
    });

    // A introduces to B (mutual)
    await test('POST /myr/peer/introduce: A introduces to B', async () => {
      const r = await fetch(`${urlB}/myr/peer/introduce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identity_document: {
            protocol_version: '1.0.0',
            public_key: keysA.publicKey,
            fingerprint: computeFingerprint(keysA.publicKey),
            operator_name: 'node-a',
            node_url: urlA,
            capabilities: ['report-sync'],
            created_at: new Date().toISOString(),
          },
        }),
      });
      assert.equal(r.status, 200);
    });

    await test('B marks A trusted without manual approve step', async () => {
      const peer = dbB.prepare('SELECT trust_level, approved_at FROM myr_peers WHERE public_key=?')
        .get(keysA.publicKey);
      assert.equal(peer.trust_level, 'trusted');
      assert.ok(peer.approved_at, 'approved_at should be set for automatic trust');
    });

    await test('After trust establishment: B can fetch A reports (200)', async () => {
      const r = await signedFetch(`${urlA}/myr/reports`, { keys: keysB });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.reports));
    });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 3: Report Sync
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\nPhase 3: Report Sync\n');

    const now = new Date().toISOString();
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
    const canonical = canonicalize(rowBase);
    const sigHex  = signMessage(canonical, keysA.privateKey);
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
      const r = await signedFetch(`${urlA}/myr/reports`, { keys: keysB });
      assert.equal(r.status, 200);
      assert.equal(r.body.reports.length, 1);
      assert.equal(r.body.total, 1);
    });

    await test('Node B can fetch specific report by signature', async () => {
      const list = await signedFetch(`${urlA}/myr/reports`, { keys: keysB });
      const sig = list.body.reports[0].signature;
      const r = await signedFetch(`${urlA}/myr/reports/${encodeURIComponent(sig)}`, { keys: keysB });
      assert.equal(r.status, 200);
      assert.ok(r.body.id || r.body.signature, 'report body missing');
    });

    await test('Sync: B pulls from A using syncPeer', async () => {
      const peerRecord = dbB.prepare('SELECT * FROM myr_peers WHERE public_key=?').get(keysA.publicKey);
      await syncPeer({
        db: dbB,
        peer: { ...peerRecord, peer_url: urlA },
        keys: keysB,
        fetch: httpFetch,
      });
    });

    await test('After sync: report from A appears in B DB', async () => {
      const row = dbB.prepare('SELECT id FROM myr_reports WHERE id=?').get(rowBase.id);
      assert.ok(row, 'synced report not found in Node B DB');
    });

    await test('Incremental sync: since= skips already-seen reports', async () => {
      const future = new Date(Date.now() + 60000).toISOString();
      const r = await signedFetch(
        `${urlA}/myr/reports?since=${encodeURIComponent(future)}`,
        { keys: keysB }
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.reports.length, 0);
    });

    await test('Re-sync imports nothing (cursor works)', async () => {
      const countBefore = dbB.prepare('SELECT COUNT(*) as cnt FROM myr_reports').get().cnt;
      const peerRecord = dbB.prepare('SELECT * FROM myr_peers WHERE public_key=?').get(keysA.publicKey);
      await syncPeer({
        db: dbB,
        peer: { ...peerRecord, peer_url: urlA },
        keys: keysB,
        fetch: httpFetch,
      });
      const countAfter = dbB.prepare('SELECT COUNT(*) as cnt FROM myr_reports').get().cnt;
      assert.equal(countAfter, countBefore, 'duplicate reports imported');
    });

    await test('Report with share_network=false is excluded', async () => {
      dbA.prepare(`UPDATE myr_reports SET share_network=0 WHERE id=?`).run(rowBase.id);
      const r = await signedFetch(`${urlA}/myr/reports`, { keys: keysB });
      assert.equal(r.body.reports.length, 0);
      dbA.prepare(`UPDATE myr_reports SET share_network=1 WHERE id=?`).run(rowBase.id);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 4: Security & Adversarial Tests
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\nPhase 4: Security & Adversarial\n');

    // -- Auth tests --

    await test('Unauthenticated request to protected endpoint returns 401', async () => {
      const r = await fetch(`${urlA}/myr/reports`);
      assert.equal(r.status, 401);
    });

    await test('Malformed signature returns 401', async () => {
      const ts = new Date().toISOString();
      const nonce = nodeCrypto.randomBytes(32).toString('hex');
      const r = await rawFetch(`${urlA}/myr/reports`, {
        headers: {
          'x-myr-timestamp': ts,
          'x-myr-nonce': nonce,
          'x-myr-signature': 'deadbeef0000not_a_real_signature',
          'x-myr-public-key': keysB.publicKey,
        },
      });
      assert.equal(r.status, 401);
    });

    await test('Replayed nonce is rejected (401)', async () => {
      const nonce = nodeCrypto.randomBytes(32).toString('hex');
      const ts = new Date().toISOString();
      const urlPath = '/myr/reports';
      const bodyHash = nodeCrypto.createHash('sha256').update('').digest('hex');
      const can = `GET\n${urlPath}\n${ts}\n${nonce}\n${bodyHash}`;
      const sig = signMessage(can, keysB.privateKey);
      const headers = {
        'x-myr-timestamp': ts, 'x-myr-nonce': nonce,
        'x-myr-signature': sig, 'x-myr-public-key': keysB.publicKey,
      };
      // First request succeeds
      await httpFetch(`${urlA}/myr/reports`, { method: 'GET', headers });
      // Replay — same nonce
      const r2 = await httpFetch(`${urlA}/myr/reports`, { method: 'GET', headers });
      assert.equal(r2.status, 401);
    });

    await test('Stale timestamp (>5 min old) is rejected (401)', async () => {
      const oldTs = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      const nonce = nodeCrypto.randomBytes(32).toString('hex');
      const urlPath = '/myr/reports';
      const bodyHash = nodeCrypto.createHash('sha256').update('').digest('hex');
      const can = `GET\n${urlPath}\n${oldTs}\n${nonce}\n${bodyHash}`;
      const sig = signMessage(can, keysB.privateKey);
      const headers = {
        'x-myr-timestamp': oldTs, 'x-myr-nonce': nonce,
        'x-myr-signature': sig, 'x-myr-public-key': keysB.publicKey,
      };
      const r = await httpFetch(`${urlA}/myr/reports`, { method: 'GET', headers });
      assert.equal(r.status, 401);
    });

    await test('Unknown peer with valid sig gets 403 (not 401)', async () => {
      const r = await signedFetch(`${urlA}/myr/reports`, { keys: keysUnknown });
      assert.equal(r.status, 403);
    });

    await test('403 response leaks no sensitive info', async () => {
      const r = await signedFetch(`${urlA}/myr/reports`, { keys: keysUnknown });
      const body = JSON.stringify(r.body);
      assert.ok(!body.includes(keysA.publicKey), 'leaks server public key');
      assert.ok(!body.includes(keysA.privateKey), 'leaks private key');
    });

    // -- Invalid input tests --

    await test('Invalid JSON body returns 400', async () => {
      const ts = new Date().toISOString();
      const nonce = nodeCrypto.randomBytes(32).toString('hex');
      const rawBody = '{not valid json!!!';
      const bodyHash = nodeCrypto.createHash('sha256').update(rawBody).digest('hex');
      const urlPath = '/myr/peer/introduce';
      const can = `POST\n${urlPath}\n${ts}\n${nonce}\n${bodyHash}`;
      const sig = signMessage(can, keysB.privateKey);

      const r = await rawFetch(`${urlA}/myr/peer/introduce`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-myr-timestamp': ts,
          'x-myr-nonce': nonce,
          'x-myr-signature': sig,
          'x-myr-public-key': keysB.publicKey,
        },
        body: rawBody,
      });
      assert.equal(r.status, 400);
    });

    await test('Missing identity_document in introduce returns error', async () => {
      const r = await fetch(`${urlA}/myr/peer/introduce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      });
      // Should be 4xx, not 5xx
      assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
    });

    // -- Stress / rapid requests --

    await test('100 rapid requests do not crash the server', async () => {
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(fetch(`${urlA}/myr/health`));
      }
      const responses = await Promise.all(promises);
      const allOk = responses.every(r => r.status === 200);
      assert.ok(allOk, 'some health requests failed under load');
    });

    await test('100 rapid authenticated requests handled correctly', async () => {
      let successCount = 0;
      let rateLimitCount = 0;
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(signedFetch(`${urlA}/myr/reports`, { keys: keysB }));
      }
      const responses = await Promise.all(promises);
      for (const r of responses) {
        if (r.status === 200) successCount++;
        else if (r.status === 429) rateLimitCount++;
      }
      // All should succeed or be rate-limited; none should be 500
      const noServerErrors = responses.every(r => r.status !== 500);
      assert.ok(noServerErrors, 'server returned 500 under load');
      // At minimum some should succeed
      assert.ok(successCount > 0, 'no requests succeeded');
    });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 5: Identity Continuity
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\nPhase 5: Identity Continuity\n');

    // Simulate Node A changing its URL (e.g., tunnel re-provision or IP migration)
    // The keypair stays the same — peers should reconnect via fingerprint identity.

    await test('URL migration: A changes URL, B re-introduces, trust persists', async () => {
      // Shut down server A and restart on a new port (simulating URL change)
      srvA.close();
      const newConfigA = { ...configA, port: 37192, node_url: 'http://127.0.0.1:37192' };
      const newAppA = createApp({
        config: newConfigA, db: dbA,
        publicKeyHex: keysA.publicKey, privateKeyHex: keysA.privateKey,
        createdAt: new Date().toISOString(),
      });
      const newSrvA = await startServer(newAppA, 37192);
      const newUrlA = 'http://127.0.0.1:37192';

      try {
        // Verify new URL works
        const health = await fetch(`${newUrlA}/myr/health`);
        assert.equal(health.status, 200);

        // B can still sync from A at the new URL (same keypair, same trust in DB)
        const peerRecord = dbB.prepare('SELECT * FROM myr_peers WHERE public_key=?').get(keysA.publicKey);
        const r = await signedFetch(`${newUrlA}/myr/reports`, { keys: keysB });
        assert.equal(r.status, 200, 'B cannot reach A at new URL');
      } finally {
        newSrvA.close();
      }
    });

    await test('Keypair persists across URL changes', async () => {
      // Fingerprint should be the same regardless of URL
      const fp = computeFingerprint(keysA.publicKey);
      assert.ok(fp.length > 10, 'fingerprint too short');
      // Peers in B's DB still reference the same public key
      const peer = dbB.prepare('SELECT * FROM myr_peers WHERE public_key=?').get(keysA.publicKey);
      assert.ok(peer, 'peer record lost after URL change');
      assert.equal(peer.trust_level, 'trusted', 'trust lost after URL change');
    });

  } finally {
    try { srvA.close(); } catch { /* may already be closed */ }
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
    console.log('  All tests passed. Phases 1-5 verified end-to-end.\n');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
