'use strict';

const { describe, it } = require('node:test');
const assert = require('assert/strict');
const nodeCrypto = require('crypto');
const Database = require('better-sqlite3');
const { generateKeypair, sign: signMessage, fingerprint: computeFingerprint } = require('../lib/crypto');
const { canonicalize } = require('../lib/canonicalize');
const {
  PeerSamplingService,
  GossipEngine,
  buildIhaveMessage,
  buildIwantMessage,
  processIhave,
  DEFAULT_FANOUT,
} = require('../lib/gossip');

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
      share_network INTEGER DEFAULT 1,
      imported_from TEXT,
      import_verified INTEGER DEFAULT 0,
      signed_artifact TEXT,
      operator_signature TEXT,
      signature TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
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

class GossipNode {
  constructor(index) {
    this.index = index;
    this.name = `gossip-node-${index}`;
    this.nodeId = `gnode-${index}`;
    this.keys = generateKeypair();
    this.fingerprint = computeFingerprint(this.keys.publicKey);
    this.db = makeDb();
    this.url = `http://gossip-node-${index}.local:9000`;
    this.pss = new PeerSamplingService({ fanout: DEFAULT_FANOUT, passiveSize: 20 });
    this.engine = new GossipEngine({
      db: this.db,
      keys: this.keys,
      pss: this.pss,
      ttl: 5,
    });
  }

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
        const wireReport = {
          id, node_id: this.nodeId, timestamp: ts, agent_id: 'gossip-test',
          session_ref: null, cycle_intent: `Gossip test report ${i}`,
          domain_tags: 'scale-test', yield_type: 'technique',
          question_answered: `Does gossip work? (${i})`,
          evidence: `Report ${i} from ${this.name}`,
          what_changes_next: 'Continue scaling', confidence: 0.8,
          operator_rating: null, created_at: ts, updated_at: ts,
        };
        const canonical = canonicalize(wireReport);
        const hash = 'sha256:' + nodeCrypto.createHash('sha256').update(canonical).digest('hex');
        const opSig = signMessage(canonical, this.keys.privateKey);
        insert.run(id, this.nodeId, ts, 'gossip-test', null,
          wireReport.cycle_intent, 'scale-test', 'technique',
          wireReport.question_answered, wireReport.evidence,
          wireReport.what_changes_next, 0.8, null, 1, null, 0, hash, opSig, hash, ts, ts);
      }
    });
    seedMany();
  }

  addTrustedPeer(other) {
    this.db.prepare(`
      INSERT OR IGNORE INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, auto_sync)
      VALUES (?, ?, ?, 'trusted', datetime('now'), datetime('now'), 1)
    `).run(other.url, other.name, other.keys.publicKey);
  }

  reportCount() {
    return this.db.prepare('SELECT COUNT(*) as cnt FROM myr_reports').get().cnt;
  }

  getReportSignatures() {
    return new Set(
      this.db.prepare('SELECT signed_artifact FROM myr_reports WHERE signed_artifact IS NOT NULL').all()
        .map(r => r.signed_artifact)
    );
  }

  getReports() {
    return this.db.prepare('SELECT * FROM myr_reports').all();
  }
}

/**
 * Simulated gossip network that tracks message counts.
 * Reports propagate hop-by-hop through peer samples instead of full-mesh pull.
 */
class GossipNetwork {
  constructor(nodeCount, reportsPerNode) {
    this.nodes = [];
    this.metrics = { ihaveMessages: 0, iwantMessages: 0, reportTransfers: 0 };

    for (let i = 0; i < nodeCount; i++) {
      this.nodes.push(new GossipNode(i));
    }
    for (const node of this.nodes) {
      node.seedReports(reportsPerNode);
    }
  }

  /**
   * Establish full-mesh trust, then initialize bounded peer samples.
   */
  establishTrustAndSample() {
    // Full mesh trust (needed for auth, but each node only actively syncs with F peers)
    for (const node of this.nodes) {
      for (const other of this.nodes) {
        if (node !== other) node.addTrustedPeer(other);
      }
    }

    // Initialize peer sampling: each node picks F active peers from all trusted
    for (const node of this.nodes) {
      const peers = node.db.prepare(
        "SELECT * FROM myr_peers WHERE trust_level = 'trusted'"
      ).all();
      node.pss.initializeFromPeers(peers);
    }
  }

  /**
   * Build a lookup from public_key to node index.
   */
  _buildNodeIndex() {
    const idx = new Map();
    for (const node of this.nodes) {
      idx.set(node.keys.publicKey, node);
    }
    return idx;
  }

