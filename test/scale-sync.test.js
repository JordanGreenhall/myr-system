'use strict';

const { describe, it } = require('node:test');
const assert = require('assert/strict');
const nodeCrypto = require('crypto');
const Database = require('better-sqlite3');
const { generateKeypair, sign: signMessage, verify, fingerprint: computeFingerprint } = require('../lib/crypto');
const { syncPeer, makeSignedHeaders } = require('../lib/sync');
const { canonicalize } = require('../lib/canonicalize');

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a minimal in-memory DB with the tables syncPeer needs.
 * Uses the integration-test schema (wider than canonical schema.sql)
 * to match what syncPeer's INSERT expects.
 */
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

/**
 * A simulated MYR node: keypair, DB, and generated reports.
 */
class SimulatedNode {
  constructor(index) {
    this.index = index;
    this.name = `node-${index}`;
    this.nodeId = `scale-node-${index}`;
    this.keys = generateKeypair();
    this.fingerprint = computeFingerprint(this.keys.publicKey);
    this.db = makeDb();
    // Virtual URL — never actually resolved over HTTP
    this.url = `http://sim-node-${index}.local:9000`;
  }

  /**
   * Seed N signed reports into this node's DB.
   *
   * The hash (signature) is computed from the exact fields that syncPeer
   * will see via the mock fetch response (minus signature/operator_signature),
   * so hash verification passes during sync.
   */
  seedReports(count) {
    const now = new Date();
    const insert = this.db.prepare(`
      INSERT INTO myr_reports
        (id, node_id, timestamp, agent_id, session_ref,
         cycle_intent, domain_tags, yield_type, question_answered,
         evidence, what_changes_next, confidence, operator_rating,
         share_network, imported_from, import_verified, signed_artifact,
         operator_signature, signature, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    const seedMany = this.db.transaction(() => {
      for (let i = 0; i < count; i++) {
        const ts = new Date(now.getTime() + i * 1000).toISOString();
        const id = `${this.nodeId}-${ts}-${i}`;

        // This is the exact object that the mock fetch will return
        // (and that syncPeer will hash after stripping signature/operator_signature).
        const wireReport = {
          id,
          node_id: this.nodeId,
          timestamp: ts,
          agent_id: 'scale-test',
          session_ref: null,
          cycle_intent: `Scale test report ${i}`,
          domain_tags: 'scale-test',
          yield_type: 'technique',
          question_answered: `Does sync work at scale? (${i})`,
          evidence: `Report ${i} from ${this.name}`,
          what_changes_next: 'Continue scaling',
          confidence: 0.8,
          operator_rating: null,
          created_at: ts,
          updated_at: ts,
        };

        const canonical = canonicalize(wireReport);
        const hash = 'sha256:' + nodeCrypto.createHash('sha256').update(canonical).digest('hex');
        const opSig = signMessage(canonical, this.keys.privateKey);

        insert.run(
          id, this.nodeId, ts, 'scale-test', null,
          wireReport.cycle_intent, 'scale-test', 'technique', wireReport.question_answered,
          wireReport.evidence, wireReport.what_changes_next, 0.8, null,
          1, null, 0, hash,
          opSig, hash, ts, ts
        );
      }
    });
    seedMany();
  }

  /** Register another node as a trusted peer. */
  addTrustedPeer(other) {
    this.db.prepare(`
      INSERT OR IGNORE INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, auto_sync)
      VALUES (?, ?, ?, 'trusted', datetime('now'), datetime('now'), 1)
    `).run(other.url, other.name, other.keys.publicKey);
  }

  /** Count local reports. */
  reportCount() {
    return this.db.prepare('SELECT COUNT(*) as cnt FROM myr_reports').get().cnt;
  }

  /** Get all report IDs. */
  reportIds() {
    return new Set(this.db.prepare('SELECT id FROM myr_reports').all().map(r => r.id));
  }
}

/**
 * A simulated network of N nodes with in-memory fetch routing.
 *
 * Instead of real HTTP, the mock fetch intercepts requests to each node's
 * virtual URL and responds by querying that node's DB directly — replicating
 * the server's /myr/reports and /myr/reports/:sig endpoints.
 */
class SimulatedNetwork {
  constructor(nodeCount, reportsPerNode) {
    this.nodes = [];
    this.metrics = {
      fetchCalls: 0,
      listRequests: 0,
      reportFetches: 0,
      totalBytesSim: 0,
    };

    // Create nodes
    for (let i = 0; i < nodeCount; i++) {
      this.nodes.push(new SimulatedNode(i));
    }

    // Seed reports
    for (const node of this.nodes) {
      node.seedReports(reportsPerNode);
    }

    // Build URL → node index for routing
    this._urlMap = new Map();
    for (const node of this.nodes) {
      this._urlMap.set(node.url, node);
    }
  }

  /**
   * Establish full-mesh trust: every node trusts every other node.
   */
  establishFullMeshTrust() {
    for (const node of this.nodes) {
      for (const other of this.nodes) {
        if (node !== other) {
          node.addTrustedPeer(other);
        }
      }
    }
  }

  /**
   * Create a mock fetch function that routes to the correct simulated node.
   * Replicates the MYR server's GET /myr/reports and GET /myr/reports/:sig.
   */
  createMockFetch() {
    const network = this;

    return async function mockFetch(url, options = {}) {
      network.metrics.fetchCalls++;

      const parsed = new URL(url);
      // Reconstruct base URL
      const baseUrl = `${parsed.protocol}//${parsed.host}`;
      const targetNode = network._urlMap.get(baseUrl);

      if (!targetNode) {
        return { status: 502, body: { error: 'Node not found in simulation' }, rawBody: '{}', headers: {} };
      }

      const path = parsed.pathname;
      const searchParams = parsed.searchParams;

      // Verify request has auth headers (simulate auth middleware)
      const pubKey = (options.headers || {})['x-myr-public-key'];
      if (!pubKey) {
        return { status: 401, body: { error: { code: 'auth_required' } }, rawBody: '{}', headers: {} };
      }

      // Check peer trust
      const peer = targetNode.db.prepare(
        'SELECT * FROM myr_peers WHERE public_key = ? AND trust_level = ?'
      ).get(pubKey, 'trusted');
      if (!peer) {
        return { status: 403, body: { error: { code: 'peer_not_trusted' } }, rawBody: '{}', headers: {} };
      }

      // GET /myr/reports — list reports
      if (path === '/myr/reports' && !path.includes('/myr/reports/')) {
        network.metrics.listRequests++;
        const since = searchParams.get('since');
        const limit = parseInt(searchParams.get('limit') || '500', 10);

        let rows;
        if (since) {
          rows = targetNode.db.prepare(
            'SELECT id, signature, created_at FROM myr_reports WHERE share_network = 1 AND created_at > ? ORDER BY created_at ASC LIMIT ?'
          ).all(since, limit);
        } else {
          rows = targetNode.db.prepare(
            'SELECT id, signature, created_at FROM myr_reports WHERE share_network = 1 ORDER BY created_at ASC LIMIT ?'
          ).all(limit);
        }

        const reports = rows.map(r => ({
          signature: r.signature,
          url: `/myr/reports/${encodeURIComponent(r.signature)}`,
          created_at: r.created_at,
        }));

        const body = { reports, total: reports.length };
        const rawBody = JSON.stringify(body);
        network.metrics.totalBytesSim += rawBody.length;
        return { status: 200, body, rawBody, headers: {} };
      }

      // GET /myr/reports/:signature — fetch single report
      if (path.startsWith('/myr/reports/')) {
        network.metrics.reportFetches++;
        const sig = decodeURIComponent(path.replace('/myr/reports/', ''));
        const row = targetNode.db.prepare(
          'SELECT * FROM myr_reports WHERE signature = ? AND share_network = 1'
        ).get(sig);

        if (!row) {
          return { status: 404, body: { error: 'not_found' }, rawBody: '{}', headers: {} };
        }

        const body = {
          id: row.id,
          node_id: row.node_id,
          timestamp: row.timestamp,
          agent_id: row.agent_id,
          session_ref: row.session_ref,
          cycle_intent: row.cycle_intent,
          domain_tags: row.domain_tags,
          yield_type: row.yield_type,
          question_answered: row.question_answered,
          evidence: row.evidence,
          what_changes_next: row.what_changes_next,
          confidence: row.confidence,
          operator_rating: row.operator_rating,
          created_at: row.created_at,
          updated_at: row.updated_at,
          signature: row.signature,
          operator_signature: row.operator_signature,
        };
        const rawBody = JSON.stringify(body);
        network.metrics.totalBytesSim += rawBody.length;
        return { status: 200, body, rawBody, headers: {} };
      }

      return { status: 404, body: { error: 'unknown_path' }, rawBody: '{}', headers: {} };
    };
  }

  /**
   * Run one full sync cycle: every node pulls from every peer.
   * Returns per-cycle metrics.
   */
  async runSyncCycle(mockFetch) {
    const cycleStart = Date.now();
    let totalImported = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    for (const node of this.nodes) {
      const peers = node.db.prepare(
        "SELECT * FROM myr_peers WHERE trust_level = 'trusted' AND auto_sync = 1"
      ).all();

      for (const peer of peers) {
        const result = await syncPeer({
          db: node.db,
          peer,
          keys: node.keys,
          fetch: mockFetch,
        });
        totalImported += result.imported;
        totalSkipped += result.skipped;
        totalFailed += result.failed;
      }
    }

    return {
      durationMs: Date.now() - cycleStart,
      imported: totalImported,
      skipped: totalSkipped,
      failed: totalFailed,
    };
  }

  /**
   * Run sync cycles until convergence (no new imports) or max cycles reached.
   * Returns full convergence report.
   */
  async runUntilConvergence(maxCycles = 10) {
    const mockFetch = this.createMockFetch();
    const cycleResults = [];
    const overallStart = Date.now();

    // Calculate expected total: collect all unique report IDs across all nodes
    const allIds = new Set();
    for (const node of this.nodes) {
      for (const id of node.reportIds()) allIds.add(id);
    }
    const totalUniqueReports = allIds.size;
    const reportsPerNode = this.nodes.length > 0 ? this.nodes[0].reportCount() : 0;

    for (let cycle = 0; cycle < maxCycles; cycle++) {
      const result = await this.runSyncCycle(mockFetch);
      cycleResults.push(result);

      // Check convergence: did we import anything?
      if (result.imported === 0) {
        break;
      }
    }

    const overallDurationMs = Date.now() - overallStart;

    // Verify convergence: every node should have the same report count
    const reportCounts = this.nodes.map(n => n.reportCount());
    const allConverged = reportCounts.every(c => c === totalUniqueReports);

    // Deduplication accuracy: check that no node has more reports than expected
    const maxReports = Math.max(...reportCounts);
    const dedupAccurate = maxReports <= totalUniqueReports;

    return {
      nodeCount: this.nodes.length,
      reportsPerNode,
      totalUniqueReports,
      cyclesNeeded: cycleResults.length,
      converged: allConverged,
      dedupAccurate,
      overallDurationMs,
      cycleResults,
      reportCounts,
      networkMetrics: { ...this.metrics },
      // Bottleneck indicators
      totalListRequests: this.metrics.listRequests,
      totalReportFetches: this.metrics.reportFetches,
      totalFetchCalls: this.metrics.fetchCalls,
      avgFetchesPerCycle: this.metrics.fetchCalls / cycleResults.length,
      messagesPerNodePerCycle: (this.metrics.fetchCalls / cycleResults.length) / this.nodes.length,
    };
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Scale sync protocol', () => {

  it('10-node network converges in a single sync cycle', async () => {
    const net = new SimulatedNetwork(10, 5);  // 10 nodes, 5 reports each
    net.establishFullMeshTrust();

    const report = await net.runUntilConvergence();

    console.log(`  10-node: converged=${report.converged}, cycles=${report.cyclesNeeded}, ` +
      `duration=${report.overallDurationMs}ms, fetches=${report.totalFetchCalls}, ` +
      `listReqs=${report.totalListRequests}, reportFetches=${report.totalReportFetches}`);

    assert.ok(report.converged, 'Network did not converge');
    assert.ok(report.dedupAccurate, 'Deduplication inaccurate — nodes have too many reports');
    assert.equal(report.cyclesNeeded, 2, 'Full-mesh pull should converge in 1 cycle + 1 verification cycle');

    // In full-mesh, each node pulls from 9 peers, so list requests = 10 * 9 = 90 per cycle
    assert.equal(report.totalListRequests, 10 * 9 * 2, 'Unexpected list request count');

    // Every node should have all 50 reports
    for (const count of report.reportCounts) {
      assert.equal(count, 50, `Expected 50 reports, got ${count}`);
    }
  });

  it('50-node network converges with correct deduplication', async () => {
    const net = new SimulatedNetwork(50, 3);  // 50 nodes, 3 reports each
    net.establishFullMeshTrust();

    const report = await net.runUntilConvergence();

    console.log(`  50-node: converged=${report.converged}, cycles=${report.cyclesNeeded}, ` +
      `duration=${report.overallDurationMs}ms, fetches=${report.totalFetchCalls}, ` +
      `listReqs=${report.totalListRequests}, reportFetches=${report.totalReportFetches}`);

    assert.ok(report.converged, 'Network did not converge');
    assert.ok(report.dedupAccurate, 'Deduplication inaccurate');

    // Full-mesh pull: every node reaches every other node in 1 cycle
    assert.equal(report.cyclesNeeded, 2, 'Full-mesh should converge in 1 cycle + 1 verify');

    // Every node should have all 150 reports
    for (const count of report.reportCounts) {
      assert.equal(count, 150, `Expected 150 reports, got ${count}`);
    }

    // Bottleneck analysis: message volume scales as O(N^2) per cycle
    const expectedListsPerCycle = 50 * 49;  // 2,450
    console.log(`  50-node bottleneck: ${expectedListsPerCycle} list requests per cycle (O(N^2))`);
    console.log(`  50-node: avg ${report.messagesPerNodePerCycle.toFixed(1)} fetches/node/cycle`);
  });

  it('100-node network converges within reasonable time', async () => {
    const net = new SimulatedNetwork(100, 2);  // 100 nodes, 2 reports each
    net.establishFullMeshTrust();

    const report = await net.runUntilConvergence();

    console.log(`  100-node: converged=${report.converged}, cycles=${report.cyclesNeeded}, ` +
      `duration=${report.overallDurationMs}ms, fetches=${report.totalFetchCalls}, ` +
      `listReqs=${report.totalListRequests}, reportFetches=${report.totalReportFetches}`);

    assert.ok(report.converged, 'Network did not converge');
    assert.ok(report.dedupAccurate, 'Deduplication inaccurate');

    // 100-node full-mesh: 100 * 99 = 9,900 list requests per cycle
    const expectedListsPerCycle = 100 * 99;
    console.log(`  100-node bottleneck: ${expectedListsPerCycle} list requests per cycle (O(N^2))`);
    console.log(`  100-node: avg ${report.messagesPerNodePerCycle.toFixed(1)} fetches/node/cycle`);
    console.log(`  100-node: simulated bytes transferred: ${(report.networkMetrics.totalBytesSim / 1024).toFixed(1)} KB`);

    // Every node should have all 200 reports
    for (const count of report.reportCounts) {
      assert.equal(count, 200, `Expected 200 reports, got ${count}`);
    }

    // Reasonable time: under 60 seconds (generous for CI)
    assert.ok(report.overallDurationMs < 60000,
      `Took ${report.overallDurationMs}ms — exceeds 60s threshold`);
  });

  it('deduplication: same report from multiple peers imported only once', async () => {
    // 5 nodes, 1 report each — after sync, each has exactly 5
    const net = new SimulatedNetwork(5, 1);
    net.establishFullMeshTrust();

    const report = await net.runUntilConvergence();

    assert.ok(report.converged, 'Did not converge');
    for (const count of report.reportCounts) {
      assert.equal(count, 5, `Expected 5 reports, got ${count}`);
    }

    // Cycle 2 should import 0 (last_sync_at cursor filters already-synced reports)
    if (report.cycleResults.length >= 2) {
      assert.equal(report.cycleResults[1].imported, 0, 'Second cycle should import nothing');
    }
  });

  it('convergence with asymmetric report distribution', async () => {
    // 10 nodes, but only node 0 has reports — tests fan-out
    const nodes = [];
    for (let i = 0; i < 10; i++) {
      nodes.push(new SimulatedNode(i));
    }
    // Only node 0 gets reports
    nodes[0].seedReports(20);

    // Full mesh trust
    for (const node of nodes) {
      for (const other of nodes) {
        if (node !== other) node.addTrustedPeer(other);
      }
    }

    // Build network manually
    const net = new SimulatedNetwork(0, 0);
    net.nodes = nodes;
    net._urlMap = new Map();
    for (const node of nodes) {
      net._urlMap.set(node.url, node);
    }

    const report = await net.runUntilConvergence();

    console.log(`  asymmetric: converged=${report.converged}, cycles=${report.cyclesNeeded}, ` +
      `duration=${report.overallDurationMs}ms`);

    assert.ok(report.converged, 'Asymmetric distribution did not converge');
    for (const node of nodes) {
      assert.equal(node.reportCount(), 20, `Node ${node.name} has ${node.reportCount()} reports, expected 20`);
    }
  });

  it('documents scale findings and bottleneck analysis', async () => {
    // This test generates the findings report for the issue.
    // Run 10, 50, 100 nodes and collect comparative metrics.
    const results = [];

    for (const [nodeCount, rpp] of [[10, 5], [50, 3], [100, 2]]) {
      const net = new SimulatedNetwork(nodeCount, rpp);
      net.establishFullMeshTrust();
      const report = await net.runUntilConvergence();
      results.push({
        nodes: nodeCount,
        reportsPerNode: rpp,
        totalReports: nodeCount * rpp,
        converged: report.converged,
        cycles: report.cyclesNeeded,
        durationMs: report.overallDurationMs,
        listRequests: report.totalListRequests,
        reportFetches: report.totalReportFetches,
        totalFetches: report.totalFetchCalls,
        listRequestsPerCycle: nodeCount * (nodeCount - 1),
        messagesPerNodePerCycle: report.messagesPerNodePerCycle,
      });
    }

    console.log('\n  ═══ SCALE TEST FINDINGS ═══');
    console.log('  ┌─────────┬────────┬──────────┬───────────┬──────────────────┬─────────────────────┐');
    console.log('  │  Nodes  │ Cycles │ Duration │ List Reqs │ List Reqs/Cycle  │ Fetches/Node/Cycle  │');
    console.log('  ├─────────┼────────┼──────────┼───────────┼──────────────────┼─────────────────────┤');
    for (const r of results) {
      console.log(`  │ ${String(r.nodes).padStart(7)} │ ${String(r.cycles).padStart(6)} │ ${String(r.durationMs + 'ms').padStart(8)} │ ${String(r.listRequests).padStart(9)} │ ${String(r.listRequestsPerCycle).padStart(16)} │ ${r.messagesPerNodePerCycle.toFixed(1).padStart(19)} │`);
    }
    console.log('  └─────────┴────────┴──────────┴───────────┴──────────────────┴─────────────────────┘');
    console.log('\n  BOTTLENECK: Pull-based full-mesh sync has O(N^2) message complexity per cycle.');
    console.log('  At 100 nodes: 9,900 list requests per cycle. At 1,000 nodes: ~999,000.');
    console.log('  RECOMMENDATION: For >50 nodes, consider gossip-based protocol or hierarchical sync');
    console.log('  (hub-and-spoke with regional coordinators) to reduce message volume to O(N log N).\n');

    // All must have converged
    for (const r of results) {
      assert.ok(r.converged, `${r.nodes}-node network did not converge`);
    }
  });
});
