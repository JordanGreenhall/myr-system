'use strict';

/**
 * test/onboarding-truth-test.js — STA-165: Hard acceptance gate
 *
 * This is the TRUTH TEST for onboarding. It measures the actual lived
 * experience of going from a clean node to first real value exchange.
 *
 * Unlike the E2E test (STA-143) which validates protocol correctness,
 * this test enforces the STA-157 acceptance standard:
 *
 *   - 0 infrastructure decisions required
 *   - 0 manual approvals required on the normal path
 *   - 1 invite acceptance (the only user action)
 *   - First yield received without manual sync scheduling
 *   - No tunnel/DHT/NAT/Hyperspace terminology visible to user
 *   - Install to first yield < 10 minutes
 *
 * Every friction point that violates the standard is a HARD FAILURE.
 */

const { describe, it } = require('node:test');
const assert = require('assert/strict');
const http = require('http');
const Database = require('better-sqlite3');
const { generateKeypair, sign: signMessage, fingerprint: computeFingerprint } = require('../lib/crypto');
const { createApp } = require('../server/index');
const { syncPeer, httpFetch, makeSignedHeaders } = require('../lib/sync');
const { computeStage, STAGES, PROMOTION_CRITERIA } = require('../lib/participation');

// ── Friction Audit Ledger ───────────────────────────────────────────────────

class FrictionLedger {
  constructor() {
    this.userActions = [];
    this.infraDecisions = [];
    this.manualInterventions = [];
    this.hiddenDependencies = [];
    this.ceremonySteps = [];
    this.terminologyLeaks = [];
    this.timeMarkers = {};
    this.startTime = Date.now();
  }

  userAction(name, details) {
    this.userActions.push({ name, details, at: Date.now() - this.startTime });
  }

  infraDecision(name, details) {
    this.infraDecisions.push({ name, details, at: Date.now() - this.startTime });
  }

  manualIntervention(name, details) {
    this.manualInterventions.push({ name, details, at: Date.now() - this.startTime });
  }

  hiddenDependency(name, details) {
    this.hiddenDependencies.push({ name, details, at: Date.now() - this.startTime });
  }

  ceremony(name, details) {
    this.ceremonySteps.push({ name, details, at: Date.now() - this.startTime });
  }

  terminologyLeak(term, context) {
    this.terminologyLeaks.push({ term, context, at: Date.now() - this.startTime });
  }

  mark(name) {
    this.timeMarkers[name] = Date.now() - this.startTime;
  }

  elapsed() {
    return Date.now() - this.startTime;
  }

  summary() {
    return {
      userActions: this.userActions.length,
      infraDecisions: this.infraDecisions.length,
      manualInterventions: this.manualInterventions.length,
      hiddenDependencies: this.hiddenDependencies.length,
      ceremonySteps: this.ceremonySteps.length,
      terminologyLeaks: this.terminologyLeaks.length,
      totalFrictionPoints:
        this.userActions.length +
        this.infraDecisions.length +
        this.manualInterventions.length +
        this.ceremonySteps.length,
      elapsedMs: this.elapsed(),
    };
  }