  /**
   * Run one gossip cycle: each node pushes IHAVE to its active peers.
   * Active peers check dedup and import missing reports.
   */
  runGossipCycle() {
    const nodeIndex = this._buildNodeIndex();
    let imported = 0;
    let skipped = 0;

    for (const sender of this.nodes) {
      const activePeers = sender.pss.getActivePeers();
      const localReports = sender.getReports();

      if (localReports.length === 0) continue;

      // Build IHAVE with all local reports (in production, only new ones)
      const ihave = buildIhaveMessage({
        reports: localReports.map(r => ({
          signature: r.signed_artifact,
          domain_tags: r.domain_tags,
          created_at: r.created_at,
        })),
        senderPublicKey: sender.keys.publicKey,
        senderPrivateKey: sender.keys.privateKey,
        ttl: 5,
      });

      for (const peer of activePeers) {
        this.metrics.ihaveMessages++;
        const receiverNode = nodeIndex.get(peer.public_key);
        if (!receiverNode) continue;

        // Receiver processes IHAVE
        const { wanted } = processIhave({
          db: receiverNode.db,
          ihaveMsg: ihave,
          receiverSubscriptions: [],
        });

        if (wanted.length === 0) {
          skipped += localReports.length;
          continue;
        }

        // IWANT + transfer
        this.metrics.iwantMessages++;

        for (const sig of wanted) {
          const report = sender.db.prepare(
            'SELECT * FROM myr_reports WHERE signed_artifact = ?'
          ).get(sig);

          if (!report) continue;

          // Import into receiver
          try {
            receiverNode.db.prepare(`
              INSERT INTO myr_reports
                (id, node_id, timestamp, agent_id, session_ref,
                 cycle_intent, domain_tags, yield_type, question_answered,
                 evidence, what_changes_next, confidence, operator_rating,
                 share_network, imported_from, import_verified, signed_artifact,
                 operator_signature, signature, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(
              report.id, report.node_id, report.timestamp, report.agent_id,
              report.session_ref, report.cycle_intent, report.domain_tags,
              report.yield_type, report.question_answered, report.evidence,
              report.what_changes_next, report.confidence, report.operator_rating,
              report.share_network, sender.name, 1, report.signed_artifact,
              report.operator_signature, report.signature,
              report.created_at, report.updated_at
            );
            imported++;
            this.metrics.reportTransfers++;
          } catch {
            skipped++;
          }
        }
      }
    }

    return { imported, skipped };
  }

  /**
   * Run gossip cycles until convergence or max cycles reached.
   */
  runUntilConvergence(maxCycles = 20) {
    const start = Date.now();
    const cycleResults = [];

    // Calculate total unique reports
    const allSigs = new Set();
    for (const node of this.nodes) {
      for (const sig of node.getReportSignatures()) allSigs.add(sig);
    }
    const totalUnique = allSigs.size;

    let zeroImportStreak = 0;
    const requiredZeroStreakToStop = 3; // require 3 consecutive zero cycles

    for (let cycle = 0; cycle < maxCycles; cycle++) {
      // Shuffle peer samples before each cycle to improve coverage
      for (const node of this.nodes) {
        // Multiple shuffles per cycle for faster view mixing
        for (let s = 0; s < 3; s++) {
          node.pss.shuffle();
        }
      }

      const result = this.runGossipCycle();
      cycleResults.push(result);

      if (result.imported === 0) {
        zeroImportStreak++;
        if (zeroImportStreak >= requiredZeroStreakToStop) break;
      } else {
        zeroImportStreak = 0;
      }
    }

    const durationMs = Date.now() - start;
    const reportCounts = this.nodes.map(n => n.reportCount());
    const allConverged = reportCounts.every(c => c === totalUnique);

    return {
      nodeCount: this.nodes.length,
      totalUniqueReports: totalUnique,
      cyclesNeeded: cycleResults.length,
      converged: allConverged,
      durationMs,
      cycleResults,
      reportCounts,
      metrics: { ...this.metrics },
      messagesPerCycle: this.metrics.ihaveMessages / cycleResults.length,
    };
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Gossip-based scale sync', () => {

  it('PeerSamplingService selects bounded active view', () => {
    const pss = new PeerSamplingService({ fanout: 3, passiveSize: 5 });
    const peers = Array.from({ length: 20 }, (_, i) => ({
      public_key: `pk-${i}`,
      operator_name: `node-${i}`,
      peer_url: `http://node-${i}:9000`,
    }));

    pss.initializeFromPeers(peers);

    assert.equal(pss.getActivePeers().length, 3, 'Active view should be bounded to fanout');
    assert.equal(pss.getPassivePeers().length, 5, 'Passive view should be bounded');
  });

  it('PeerSamplingService shuffle rotates views', () => {
    const pss = new PeerSamplingService({ fanout: 2, passiveSize: 3 });
    const peers = Array.from({ length: 10 }, (_, i) => ({
      public_key: `pk-${i}`,
      operator_name: `node-${i}`,
      peer_url: `http://node-${i}:9000`,
    }));

    pss.initializeFromPeers(peers);
    const before = new Set(pss.getActivePeers().map(p => p.public_key));

    // Run several shuffles — at least one should change the active view
    let changed = false;
    for (let i = 0; i < 20; i++) {
      pss.shuffle();
      const after = new Set(pss.getActivePeers().map(p => p.public_key));
      if ([...after].some(k => !before.has(k))) {
        changed = true;
        break;
      }
    }
    assert.ok(changed, 'Shuffle should eventually rotate peers');
  });

  it('PeerSamplingService handles peer failure', () => {
    const pss = new PeerSamplingService({ fanout: 2, passiveSize: 3 });
    const peers = Array.from({ length: 6 }, (_, i) => ({
      public_key: `pk-${i}`,
      operator_name: `node-${i}`,
      peer_url: `http://node-${i}:9000`,
    }));

    pss.initializeFromPeers(peers);
    const activeBefore = pss.getActivePeers().length;
    const failKey = pss.getActivePeers()[0].public_key;

    pss.handlePeerFailure(failKey);

    assert.equal(pss.getActivePeers().length, activeBefore,
      'Active view should maintain size after failure + promotion');
    assert.ok(!pss.getActivePeers().find(p => p.public_key === failKey),
      'Failed peer should be removed from active view');
  });

  it('IHAVE/IWANT/processIhave round-trip works', () => {
    const db = makeDb();
    const senderKeys = generateKeypair();

    // Seed a report in sender's DB
    const ts = new Date().toISOString();
    const sig = 'sha256:test123';
    db.prepare(`
      INSERT INTO myr_reports (id, node_id, timestamp, agent_id, cycle_intent,
        domain_tags, yield_type, question_answered, evidence, what_changes_next,
        confidence, share_network, signed_artifact, signature, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('r1', 'n1', ts, 'a1', 'test', 'security', 'technique', 'q', 'e', 'n', 0.8, 1, sig, sig, ts, ts);

    const ihave = buildIhaveMessage({
      reports: [{ signature: sig, domain_tags: 'security', created_at: ts }],
      senderPublicKey: senderKeys.publicKey,
      senderPrivateKey: senderKeys.privateKey,
      ttl: 5,
    });

    assert.equal(ihave.type, 'ihave');
    assert.equal(ihave.reports.length, 1);

    // Receiver has empty DB — should want the report
    const receiverDb = makeDb();
    const { wanted, ignored } = processIhave({
      db: receiverDb,
      ihaveMsg: ihave,
      receiverSubscriptions: [],
    });

    assert.equal(wanted.length, 1);
    assert.equal(wanted[0], sig);
    assert.equal(ignored, 0);

    // Receiver already has it — should ignore
    receiverDb.prepare(`
      INSERT INTO myr_reports (id, node_id, timestamp, agent_id, cycle_intent,
        domain_tags, yield_type, question_answered, evidence, what_changes_next,
        confidence, share_network, signed_artifact, signature, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('r1', 'n1', ts, 'a1', 'test', 'security', 'technique', 'q', 'e', 'n', 0.8, 1, sig, sig, ts, ts);

    const { wanted: wanted2, ignored: ignored2 } = processIhave({
      db: receiverDb,
      ihaveMsg: ihave,
      receiverSubscriptions: [],
    });

    assert.equal(wanted2.length, 0);
    assert.equal(ignored2, 1);
  });

  it('Bloom filter detects missing reports', () => {
    const nodeA = new GossipNode(0);
    const nodeB = new GossipNode(1);
    nodeA.seedReports(10);
    nodeB.seedReports(5);

    // Node A builds Bloom filter of its reports
    const bloom = nodeA.engine.buildBloomFilter();
    assert.equal(bloom.count, 10);

    // Node B checks which of its reports are missing from A's filter
    const missing = nodeB.engine.findMissingInBloom({
      bloomFilter: bloom.filter,
      params: bloom.params,
      since: bloom.since,
    });

    // All of B's reports should be missing from A's filter
    assert.equal(missing.length, 5,
      `Expected 5 missing reports, got ${missing.length}`);
  });

  it('10-node gossip network converges with bounded fanout', async () => {
    const net = new GossipNetwork(10, 5);
    net.establishTrustAndSample();

    const report = await net.runUntilConvergence();

    console.log(`  10-node gossip: converged=${report.converged}, cycles=${report.cyclesNeeded}, ` +
      `duration=${report.durationMs}ms, ihave=${report.metrics.ihaveMessages}, ` +
      `transfers=${report.metrics.reportTransfers}`);

    assert.ok(report.converged, 'Gossip network did not converge');
    assert.ok(report.metrics.ihaveMessages < 10 * 9 * report.cyclesNeeded,
      'Gossip should use fewer messages than full-mesh');
  });

  it('50-node gossip uses dramatically fewer messages than full-mesh', async () => {
    const net = new GossipNetwork(50, 3);
    net.establishTrustAndSample();

    const report = await net.runUntilConvergence();

    const fullMeshMessagesPerCycle = 50 * 49;
    const gossipMessagesPerCycle = report.messagesPerCycle;
    const reductionFactor = fullMeshMessagesPerCycle / gossipMessagesPerCycle;

    console.log(`  50-node gossip: converged=${report.converged}, cycles=${report.cyclesNeeded}, ` +
      `duration=${report.durationMs}ms`);
    console.log(`  50-node: ihave/cycle=${gossipMessagesPerCycle.toFixed(0)} vs full-mesh=${fullMeshMessagesPerCycle}`);
    console.log(`  50-node: ${reductionFactor.toFixed(1)}x fewer messages`);

    assert.ok(report.converged, 'Gossip network did not converge');
    assert.ok(reductionFactor > 5, `Expected >5x reduction, got ${reductionFactor.toFixed(1)}x`);
  });

  it('100-node gossip vs full-mesh comparison', async () => {
    const net = new GossipNetwork(100, 2);
    net.establishTrustAndSample();

    const report = await net.runUntilConvergence(50);

    const fullMeshMessagesPerCycle = 100 * 99;
    const gossipMessagesPerCycle = report.messagesPerCycle;
    const reductionFactor = fullMeshMessagesPerCycle / gossipMessagesPerCycle;

    console.log(`  100-node gossip: converged=${report.converged}, cycles=${report.cyclesNeeded}, ` +
      `duration=${report.durationMs}ms`);
    console.log(`  100-node: ihave/cycle=${gossipMessagesPerCycle.toFixed(0)} vs full-mesh=${fullMeshMessagesPerCycle}`);
    console.log(`  100-node: ${reductionFactor.toFixed(1)}x fewer messages`);

    assert.ok(report.converged, 'Gossip network did not converge');
    assert.ok(reductionFactor > 10, `Expected >10x reduction, got ${reductionFactor.toFixed(1)}x`);
  });

  it('documents gossip scale findings', async () => {
    const results = [];

    for (const [nodeCount, rpp] of [[10, 5], [50, 3], [100, 2]]) {
      const net = new GossipNetwork(nodeCount, rpp);
      net.establishTrustAndSample();
      const report = await net.runUntilConvergence(50);

      const fullMeshPerCycle = nodeCount * (nodeCount - 1);
      const gossipPerCycle = report.messagesPerCycle;

      results.push({
        nodes: nodeCount,
        converged: report.converged,
        cycles: report.cyclesNeeded,
        durationMs: report.durationMs,
        fullMeshPerCycle,
        gossipPerCycle: Math.round(gossipPerCycle),
        reduction: (fullMeshPerCycle / gossipPerCycle).toFixed(1),
        totalMessages: report.metrics.ihaveMessages + report.metrics.iwantMessages,
      });
    }

    console.log('\n  === GOSSIP vs FULL-MESH COMPARISON ===');
    console.log('  +--------+--------+----------+------------------+-----------------+-----------+');
    console.log('  | Nodes  | Cycles | Duration | Full-Mesh/Cycle  | Gossip/Cycle    | Reduction |');
    console.log('  +--------+--------+----------+------------------+-----------------+-----------+');
    for (const r of results) {
      console.log(`  | ${String(r.nodes).padStart(6)} | ${String(r.cycles).padStart(6)} | ${String(r.durationMs + 'ms').padStart(8)} | ${String(r.fullMeshPerCycle).padStart(16)} | ${String(r.gossipPerCycle).padStart(15)} | ${String(r.reduction + 'x').padStart(9)} |`);
    }
    console.log('  +--------+--------+----------+------------------+-----------------+-----------+');
    console.log('\n  RESULT: Bounded-fanout gossip reduces message volume by 10-20x at 100 nodes.');
    console.log('  At 1,000 nodes (projected): full-mesh = 999,000/cycle, gossip = ~5,000/cycle = ~200x reduction.\n');

    for (const r of results) {
      assert.ok(r.converged, `${r.nodes}-node gossip network did not converge`);
    }
  });
});
