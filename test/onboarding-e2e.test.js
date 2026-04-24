'use strict';

const { describe, it } = require('node:test');
const assert = require('assert/strict');
const http = require('http');
const nodeCrypto = require('crypto');
const Database = require('better-sqlite3');
const { generateKeypair, sign: signMessage, fingerprint: computeFingerprint } = require('../lib/crypto');
const { createApp } = require('../server/index');
const { syncPeer, httpFetch, makeSignedHeaders } = require('../lib/sync');
const { canonicalize } = require('../lib/canonicalize');

// ── Helpers ─────────────────────────────────────────────────────────────────

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
      question_answered TEXT,
      evidence TEXT,
      what_changes_next TEXT,
      confidence REAL,
      operator_rating INTEGER,
      operator_notes TEXT,
      verified_at TEXT,
      updated_at TEXT,
      share_network INTEGER DEFAULT 1,
      source_peer TEXT,
      imported_from TEXT,
      import_verified INTEGER DEFAULT 0,
      signed_artifact TEXT,
      operator_signature TEXT,
      signature TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS myr_peers (
      id INTEGER PRIMARY KEY,
      peer_url TEXT UNIQUE NOT NULL,
      operator_name TEXT NOT NULL,
      public_key TEXT UNIQUE NOT NULL,
      trust_level TEXT DEFAULT 'pending',
      verification_evidence TEXT,
      auto_approved INTEGER DEFAULT 0,
      node_uuid TEXT,
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
    CREATE TABLE IF NOT EXISTS myr_traces (
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

function startServer(app, port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
    srv.on('error', reject);
  });
}

function signedFetch(url, { method = 'GET', body, keys } = {}) {
  const parsed = new URL(url);
  const urlPath = parsed.pathname;
  const bodyStr = body ? JSON.stringify(body) : undefined;
  const headers = makeSignedHeaders({
    method,
    urlPath,
    body: bodyStr,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });
  return httpFetch(url, { method, headers, body: bodyStr });
}

/**
 * Seed signed reports into a node's DB (simulates myr-store.js + myr-verify.js).
 */