  printReport() {
    const s = this.summary();
    console.log('\n  ═══════════════════════════════════════════════════════════════');
    console.log('  ONBOARDING TRUTH TEST — FRICTION LEDGER');
    console.log('  ═══════════════════════════════════════════════════════════════');
    console.log(`  Total elapsed:              ${s.elapsedMs}ms`);
    console.log(`  User actions:               ${s.userActions}  (target: ≤ 1)`);
    console.log(`  Infrastructure decisions:   ${s.infraDecisions}  (target: 0)`);
    console.log(`  Manual interventions:       ${s.manualInterventions}  (target: 0)`);
    console.log(`  Hidden dependencies:        ${s.hiddenDependencies}`);
    console.log(`  Ceremony steps:             ${s.ceremonySteps}`);
    console.log(`  Terminology leaks:          ${s.terminologyLeaks}`);
    console.log(`  ───────────────────────────────────────────────────────────────`);
    console.log(`  TOTAL FRICTION POINTS:      ${s.totalFrictionPoints}`);

    if (this.infraDecisions.length > 0) {
      console.log('\n  INFRASTRUCTURE DECISIONS (each is a gate failure):');
      for (const d of this.infraDecisions) {
        console.log(`    ✗ ${d.name}: ${d.details}`);
      }
    }
    if (this.manualInterventions.length > 0) {
      console.log('\n  MANUAL INTERVENTIONS (each is a gate failure):');
      for (const m of this.manualInterventions) {
        console.log(`    ✗ ${m.name}: ${m.details}`);
      }
    }
    if (this.hiddenDependencies.length > 0) {
      console.log('\n  HIDDEN DEPENDENCIES:');
      for (const h of this.hiddenDependencies) {
        console.log(`    ⚠ ${h.name}: ${h.details}`);
      }
    }
    if (this.ceremonySteps.length > 0) {
      console.log('\n  CEREMONY (friction without value):');
      for (const c of this.ceremonySteps) {
        console.log(`    ✗ ${c.name}: ${c.details}`);
      }
    }
    if (this.terminologyLeaks.length > 0) {
      console.log('\n  TERMINOLOGY LEAKS (user should never see these):');
      for (const t of this.terminologyLeaks) {
        console.log(`    ✗ "${t.term}" in ${t.context}`);
      }
    }
    console.log('  ═══════════════════════════════════════════════════════════════\n');
  }
}

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

