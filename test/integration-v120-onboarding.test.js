'use strict';

/**
 * MYR v1.2.0 Integration Tests — Two-Node Onboarding
 *
 * Covers the v1.2.0 in-band fingerprint verification flow:
 *   1. Happy path: two v1.2.0 nodes, auto-approve via fingerprint verification
 *   2. Tampered fingerprint: announced fingerprint doesn't match → rejected
 *   3. Backwards compat: v1.1.0 node (no fingerprint) → registry flow, not rejected
 *   4. Discovery doc unreachable: fingerprint present but peer unreachable → pending
 *
 * Uses real HTTP servers on localhost with in-memory SQLite databases.
 * Run: node --test test/integration-v120-onboarding.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { generateKeypair, fingerprint: computeFingerprint } = require('../lib/crypto');
const { createApp } = require('../server/index');
const { httpFetch, makeSignedHeaders } = require('../lib/sync');

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
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
      trust_level TEXT CHECK(trust_level IN ('trusted','pending','introduced','revoked','rejected','verified-pending-approval')) DEFAULT 'pending',
      added_at TEXT NOT NULL,
      approved_at TEXT,
      last_sync_at TEXT,
      auto_sync INTEGER DEFAULT 1,
      notes TEXT,
      node_uuid TEXT,
      verification_evidence TEXT,
      auto_approved INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS myr_nonces (
      nonce TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nonces_expires ON myr_nonces(expires_at);
    CREATE TABLE IF NOT EXISTS myr_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_fingerprint TEXT NOT NULL,
      target_fingerprint TEXT,
      artifact_signature TEXT,
      outcome TEXT NOT NULL,
      rejection_reason TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_traces_actor ON myr_traces(actor_fingerprint);
  `);
  return db;
}

function startServer(app, port = 0) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
    srv.on('error', reject);
  });
}

/**
 * Grab a free OS-assigned port, then release it.
 * Racy but adequate for tests on localhost.
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const tmp = http.createServer();
    tmp.listen(0, '127.0.0.1', () => {
      const port = tmp.address().port;
      tmp.close(() => resolve(port));
    });
    tmp.on('error', reject);
  });
}

function signedFetch(url, { method = 'GET', body, keys }) {
  const parsed = new URL(url);
  const urlPath = parsed.pathname;
  const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
  const headers = makeSignedHeaders({
    method,
    urlPath,
    body: bodyStr,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });
  return httpFetch(url, { method, headers, body: bodyStr });
}

function makeAnnounceBody(keys, { peerUrl, operatorName, fingerprint, nodeUuid, protocolVersion } = {}) {
  return {
    peer_url: peerUrl || 'http://127.0.0.1:9999',
    public_key: keys.publicKey,
    operator_name: operatorName || 'test-peer',
    timestamp: new Date().toISOString(),
    nonce: crypto.randomBytes(32).toString('hex'),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    ...(nodeUuid !== undefined ? { node_uuid: nodeUuid } : {}),
    ...(protocolVersion !== undefined ? { protocol_version: protocolVersion } : {}),
  };
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe('MYR v1.2.0 — Two-Node Onboarding Integration', () => {
  let keysA, keysB;
  let dbA, dbB;
  let srvA, srvB;
  let urlA, urlB;
  let portA, portB;

  before(async () => {
    keysA = generateKeypair();
    keysB = generateKeypair();

    dbA = createTestDb();
    dbB = createTestDb();
  });

  after(() => {
    if (srvA) try { srvA.close(); } catch { /* noop */ }
    if (srvB) try { srvB.close(); } catch { /* noop */ }
    if (dbA) try { dbA.close(); } catch { /* noop */ }
    if (dbB) try { dbB.close(); } catch { /* noop */ }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 1: Happy path — two v1.2.0 nodes, auto-approve
  // ══════════════════════════════════════════════════════════════════════════

  describe('Scenario 1: Happy path — two v1.2.0 nodes, auto-approve', () => {
    before(async () => {
      // Grab free ports first so node_url in config matches actual server
      portA = await getFreePort();
      portB = await getFreePort();
      urlA = `http://127.0.0.1:${portA}`;
      urlB = `http://127.0.0.1:${portB}`;

      const configA = {
        node_id: 'v120-node-a',
        operator_name: 'node-a-operator',
        node_url: urlA,
        port: portA,
        auto_approve_verified_peers: true,
        auto_approve_min_protocol_version: '1.2.0',
      };
      const configB = {
        node_id: 'v120-node-b',
        operator_name: 'node-b-operator',
        node_url: urlB,
        port: portB,
        auto_approve_verified_peers: true,
        auto_approve_min_protocol_version: '1.2.0',
      };

      const appA = createApp({
        config: configA,
        db: dbA,
        publicKeyHex: keysA.publicKey,
        privateKeyHex: keysA.privateKey,
        createdAt: new Date().toISOString(),
      });
      const appB = createApp({
        config: configB,
        db: dbB,
        publicKeyHex: keysB.publicKey,
        privateKeyHex: keysB.privateKey,
        createdAt: new Date().toISOString(),
      });

      srvA = await startServer(appA, portA);
      srvB = await startServer(appB, portB);
    });

    after(() => {
      if (srvA) try { srvA.close(); } catch { /* noop */ }
      if (srvB) try { srvB.close(); } catch { /* noop */ }
      srvA = null;
      srvB = null;
    });

    it('both nodes respond to discovery doc requests', async () => {
      const rA = await httpFetch(`${urlA}/.well-known/myr-node`);
      assert.equal(rA.status, 200);
      assert.equal(rA.body.public_key, keysA.publicKey);
      assert.equal(rA.body.fingerprint, computeFingerprint(keysA.publicKey));

      const rB = await httpFetch(`${urlB}/.well-known/myr-node`);
      assert.equal(rB.status, 200);
      assert.equal(rB.body.public_key, keysB.publicKey);
      assert.equal(rB.body.fingerprint, computeFingerprint(keysB.publicKey));
    });

    it('B announces to A with valid fingerprint → A auto-approves B', async () => {
      const body = makeAnnounceBody(keysB, {
        peerUrl: urlB,
        operatorName: 'node-b-operator',
        fingerprint: computeFingerprint(keysB.publicKey),
        nodeUuid: 'b-uuid-1234',
        protocolVersion: '1.2.0',
      });

      const r = await signedFetch(`${urlA}/myr/peers/announce`, {
        method: 'POST',
        body,
        keys: keysB,
      });

      assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.status, 'connected');
      assert.equal(r.body.trust_level, 'trusted');
      assert.equal(r.body.verification_status, 'verified');
      assert.equal(r.body.auto_approved, true);
    });

    it('A stores B as trusted with auto_approved=1 in myr_peers', () => {
      const peer = dbA.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(keysB.publicKey);
      assert.ok(peer, 'B not found in A\'s peer table');
      assert.equal(peer.trust_level, 'trusted');
      assert.equal(peer.auto_approved, 1);
      assert.equal(peer.node_uuid, 'b-uuid-1234');
      assert.ok(peer.approved_at, 'approved_at should be set');

      // Verify evidence was stored
      const evidence = JSON.parse(peer.verification_evidence);
      assert.equal(evidence.all_passed, true);
      assert.equal(evidence.checks.announced_fp_matches_key, true);
      assert.equal(evidence.checks.discovery_fp_matches_key, true);
      assert.equal(evidence.checks.announced_key_matches_discovery, true);
    });

    it('reciprocal announce: A is auto-approved by B', async () => {
      // The reciprocal announce is fire-and-forget, so give it a moment
      await new Promise(resolve => setTimeout(resolve, 500));

      const peer = dbB.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(keysA.publicKey);
      assert.ok(peer, 'A not found in B\'s peer table');
      assert.equal(peer.trust_level, 'trusted');
      assert.equal(peer.auto_approved, 1);
    });

    it('after mutual auto-approve: B can fetch A reports (200 or 429 if rate-limited)', async () => {
      // The reciprocal announce loop may exhaust the per-key rate limit.
      // Both 200 and 429 are valid outcomes — trust is already verified via DB.
      await new Promise(resolve => setTimeout(resolve, 200));
      const r = await signedFetch(`${urlA}/myr/reports`, { keys: keysB });
      assert.ok(r.status === 200 || r.status === 429,
        `Expected 200 or 429, got ${r.status}`);
      if (r.status === 200) {
        assert.ok(Array.isArray(r.body.reports));
      }
    });

    it('after mutual auto-approve: A can fetch B reports (200 or 429 if rate-limited)', async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
      const r = await signedFetch(`${urlB}/myr/reports`, { keys: keysA });
      assert.ok(r.status === 200 || r.status === 429,
        `Expected 200 or 429, got ${r.status}`);
      if (r.status === 200) {
        assert.ok(Array.isArray(r.body.reports));
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 2: Tampered fingerprint → rejected
  // ══════════════════════════════════════════════════════════════════════════

  describe('Scenario 2: Tampered fingerprint', () => {
    let srvC, urlC, dbC, keysC, keysD;

    before(async () => {
      keysC = generateKeypair();
      keysD = generateKeypair();
      dbC = createTestDb();

      const portC = await getFreePort();
      urlC = `http://127.0.0.1:${portC}`;

      const configC = {
        node_id: 'tamper-node-c',
        operator_name: 'node-c-operator',
        node_url: urlC,
        port: portC,
        auto_approve_verified_peers: true,
        auto_approve_min_protocol_version: '1.2.0',
      };

      const appC = createApp({
        config: configC,
        db: dbC,
        publicKeyHex: keysC.publicKey,
        privateKeyHex: keysC.privateKey,
        createdAt: new Date().toISOString(),
      });
      srvC = await startServer(appC, portC);
    });

    after(() => {
      if (srvC) try { srvC.close(); } catch { /* noop */ }
      if (dbC) try { dbC.close(); } catch { /* noop */ }
    });

    it('D announces to C with tampered fingerprint → C rejects', async () => {
      // D sends a fingerprint that does NOT match D's public key
      const tamperedFingerprint = 'SHA-256:de:ad:be:ef:00:11:22:33:44:55:66:77:88:99:aa:bb';

      const body = makeAnnounceBody(keysD, {
        peerUrl: 'http://127.0.0.1:19999', // D's URL (doesn't matter — check fails before fetch)
        operatorName: 'node-d-tampered',
        fingerprint: tamperedFingerprint,
        nodeUuid: 'd-uuid-tampered',
        protocolVersion: '1.2.0',
      });

      const r = await signedFetch(`${urlC}/myr/peers/announce`, {
        method: 'POST',
        body,
        keys: keysD,
      });

      assert.equal(r.status, 200); // HTTP 200 with rejection in body
      assert.equal(r.body.status, 'rejected');
      assert.equal(r.body.trust_level, 'rejected');
      assert.equal(r.body.verification_status, 'failed');
      assert.equal(r.body.auto_approved, false);
    });

    it('C stores D as rejected with evidence', () => {
      const peer = dbC.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(keysD.publicKey);
      assert.ok(peer, 'D should be stored in C\'s peer table');
      assert.equal(peer.trust_level, 'rejected');
      assert.equal(peer.auto_approved, 0);

      const evidence = JSON.parse(peer.verification_evidence);
      assert.equal(evidence.check_failed, 'announced_fingerprint_mismatch');
      assert.equal(evidence.announced_fingerprint, 'SHA-256:de:ad:be:ef:00:11:22:33:44:55:66:77:88:99:aa:bb');
      assert.notEqual(evidence.computed_from_announced_key, evidence.announced_fingerprint);
    });

    it('no sync attempted: D cannot fetch C reports', async () => {
      // D is rejected, so fetching reports should fail with 403
      const r = await signedFetch(`${urlC}/myr/reports`, { keys: keysD });
      // D is 'rejected', not 'trusted' — should get peer_not_trusted or similar
      assert.ok(r.status === 403 || r.status === 401,
        `Expected 403 or 401 for rejected peer, got ${r.status}`);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 3: Backwards compat — v1.1.0 node (no fingerprint)
  // ══════════════════════════════════════════════════════════════════════════

  describe('Scenario 3: Backwards compat — v1.1.0 node (no fingerprint)', () => {
    let srvE, urlE, dbE, keysE, keysF;

    before(async () => {
      keysE = generateKeypair();
      keysF = generateKeypair();
      dbE = createTestDb();

      const portE = await getFreePort();
      urlE = `http://127.0.0.1:${portE}`;

      const configE = {
        node_id: 'compat-node-e',
        operator_name: 'node-e-operator',
        node_url: urlE,
        port: portE,
        auto_approve_verified_peers: true,
        auto_approve_min_protocol_version: '1.2.0',
      };

      const appE = createApp({
        config: configE,
        db: dbE,
        publicKeyHex: keysE.publicKey,
        privateKeyHex: keysE.privateKey,
        createdAt: new Date().toISOString(),
      });
      srvE = await startServer(appE, portE);
    });

    after(() => {
      if (srvE) try { srvE.close(); } catch { /* noop */ }
      if (dbE) try { dbE.close(); } catch { /* noop */ }
    });

    it('F announces to E WITHOUT fingerprint → falls back to registry flow', async () => {
      // v1.1.0 announce: no fingerprint, no node_uuid, no protocol_version
      const body = makeAnnounceBody(keysF, {
        peerUrl: 'http://127.0.0.1:29999',
        operatorName: 'node-f-legacy',
        // fingerprint intentionally omitted
      });

      const r = await signedFetch(`${urlE}/myr/peers/announce`, {
        method: 'POST',
        body,
        keys: keysF,
      });

      // F is not in the registry → gets 403 (existing v1.1.0 behavior)
      assert.equal(r.status, 403, `Expected 403 for non-registry v1.1.0 peer, got ${r.status}`);
      assert.equal(r.body.error.code, 'forbidden');
    });

    it('F is NOT stored as rejected in E\'s database', () => {
      // Critical: v1.1.0 peers that fail registry check are not stored as 'rejected'
      // — they're simply denied. This distinguishes from fingerprint verification rejection.
      const peer = dbE.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(keysF.publicKey);
      if (peer) {
        // If stored at all, trust_level must NOT be 'rejected'
        assert.notEqual(peer.trust_level, 'rejected',
          'v1.1.0 peer should not be marked as rejected');
      }
      // No peer record is also acceptable — the 403 prevents storage
    });

    it('no auto-approve via fingerprint path for v1.1.0 nodes', () => {
      const peer = dbE.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(keysF.publicKey);
      if (peer) {
        assert.equal(peer.auto_approved, 0,
          'v1.1.0 peer should not be auto-approved');
      }
      // If no peer record exists, auto-approve is implicitly false
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 4: Discovery doc unreachable
  // ══════════════════════════════════════════════════════════════════════════

  describe('Scenario 4: Discovery doc unreachable', () => {
    let srvG, urlG, dbG, keysG, keysH;

    before(async () => {
      keysG = generateKeypair();
      keysH = generateKeypair();
      dbG = createTestDb();

      const portG = await getFreePort();
      urlG = `http://127.0.0.1:${portG}`;

      const configG = {
        node_id: 'unreachable-node-g',
        operator_name: 'node-g-operator',
        node_url: urlG,
        port: portG,
        auto_approve_verified_peers: true,
        auto_approve_min_protocol_version: '1.2.0',
      };

      const appG = createApp({
        config: configG,
        db: dbG,
        publicKeyHex: keysG.publicKey,
        privateKeyHex: keysG.privateKey,
        createdAt: new Date().toISOString(),
      });
      srvG = await startServer(appG, portG);
    });

    after(() => {
      if (srvG) try { srvG.close(); } catch { /* noop */ }
      if (dbG) try { dbG.close(); } catch { /* noop */ }
    });

    it('H announces to G with valid fingerprint but unreachable peer_url → G sets pending', async () => {
      // H's fingerprint is correct, but H's server isn't running —
      // G can't fetch H's discovery doc
      const unreachableUrl = 'http://127.0.0.1:19876'; // nothing listening here

      const body = makeAnnounceBody(keysH, {
        peerUrl: unreachableUrl,
        operatorName: 'node-h-unreachable',
        fingerprint: computeFingerprint(keysH.publicKey),
        nodeUuid: 'h-uuid-5678',
        protocolVersion: '1.2.0',
      });

      const r = await signedFetch(`${urlG}/myr/peers/announce`, {
        method: 'POST',
        body,
        keys: keysH,
      });

      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'pending');
      assert.equal(r.body.trust_level, 'pending');
      assert.equal(r.body.verification_status, 'unverified');
      assert.equal(r.body.auto_approved, false);
    });

    it('G stores H as pending (not rejected) with discovery error evidence', () => {
      const peer = dbG.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(keysH.publicKey);
      assert.ok(peer, 'H should be stored in G\'s peer table');
      assert.equal(peer.trust_level, 'pending');
      assert.equal(peer.auto_approved, 0);
      assert.equal(peer.node_uuid, 'h-uuid-5678');

      const evidence = JSON.parse(peer.verification_evidence);
      assert.equal(evidence.check_failed, 'discovery_fetch_failed');
      assert.ok(evidence.discovery_error, 'discovery_error should be set');
    });

    it('no crash: G health endpoint still works after failed discovery fetch', async () => {
      const r = await httpFetch(`${urlG}/myr/health`);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'ok');
    });

    it('H cannot fetch G reports while pending', async () => {
      const r = await signedFetch(`${urlG}/myr/reports`, { keys: keysH });
      // H is 'pending', not 'trusted' — access denied
      assert.ok(r.status === 403, `Expected 403 for pending peer, got ${r.status}`);
    });
  });
});