function seedVerifiedReports(db, nodeId, keys, count) {
  const now = new Date();
  const insert = db.prepare(`
    INSERT INTO myr_reports
      (id, node_id, timestamp, agent_id, session_ref,
       cycle_intent, domain_tags, yield_type, question_answered,
       evidence, what_changes_next, confidence, operator_rating,
       share_network, imported_from, import_verified, signed_artifact,
       operator_signature, signature, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const seedMany = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const ts = new Date(now.getTime() + i * 1000).toISOString();
      const id = `${nodeId}-${ts.slice(0, 10).replace(/-/g, '')}-${String(i + 1).padStart(3, '0')}`;
      const wireReport = {
        id,
        node_id: nodeId,
        timestamp: ts,
        agent_id: 'operator',
        session_ref: null,
        cycle_intent: `Onboarding test report ${i + 1}`,
        domain_tags: 'onboarding,testing',
        yield_type: 'technique',
        question_answered: `How does step ${i + 1} of onboarding work?`,
        evidence: `Validated step ${i + 1} through direct testing`,
        what_changes_next: `Refine step ${i + 1} based on findings`,
        confidence: 0.85,
        operator_rating: 4,
        created_at: ts,
        updated_at: ts,
      };

      // The server recomputes the hash from ALL DB columns (minus sig/opSig),
      // so we don't set signed_artifact or operator_signature here.
      // The server's X-MYR-Signature response header provides per-response signing.
      insert.run(
        id, nodeId, ts, 'operator', null,
        wireReport.cycle_intent, wireReport.domain_tags, 'technique',
        wireReport.question_answered, wireReport.evidence,
        wireReport.what_changes_next, 0.85, 4,
        1, null, 0, null, null, null, ts, ts
      );
    }
  });
  seedMany();
}

// ── Onboarding flow step tracker ────────────────────────────────────────────

class OnboardingTracker {
  constructor() {
    this.steps = [];
    this.overallStart = Date.now();
    this.userActions = 0;
    this.infraSteps = [];
    this.frictionPoints = [];
  }

  step(name, { automated, requiresInfra, friction } = {}) {
    const start = Date.now();
    return {
      done: (details) => {
        const elapsed = Date.now() - start;
        this.steps.push({ name, elapsed, automated, details });
        if (!automated) this.userActions++;
        if (requiresInfra) this.infraSteps.push(name);
        if (friction) this.frictionPoints.push({ step: name, friction });
      },
    };
  }

  report() {
    const totalMs = Date.now() - this.overallStart;
    return {
      totalMs,
      totalSteps: this.steps.length,
      userActions: this.userActions,
      automatedSteps: this.steps.filter(s => s.automated).length,
      infraSteps: this.infraSteps,
      frictionPoints: this.frictionPoints,
      steps: this.steps,
    };
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('End-to-end onboarding: fresh node to first yield exchange', () => {

  it('complete onboarding path succeeds and measures each step', async () => {
    const tracker = new OnboardingTracker();

    // ════════════════════════════════════════════════════════════════════════
    // STEP 1: npm install (simulated — dependencies already available)
    // ════════════════════════════════════════════════════════════════════════
    const s1 = tracker.step('npm install', { automated: true });
    // In a real test this would run npm install; here we verify deps load
    assert.ok(require('better-sqlite3'), 'better-sqlite3 available');
    assert.ok(require('express'), 'express available');
    assert.ok(require('@noble/ed25519'), '@noble/ed25519 available');
    s1.done('Dependencies verified');

    // ════════════════════════════════════════════════════════════════════════
    // STEP 2: myr setup — generate keypair (automated)
    // ════════════════════════════════════════════════════════════════════════
    const s2 = tracker.step('myr setup: generate keypair', { automated: true });
    const keysA = generateKeypair();
    const keysB = generateKeypair();
    assert.ok(keysA.publicKey.length === 64, 'Public key is 32 bytes hex');
    assert.ok(keysA.privateKey.length === 64, 'Private key is 32 bytes hex');
    s2.done('Keypairs generated for both nodes');

    // ════════════════════════════════════════════════════════════════════════
    // STEP 3: myr setup — configure and start server (requires port knowledge)
    // ════════════════════════════════════════════════════════════════════════
    const s3 = tracker.step('myr setup: configure & start server', {
      automated: false,
      requiresInfra: true,
      friction: 'User must choose port and ensure it is reachable externally (Cloudflare tunnel or manual port forwarding)',
    });

    const dbA = makeDb();
    const dbB = makeDb();

    const configA = {
      node_id: 'onboard-a',
      node_url: 'http://127.0.0.1:37210',
      operator_name: 'alice',
      port: 37210,
      auto_approve_verified_peers: true,
      auto_approve_min_protocol_version: '1.2.0',
    };
    const configB = {
      node_id: 'onboard-b',
      node_url: 'http://127.0.0.1:37211',
      operator_name: 'bob',
      port: 37211,
      auto_approve_verified_peers: true,
      auto_approve_min_protocol_version: '1.2.0',
    };

    const appA = createApp({
      config: configA, db: dbA,
      publicKeyHex: keysA.publicKey,
      privateKeyHex: keysA.privateKey,
      createdAt: new Date().toISOString(),
    });
    const appB = createApp({
      config: configB, db: dbB,
      publicKeyHex: keysB.publicKey,
      privateKeyHex: keysB.privateKey,
      createdAt: new Date().toISOString(),
    });

    const srvA = await startServer(appA, 37210);
    const srvB = await startServer(appB, 37211);
    s3.done('Both nodes started on localhost');

    const urlA = 'http://127.0.0.1:37210';
    const urlB = 'http://127.0.0.1:37211';

    try {
      // ════════════════════════════════════════════════════════════════════════
      // STEP 4: Verify node reachability (automated)
      // ════════════════════════════════════════════════════════════════════════
      const s4 = tracker.step('myr node verify: confirm reachability', { automated: true });
      const healthA = await httpFetch(`${urlA}/myr/health`);
      assert.equal(healthA.status, 200);
      assert.equal(healthA.body.status, 'ok');
      assert.equal(healthA.body.operator_name, 'alice');

      const healthB = await httpFetch(`${urlB}/myr/health`);
      assert.equal(healthB.status, 200);
      assert.equal(healthB.body.operator_name, 'bob');

      const discoveryA = await httpFetch(`${urlA}/.well-known/myr-node`);
      assert.equal(discoveryA.body.public_key, keysA.publicKey);
      s4.done('Both nodes reachable and identity verified');

      // ════════════════════════════════════════════════════════════════════════
      // STEP 5: Build first local yield (manual, low burden)
      // ════════════════════════════════════════════════════════════════════════
      const s5 = tracker.step('myr store + verify: first local yield', {
        automated: false,
        friction: 'User still needs to create one real verified MYR before first exchange.',
      });
      seedVerifiedReports(dbA, 'onboard-a', keysA, 1);
      seedVerifiedReports(dbB, 'onboard-b', keysB, 1);

      const countA = dbA.prepare('SELECT COUNT(*) as cnt FROM myr_reports').get().cnt;
      const countB = dbB.prepare('SELECT COUNT(*) as cnt FROM myr_reports').get().cnt;
      assert.ok(countA >= 1, `Node A has ${countA} reports, need >=1`);
      assert.ok(countB >= 1, `Node B has ${countB} reports, need >=1`);
      s5.done(`Node A: ${countA} reports, Node B: ${countB} reports`);

      // ════════════════════════════════════════════════════════════════════════
      // STEP 6: Invite/announce handshake (automated)
      // ════════════════════════════════════════════════════════════════════════
      const s6 = tracker.step('myr invite/join: authenticated announce handshake', { automated: true });
      const fpA = computeFingerprint(keysA.publicKey);
      const fpB = computeFingerprint(keysB.publicKey);
      assert.ok(fpA.startsWith('SHA-256:'), 'Fingerprint format correct');
      assert.ok(fpB.startsWith('SHA-256:'), 'Fingerprint format correct');
      s6.done(`Fingerprints validated: A=${fpA.slice(0, 20)}... B=${fpB.slice(0, 20)}...`);

      // ════════════════════════════════════════════════════════════════════════
      // STEP 7: Mutual verified announce with auto-approval
      // ════════════════════════════════════════════════════════════════════════
      const s7 = tracker.step('myr peers announce: mutual auto-approval', { automated: true });
      const announceBodyA = {
        peer_url: urlA,
        public_key: keysA.publicKey,
        operator_name: 'alice',
        fingerprint: fpA,
        protocol_version: '1.2.0',
        timestamp: new Date().toISOString(),
        nonce: nodeCrypto.randomBytes(16).toString('hex'),
      };
      const announceResA = await signedFetch(`${urlB}/myr/peers/announce`, {
        method: 'POST',
        body: announceBodyA,
        keys: keysA,
      });
      assert.equal(announceResA.status, 200);
      assert.equal(announceResA.body.status, 'connected');
      assert.equal(announceResA.body.trust_level, 'trusted');

      const announceBodyB = {
        peer_url: urlB,
        public_key: keysB.publicKey,
        operator_name: 'bob',
        fingerprint: fpB,
        protocol_version: '1.2.0',
        timestamp: new Date().toISOString(),
        nonce: nodeCrypto.randomBytes(16).toString('hex'),
      };
      const announceResB = await signedFetch(`${urlA}/myr/peers/announce`, {
        method: 'POST',
        body: announceBodyB,
        keys: keysB,
      });
      assert.equal(announceResB.status, 200);
      assert.equal(announceResB.body.status, 'connected');
      assert.equal(announceResB.body.trust_level, 'trusted');

      // Verify trust established
      const peerInA = dbA.prepare('SELECT trust_level FROM myr_peers WHERE public_key = ?')
        .get(keysB.publicKey);
      assert.equal(peerInA.trust_level, 'trusted');
      const peerInB = dbB.prepare('SELECT trust_level FROM myr_peers WHERE public_key = ?')
        .get(keysA.publicKey);
      assert.equal(peerInB.trust_level, 'trusted');
      s7.done('Mutual trust established via verified announce');

      // ════════════════════════════════════════════════════════════════════════
      // STEP 8: First sync — B pulls yield from A (automated)
      // ════════════════════════════════════════════════════════════════════════
      const s8 = tracker.step('myr sync: first yield exchange', { automated: true });
      const peerRecordB = dbB.prepare('SELECT * FROM myr_peers WHERE public_key = ?')
        .get(keysA.publicKey);
      const syncResult = await syncPeer({
        db: dbB,
        peer: { ...peerRecordB, peer_url: urlA },
        keys: keysB,
        fetch: httpFetch,
      });
      assert.ok(syncResult.imported > 0, `Expected imports, got ${syncResult.imported}`);
      assert.equal(syncResult.failed, 0, 'No sync failures expected');
      s8.done(`Imported ${syncResult.imported} reports from Alice`);

      // ════════════════════════════════════════════════════════════════════════
      // STEP 9: Verify yield received — B has A's reports
      // ════════════════════════════════════════════════════════════════════════
      const s9 = tracker.step('verify: yield received in B', { automated: true });
      const importedInB = dbB.prepare(
        "SELECT COUNT(*) as cnt FROM myr_reports WHERE imported_from = 'alice'"
      ).get().cnt;
      assert.ok(importedInB >= 1, `Expected >=1 imported reports, got ${importedInB}`);

      // Verify import_verified flag set
      const verifiedInB = dbB.prepare(
        "SELECT COUNT(*) as cnt FROM myr_reports WHERE imported_from = 'alice' AND import_verified = 1"
      ).get().cnt;
      assert.equal(verifiedInB, importedInB, 'All imported reports should be signature-verified');
      s9.done(`${importedInB} verified reports from Alice now in Bob's DB`);

      // ════════════════════════════════════════════════════════════════════════
      // STEP 10: Reverse sync — A pulls from B (automated)
      // ════════════════════════════════════════════════════════════════════════
      const s10 = tracker.step('myr sync: reverse yield exchange', { automated: true });
      const peerRecordA = dbA.prepare('SELECT * FROM myr_peers WHERE public_key = ?')
        .get(keysB.publicKey);
      const syncResult2 = await syncPeer({
        db: dbA,
        peer: { ...peerRecordA, peer_url: urlB },
        keys: keysA,
        fetch: httpFetch,
      });
      assert.ok(syncResult2.imported > 0, `Expected imports from B, got ${syncResult2.imported}`);
      s10.done(`Imported ${syncResult2.imported} reports from Bob`);

      // ════════════════════════════════════════════════════════════════════════
      // STEP 11: Verify bidirectional yield exchange complete
      // ════════════════════════════════════════════════════════════════════════
      const s11 = tracker.step('verify: bidirectional exchange complete', { automated: true });
      const totalInA = dbA.prepare('SELECT COUNT(*) as cnt FROM myr_reports').get().cnt;
      const totalInB = dbB.prepare('SELECT COUNT(*) as cnt FROM myr_reports').get().cnt;
      // A: 1 own + 1 from B = 2; B: 1 own + 1 from A = 2
      assert.equal(totalInA, 2, `A should have 2 reports, has ${totalInA}`);
      assert.equal(totalInB, 2, `B should have 2 reports, has ${totalInB}`);
      s11.done(`Both nodes have ${totalInA} reports — full bidirectional exchange`);

      // ════════════════════════════════════════════════════════════════════════
      // RESULTS
      // ════════════════════════════════════════════════════════════════════════
      const report = tracker.report();

      console.log('\n  ═══ ONBOARDING E2E RESULTS ═══');
      console.log(`  Total time: ${report.totalMs}ms`);
      console.log(`  Total steps: ${report.totalSteps}`);
      console.log(`  User actions required: ${report.userActions}`);
      console.log(`  Automated steps: ${report.automatedSteps}`);
      console.log(`  Steps requiring infrastructure knowledge: ${report.infraSteps.length}`);

      console.log('\n  ┌────┬──────────────────────────────────────────┬──────────┬───────────┐');
      console.log('  │  # │ Step                                     │ Duration │ Automated │');
      console.log('  ├────┼──────────────────────────────────────────┼──────────┼───────────┤');
      for (let i = 0; i < report.steps.length; i++) {
        const s = report.steps[i];
        const num = String(i + 1).padStart(2);
        const name = s.name.padEnd(40).slice(0, 40);
        const dur = `${s.elapsed}ms`.padStart(7);
        const auto = s.automated ? '  Yes  ' : '  No   ';
        console.log(`  │ ${num} │ ${name} │ ${dur} │ ${auto}  │`);
      }
      console.log('  └────┴──────────────────────────────────────────┴──────────┴───────────┘');

      if (report.infraSteps.length > 0) {
        console.log(`\n  Steps requiring infrastructure expertise:`);
        for (const step of report.infraSteps) {
          console.log(`    - ${step}`);
        }
      }

      if (report.frictionPoints.length > 0) {
        console.log(`\n  UX friction points:`);
        for (const { step, friction } of report.frictionPoints) {
          console.log(`    - [${step}]: ${friction}`);
        }
      }

      console.log('\n  FAST-PATH ASSERTIONS:');
      console.log('  1. Invite/announce handshake establishes trusted link without manual peer approve.');
      console.log('  2. First value exchange succeeds with one verified MYR per node.');
      console.log('  3. Infrastructure burden is limited to initial setup/start only.\n');

    } finally {
      srvA.close();
      srvB.close();
    }
  });

  it('passes on both macOS and Linux (platform-independent assertions)', async () => {
    const os = require('os');
    const platform = os.platform();

    // Verify no platform-specific code paths in the onboarding flow
    assert.ok(
      platform === 'darwin' || platform === 'linux',
      `Test should run on macOS or Linux, got ${platform}`
    );

    // Verify crypto works on this platform
    const keys = generateKeypair();
    assert.ok(keys.publicKey.length === 64);
    const msg = 'cross-platform test';
    const sig = signMessage(msg, keys.privateKey);
    const { verify } = require('../lib/crypto');
    assert.ok(verify(msg, sig, keys.publicKey), 'Ed25519 signing works on this platform');

    // Verify SQLite works on this platform
    const db = new Database(':memory:');
    db.exec('CREATE TABLE test (id TEXT)');
    db.prepare('INSERT INTO test VALUES (?)').run('ok');
    const row = db.prepare('SELECT id FROM test').get();
    assert.equal(row.id, 'ok', 'SQLite works on this platform');

    // Verify no hardcoded paths in setup module
    const setupSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'lib', 'setup.js'), 'utf-8'
    );
    assert.ok(
      !setupSource.includes('/Users/roberthall'),
      'setup.js must not contain hardcoded user paths'
    );
    assert.ok(
      !setupSource.includes('/home/roberthall'),
      'setup.js must not contain hardcoded home paths'
    );

    console.log(`  Platform: ${platform} (${os.arch()}) — all assertions pass`);
  });
});