function seedVerifiedReports(db, nodeId, count) {
  const now = new Date();
  const insert = db.prepare(`
    INSERT INTO myr_reports
      (id, node_id, timestamp, agent_id, cycle_intent, domain_tags,
       yield_type, question_answered, evidence, what_changes_next,
       confidence, operator_rating, share_network, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const ts = new Date(now.getTime() + i * 1000).toISOString();
      const id = `${nodeId}-${ts.slice(0, 10).replace(/-/g, '')}-${String(i + 1).padStart(3, '0')}`;
      insert.run(
        id, nodeId, ts, 'operator',
        `Test report ${i + 1}`, 'testing,onboarding', 'technique',
        `Question ${i + 1}?`, `Evidence ${i + 1}`,
        `Next ${i + 1}`, 0.85, 4, 1, ts, ts
      );
    }
  });
  tx();
}

function extractCliCommandBlock(source, commandSignature) {
  const startNeedle = `.command('${commandSignature}')`;
  const start = source.indexOf(startNeedle);
  if (start === -1) return '';
  const nextHeader = source.indexOf('\n  // ── myr ', start + startNeedle.length);
  if (nextHeader === -1) return source.slice(start);
  return source.slice(start, nextHeader);
}

// ── Acceptance Thresholds (from STA-157 §5) ─────────────────────────────────

const ACCEPTANCE = {
  maxUserActions: 1,            // Only invite acceptance
  maxInfraDecisions: 0,         // Zero infrastructure reasoning
  maxManualApprovals: 0,        // Auto-approve on mutual introduction
  maxManualSyncTriggers: 0,     // Background auto-sync required
  maxTerminologyLeaks: 0,       // No tunnel/DHT/NAT/Hyperspace visible
  maxTimeToFirstYieldMs: 10 * 60 * 1000,  // 10 minutes
  minYieldReceivedCount: 1,     // At least 1 report received
};

// Banned terms — user should never see these in normal path
const BANNED_TERMINOLOGY = [
  'cloudflare', 'tunnel', 'tailscale', 'funnel',
  'NAT', 'port forward', 'DHT', 'hyperswarm', 'hyperspace',
  'CLOUDFLARE_TUNNEL_TOKEN',
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Onboarding truth test: acceptance gate (STA-165)', () => {

  it('audits the onboarding normal path and reports friction violations', async () => {
    const ledger = new FrictionLedger();

    // ── Phase 1: Installation ──────────────────────────────────────────────
    // In the ideal state: `npx myr-system` or `curl | sh`.
    // Current state: clone repo + npm install.

    ledger.mark('install_start');

    // AUDIT: Is there a published npm package with a bin entry?
    const fs = require('fs');
    const pkgPath = require('path').join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const hasBinEntry = !!(pkg.bin && (pkg.bin.myr || pkg.bin['myr-system']));
    if (!hasBinEntry) {
      ledger.hiddenDependency('no-npm-bin',
        'No bin entry in package.json — user cannot `npx myr-system`');
    }

    // AUDIT: Does the install script exist and work without git clone?
    const installScript = require('path').join(__dirname, '..', 'scripts', 'gate3-unified-install.sh');
    const hasInstallScript = fs.existsSync(installScript);
    if (!hasInstallScript) {
      ledger.hiddenDependency('no-installer',
        'No unified install script — user must clone repo manually');
    }

    ledger.mark('install_end');

    // ── Phase 2: Setup (myr setup) ────────────────────────────────────────
    // Ideal: `myr setup` completes with 0 questions.
    // Current: requires tunnel provider choice + potentially browser auth.

    ledger.mark('setup_start');

    const cliSource = fs.readFileSync(
      require('path').join(__dirname, '..', 'bin', 'myr.js'), 'utf8'
    );
    const setupCommandBlock = extractCliCommandBlock(cliSource, 'setup');

    // AUDIT: normal path setup should not expose infrastructure choices.
    if (setupCommandBlock.includes('--tunnel-provider')) {
      ledger.infraDecision('tunnel-provider-choice',
        'myr setup exposes a tunnel provider choice instead of auto-selecting infrastructure');
    }
    if (setupCommandBlock.includes('--tunnel-token') || setupCommandBlock.includes('CLOUDFLARE_TUNNEL_TOKEN')) {
      ledger.infraDecision('tunnel-token-env',
        'myr setup references tunnel token configuration on the normal path');
    }
    if (setupCommandBlock.includes('--public-url') || setupCommandBlock.includes('--port')) {
      ledger.infraDecision('manual-network-inputs',
        'myr setup asks for networking inputs instead of using onboarding defaults');
    }

    const inviteCreateBlock = extractCliCommandBlock(cliSource, 'create');
    const joinBlock = extractCliCommandBlock(cliSource, 'join <inviteUrl>');
    const normalPathCopy = [setupCommandBlock, inviteCreateBlock, joinBlock].join('\n');

    // Generate keys (this part is automated — no friction)
    const keysExisting = generateKeypair();
    const keysNew = generateKeypair();

    const dbExisting = makeDb();
    const dbNew = makeDb();

    // Seed existing node with yield so there's something to receive
    seedVerifiedReports(dbExisting, 'existing-node', 5);

    const configExisting = {
      node_id: 'existing-node',
      node_url: 'http://127.0.0.1:37220',
      operator_name: 'alice',
      port: 37220,
    };
    const configNew = {
      node_id: 'new-node',
      node_url: 'http://127.0.0.1:37221',
      operator_name: 'bob',
      port: 37221,
    };

    const appExisting = createApp({
      config: configExisting, db: dbExisting,
      publicKeyHex: keysExisting.publicKey,
      privateKeyHex: keysExisting.privateKey,
      createdAt: new Date().toISOString(),
    });
    const appNew = createApp({
      config: configNew, db: dbNew,
      publicKeyHex: keysNew.publicKey,
      privateKeyHex: keysNew.privateKey,
      createdAt: new Date().toISOString(),
    });

    const srvExisting = await startServer(appExisting, 37220);
    const srvNew = await startServer(appNew, 37221);

    ledger.mark('setup_end');

    const urlExisting = 'http://127.0.0.1:37220';
    const urlNew = 'http://127.0.0.1:37221';

    try {
      // ── Phase 3: Peer Discovery + Connection ─────────────────────────────
      // Ideal: accept invite link → peer added + auto-approved.
      // Current: out-of-band fingerprint exchange + manual introduce + manual approve.

      ledger.mark('peer_connect_start');

      const fpExisting = computeFingerprint(keysExisting.publicKey);
      const fpNew = computeFingerprint(keysNew.publicKey);

      // AUDIT: normal path should support invite link creation + join.
      const hasInviteCreate = cliSource.includes(".command('invite')") && cliSource.includes(".command('create')");
      const hasInviteJoin = cliSource.includes(".command('join <inviteUrl>')");

      if (!hasInviteCreate || !hasInviteJoin) {
        ledger.manualIntervention('no-invite-join',
          'Missing invite create/join flow — user must exchange fingerprints out-of-band');
      }

      // Current path: mutual introduction (simulates `myr peer add`)
      // This counts as a user action only if the user had to obtain the URL out-of-band
      if (!hasInviteCreate || !hasInviteJoin) {
        ledger.userAction('obtain-peer-url',
          'User must obtain peer URL and/or fingerprint via Signal/email/in-person');
      }

      // Introduce new node to existing node
      const intro1 = await httpFetch(`${urlExisting}/myr/peer/introduce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identity_document: {
            protocol_version: '1.0.0',
            public_key: keysNew.publicKey,
            fingerprint: fpNew,
            operator_name: 'bob',
            node_url: urlNew,
            capabilities: ['report-sync'],
            created_at: new Date().toISOString(),
          },
        }),
      });
      assert.equal(intro1.status, 200, 'Introduction to existing node should succeed');

      // Existing node introduces back to new node
      const intro2 = await httpFetch(`${urlNew}/myr/peer/introduce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identity_document: {
            protocol_version: '1.0.0',
            public_key: keysExisting.publicKey,
            fingerprint: fpExisting,
            operator_name: 'alice',
            node_url: urlExisting,
            capabilities: ['report-sync'],
            created_at: new Date().toISOString(),
          },
        }),
      });
      assert.equal(intro2.status, 200, 'Reverse introduction should succeed');

      // AUDIT: join flow should auto-approve by default.
      const joinAutoApproveEnabled =
        cliSource.includes(".option('--no-auto-approve'") &&
        cliSource.includes('if (opts.autoApprove)') &&
        cliSource.includes('approvePeer({ db, identifier: peer.public_key });');

      if (!joinAutoApproveEnabled) {
        ledger.ceremony('manual-approval-required',
          'Join flow does not auto-approve by default; manual `myr peer approve` is still required.');
      }

      // Test plumbing: ensure peers are trusted so sync assertions can run.
      const approveA = await signedFetch(`${urlExisting}/myr/peer/approve`, {
        method: 'POST',
        body: { peer_fingerprint: fpNew, trust_level: 'trusted' },
        keys: keysExisting,
      });
      assert.equal(approveA.status, 200, 'Existing node approves new node');

      const approveB = await signedFetch(`${urlNew}/myr/peer/approve`, {
        method: 'POST',
        body: { peer_fingerprint: fpExisting, trust_level: 'trusted' },
        keys: keysNew,
      });
      assert.equal(approveB.status, 200, 'New node approves existing node');

      ledger.mark('peer_connect_end');

      // ── Phase 4: First Yield Corpus ──────────────────────────────────────
      // Ideal: new node can receive yield with 0 local reports.
      // Current: promotion criteria may require local reports first.

      ledger.mark('yield_exchange_start');

      // AUDIT: Does the new node need local reports before it can receive?
      const promoCriteria = PROMOTION_CRITERIA['local-only→provisional'];
      // New node has 0 reports. Check if it can sync at all.
      const newNodeMyrCount = dbNew.prepare(
        'SELECT COUNT(*) as cnt FROM myr_reports'
      ).get().cnt;

      if (newNodeMyrCount === 0) {
        // The new node has no yield. In the ideal flow, that's fine —
        // provisional nodes should be able to RECEIVE even with 0 local reports.
        // Let's check if the protocol actually allows it.
      }

      // AUDIT: Does the existing E2E test require ≥10 reports before first sync?
      // The existing test seeds 10-12 reports per node before syncing.
      // The participation model requires 10+ shared MYRs for provisional→bounded,
      // but provisional should allow sync with fewer.
      const provisionalStage = STAGES['provisional'];
      assert.ok(provisionalStage.capabilities.canSync,
        'Provisional stage should allow sync');
      assert.ok(provisionalStage.capabilities.canReceiveYield,
        'Provisional stage should allow receiving yield');

      // ── Phase 5: Sync ────────────────────────────────────────────────────
      // Ideal: auto-sync runs in background, no user trigger needed.
      // Current: user must run `myr sync --peer <fp>` manually.

      // AUDIT: Is there background auto-sync?
      const hasAutoSync = cliSource.includes('auto-sync') ||
        cliSource.includes('autoSync') ||
        cliSource.includes('sync scheduler') ||
        cliSource.includes('setInterval');

      // Check for a `myr start` that launches a sync loop
      const startCommandHasSync = cliSource.includes("'start'") &&
        (cliSource.includes('syncInterval') || cliSource.includes('auto_sync'));

      if (!hasAutoSync && !startCommandHasSync) {
        ledger.manualIntervention('no-auto-sync',
          'No background auto-sync — user must manually run `myr sync --peer <fp>` for each peer');
      }

      // Perform sync (current manual path)
      const peerRecordNew = dbNew.prepare(
        'SELECT * FROM myr_peers WHERE public_key = ?'
      ).get(keysExisting.publicKey);

      const syncResult = await syncPeer({
        db: dbNew,
        peer: { ...peerRecordNew, peer_url: urlExisting },
        keys: keysNew,
        fetch: httpFetch,
      });

      ledger.mark('yield_exchange_end');

      // ── Phase 6: Verify Value Received ───────────────────────────────────

      const importedCount = dbNew.prepare(
        "SELECT COUNT(*) as cnt FROM myr_reports WHERE imported_from = 'alice'"
      ).get().cnt;

      const verifiedCount = dbNew.prepare(
        "SELECT COUNT(*) as cnt FROM myr_reports WHERE imported_from = 'alice' AND import_verified = 1"
      ).get().cnt;

      assert.ok(importedCount >= ACCEPTANCE.minYieldReceivedCount,
        `New node received ${importedCount} reports (need ≥ ${ACCEPTANCE.minYieldReceivedCount})`);
      assert.equal(verifiedCount, importedCount,
        'All imported reports should be signature-verified');

      // ── Phase 7: Status Visibility ───────────────────────────────────────
      // Ideal: `myr status` shows stage, peers, progress, next actions.
      // Current: shows identity and peers but not participation stage.

      const hasStageInStatus = cliSource.includes('participation') &&
        cliSource.includes('status');
      const hasProgressGuidance = cliSource.includes('next stage') ||
        cliSource.includes('progress') ||
        cliSource.includes('to reach');

      if (!hasStageInStatus) {
        ledger.hiddenDependency('no-stage-visibility',
          '`myr status` does not show participation stage or progress toward next stage');
      }

      // ── Phase 8: CLI terminology audit ───────────────────────────────────

      for (const term of BANNED_TERMINOLOGY) {
        if (normalPathCopy.toLowerCase().includes(term.toLowerCase())) {
          ledger.terminologyLeak(term, 'normal-path CLI copy');
        }
      }

      // ── Print Full Report ────────────────────────────────────────────────

      ledger.printReport();

      const summary = ledger.summary();

      // ══════════════════════════════════════════════════════════════════════
      // HARD ACCEPTANCE ASSERTIONS
      // These are the pass/fail criteria. Each one that fails means
      // onboarding is NOT yet at the one-click smooth standard.
      // ══════════════════════════════════════════════════════════════════════

      console.log('  ── ACCEPTANCE GATE VERDICTS ──\n');

      const verdicts = [];

      function verdict(name, pass, detail) {
        const mark = pass ? '✓ PASS' : '✗ FAIL';
        verdicts.push({ name, pass, detail });
        console.log(`  ${mark}: ${name}`);
        if (detail) console.log(`         ${detail}`);
      }

      verdict(
        'Infrastructure decisions = 0',
        summary.infraDecisions === ACCEPTANCE.maxInfraDecisions,
        `${summary.infraDecisions} infrastructure decisions found (target: ${ACCEPTANCE.maxInfraDecisions})`
      );

      verdict(
        'User actions ≤ 1 (invite accept only)',
        summary.userActions <= ACCEPTANCE.maxUserActions,
        `${summary.userActions} user actions found (target: ≤ ${ACCEPTANCE.maxUserActions})`
      );

      verdict(
        'Manual approvals = 0 (auto-approve on mutual intro)',
        ledger.ceremonySteps.length === 0,
        ledger.ceremonySteps.length > 0
          ? `${ledger.ceremonySteps.length} ceremony steps still required`
          : 'Auto-approve or equivalent in place'
      );

      verdict(
        'Manual sync triggers = 0 (background auto-sync)',
        !ledger.manualInterventions.find(m => m.name === 'no-auto-sync'),
        ledger.manualInterventions.find(m => m.name === 'no-auto-sync')
          ? 'No background sync scheduler — user must trigger sync manually'
          : 'Auto-sync available'
      );

      verdict(
        'No banned terminology visible to user',
        summary.terminologyLeaks === ACCEPTANCE.maxTerminologyLeaks,
        `${summary.terminologyLeaks} terminology leaks found (target: ${ACCEPTANCE.maxTerminologyLeaks})`
      );

      verdict(
        'First yield received',
        importedCount >= ACCEPTANCE.minYieldReceivedCount,
        `${importedCount} reports imported into new node`
      );

      verdict(
        'All imports signature-verified',
        verifiedCount === importedCount,
        `${verifiedCount}/${importedCount} verified`
      );

      console.log('\n  ── SUMMARY ──\n');
      const passCount = verdicts.filter(v => v.pass).length;
      const failCount = verdicts.filter(v => !v.pass).length;
      console.log(`  ${passCount} passed, ${failCount} failed out of ${verdicts.length} acceptance criteria`);

      if (failCount > 0) {
        console.log('\n  GATE STATUS: ✗ FAIL — onboarding does not yet meet the one-click smooth standard');
        console.log('  The following delta work items remain:\n');
        for (const v of verdicts.filter(v => !v.pass)) {
          console.log(`    - ${v.name}: ${v.detail}`);
        }
      } else {
        console.log('\n  GATE STATUS: ✓ PASS — onboarding meets the one-click smooth standard');
      }
      console.log('');

      // Hard assertion: the gate must pass all criteria
      // INTENTIONALLY FAILING: This test is designed to fail until delta work is done.
      // When all deltas from STA-157 are implemented, this test will pass.
      assert.equal(failCount, 0,
        `Onboarding acceptance gate: ${failCount} criteria failed. ` +
        `Failures: ${verdicts.filter(v => !v.pass).map(v => v.name).join('; ')}`
      );

    } finally {
      srvExisting.close();
      srvNew.close();
    }
  });

  it('verifies fresh node can receive yield without building local corpus first', async () => {
    // This test validates that a brand-new node with ZERO local reports
    // can still receive yield from a trusted peer (provisional stage).
    // If this fails, it means the current system blocks new users
    // from getting value until they create their own reports — a major friction wall.

    const keysA = generateKeypair();
    const keysB = generateKeypair();
    const dbA = makeDb();  // existing node with yield
    const dbB = makeDb();  // brand new node, zero reports

    seedVerifiedReports(dbA, 'seed-node', 5);

    const appA = createApp({
      config: { node_id: 'seed-node', node_url: 'http://127.0.0.1:37230', operator_name: 'seed', port: 37230 },
      db: dbA,
      publicKeyHex: keysA.publicKey,
      privateKeyHex: keysA.privateKey,
      createdAt: new Date().toISOString(),
    });
    const appB = createApp({
      config: { node_id: 'empty-node', node_url: 'http://127.0.0.1:37231', operator_name: 'newbie', port: 37231 },
      db: dbB,
      publicKeyHex: keysB.publicKey,
      privateKeyHex: keysB.privateKey,
      createdAt: new Date().toISOString(),
    });

    const srvA = await startServer(appA, 37230);
    const srvB = await startServer(appB, 37231);

    try {
      const fpA = computeFingerprint(keysA.publicKey);
      const fpB = computeFingerprint(keysB.publicKey);

      // Mutual introduction
      await httpFetch('http://127.0.0.1:37230/myr/peer/introduce', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identity_document: {
            protocol_version: '1.0.0', public_key: keysB.publicKey,
            fingerprint: fpB, operator_name: 'newbie',
            node_url: 'http://127.0.0.1:37231',
            capabilities: ['report-sync'],
            created_at: new Date().toISOString(),
          },
        }),
      });
      await httpFetch('http://127.0.0.1:37231/myr/peer/introduce', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identity_document: {
            protocol_version: '1.0.0', public_key: keysA.publicKey,
            fingerprint: fpA, operator_name: 'seed',
            node_url: 'http://127.0.0.1:37230',
            capabilities: ['report-sync'],
            created_at: new Date().toISOString(),
          },
        }),
      });

      // Mutual approval
      await signedFetch('http://127.0.0.1:37230/myr/peer/approve', {
        method: 'POST', body: { peer_fingerprint: fpB, trust_level: 'trusted' }, keys: keysA,
      });
      await signedFetch('http://127.0.0.1:37231/myr/peer/approve', {
        method: 'POST', body: { peer_fingerprint: fpA, trust_level: 'trusted' }, keys: keysB,
      });

      // New node (zero reports) tries to pull from seed node
      const peerRecord = dbB.prepare('SELECT * FROM myr_peers WHERE public_key = ?')
        .get(keysA.publicKey);

      const syncResult = await syncPeer({
        db: dbB,
        peer: { ...peerRecord, peer_url: 'http://127.0.0.1:37230' },
        keys: keysB,
        fetch: httpFetch,
      });

      const received = dbB.prepare('SELECT COUNT(*) as cnt FROM myr_reports').get().cnt;

      assert.ok(received > 0,
        `Fresh node with zero local reports should receive yield. Got ${received} reports. ` +
        'If this fails, the system requires local content creation before a new user ' +
        'can receive any value — the single biggest friction wall in onboarding.');

      console.log(`  ✓ Fresh node received ${received} reports with zero local corpus`);

    } finally {
      srvA.close();
      srvB.close();
    }
  });

  it('counts exact user actions in current onboarding path', () => {
    // Static analysis: count every point where the user must act.
    // This is the ground truth for "how many things does a human have to do?"

    const actions = [
      { action: 'Install Node.js', type: 'prerequisite', avoidable: false },
      { action: 'Clone repo / npm install', type: 'install', avoidable: true,
        fix: 'Publish to npm with bin entry' },
      { action: 'Run myr setup', type: 'setup', avoidable: false },
      { action: 'Choose tunnel provider (cloudflare/tailscale/manual)', type: 'infra',
        avoidable: true, fix: 'Auto-detect best method' },
      { action: 'Authenticate with Cloudflare (browser) OR set CLOUDFLARE_TUNNEL_TOKEN',
        type: 'infra', avoidable: true, fix: 'Managed relay fallback' },
      { action: 'Obtain peer URL/fingerprint out-of-band', type: 'coordination',
        avoidable: true, fix: 'Invite links' },
      { action: 'Run myr peer add --url <url>', type: 'peer', avoidable: true,
        fix: 'myr invite accept <token>' },
      { action: 'Run myr peer approve <fingerprint>', type: 'ceremony',
        avoidable: true, fix: 'Auto-approve on mutual introduction' },
      { action: 'Wait for peer to also approve', type: 'coordination',
        avoidable: true, fix: 'Auto-approve on mutual introduction' },
      { action: 'Create ≥10 MYR reports before first exchange', type: 'content',
        avoidable: true, fix: 'Lower provisional threshold + seeding wizard' },
      { action: 'Run myr sync --peer <fp> manually', type: 'sync',
        avoidable: true, fix: 'Background auto-sync scheduler' },
    ];

    const avoidableActions = actions.filter(a => a.avoidable);
    const unavoidableActions = actions.filter(a => !a.avoidable);

    console.log('\n  ── CURRENT USER ACTION INVENTORY ──\n');
    console.log(`  Total actions required:     ${actions.length}`);
    console.log(`  Unavoidable (target path):  ${unavoidableActions.length}`);
    console.log(`  Avoidable (delta work):     ${avoidableActions.length}\n`);

    for (const a of actions) {
      const status = a.avoidable ? `AVOIDABLE → ${a.fix}` : 'KEEP';
      console.log(`  [${a.type.padEnd(13)}] ${a.action}`);
      console.log(`                ${status}`);
    }

    console.log(`\n  Target user actions after all deltas: ${unavoidableActions.length}`);
    console.log(`  Acceptance threshold:                 ≤ ${ACCEPTANCE.maxUserActions + 1}`);
    // +1 for "install Node.js" which is a prerequisite, not counted against the standard

    // The acceptance standard allows 1 user action (invite accept) + 1 prerequisite (Node.js)
    // Currently there are many more. This documents the gap.
    assert.ok(avoidableActions.length > 0,
      'Sanity check: there should be avoidable actions to document');
    console.log(`\n  ${avoidableActions.length} actions can be eliminated by delta work\n`);
  });
});
