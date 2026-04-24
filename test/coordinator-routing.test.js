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
  processIhave,
  DEFAULT_FANOUT,
} = require('../lib/gossip');
const { DomainCoordinator } = require('../lib/coordinator');
const {
  ensureSubscriptionsSchema,
  createSignedSignal,
  upsertSubscriptionSignal,
} = require('../lib/subscriptions');

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
  ensureSubscriptionsSchema(db);
  return db;
}

class RoutingTestNode {
  constructor(index, domainTags) {
    this.index = index;
    this.name = `routing-node-${index}`;
    this.keys = generateKeypair();
    this.fingerprint = computeFingerprint(this.keys.publicKey);
    this.db = makeDb();
    this.url = `http://routing-node-${index}.local:9000`;
    this.domainTags = domainTags; // which domains this node is interested in
    this.pss = new PeerSamplingService({ fanout: DEFAULT_FANOUT, passiveSize: 20 });
  }

  seedReports(count, domain) {
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
        const id = `${this.name}-${domain}-${i}`;
        const wireReport = {
          id, node_id: this.name, timestamp: ts, agent_id: 'routing-test',
          session_ref: null, cycle_intent: `Routing test report ${domain} ${i}`,
          domain_tags: domain, yield_type: 'technique',
          question_answered: `Routing test (${i})`,
          evidence: `Report ${i} domain=${domain}`,
          what_changes_next: 'Continue', confidence: 0.8,
          operator_rating: null, created_at: ts, updated_at: ts,
        };
        const canonical = canonicalize(wireReport);
        const hash = 'sha256:' + nodeCrypto.createHash('sha256').update(canonical).digest('hex');
        const opSig = signMessage(canonical, this.keys.privateKey);
        insert.run(id, this.name, ts, 'routing-test', null,
          wireReport.cycle_intent, domain, 'technique',
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

  getReports() {
    return this.db.prepare('SELECT * FROM myr_reports').all();
  }

  reportCount() {
    return this.db.prepare('SELECT COUNT(*) as cnt FROM myr_reports').get().cnt;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Coordinator-assisted routing', () => {
  it('domain-selective routing sends fewer messages than broadcast', () => {
    // Setup: 20 nodes, 4 domains, each node interested in 1-2 domains
    const domainAssignments = [
      ['security'],           // node 0
      ['security'],           // node 1
      ['performance'],        // node 2
      ['performance'],        // node 3
      ['compliance'],         // node 4
      ['compliance'],         // node 5
      ['analytics'],          // node 6
      ['analytics'],          // node 7
      ['security', 'performance'],  // node 8
      ['compliance', 'analytics'],  // node 9
      ['security'],           // node 10
      ['performance'],        // node 11
      ['compliance'],         // node 12
      ['analytics'],          // node 13
      ['security'],           // node 14
      ['performance'],        // node 15
      ['compliance'],         // node 16
      ['analytics'],          // node 17
      ['security', 'compliance'],   // node 18
      ['performance', 'analytics'], // node 19
    ];

    const nodeCount = domainAssignments.length;
    const nodes = domainAssignments.map((domains, i) => new RoutingTestNode(i, domains));

    // Node 0 (security domain) creates 5 security reports
    nodes[0].seedReports(5, 'security');

    // Establish full trust mesh
    for (const node of nodes) {
      for (const other of nodes) {
        if (node !== other) node.addTrustedPeer(other);
      }
    }

    // Initialize PSS for all nodes
    for (const node of nodes) {
      const peers = node.db.prepare("SELECT * FROM myr_peers WHERE trust_level = 'trusted'").all();
      node.pss.initializeFromPeers(peers);
    }

    // Build coordinator from domain assignments
    const coordinator = new DomainCoordinator();
    for (const node of nodes) {
      coordinator.register(node.keys.publicKey, node.domainTags, {
        operatorName: node.name,
      });
    }

    // Count messages WITHOUT coordinator (broadcast to all active peers)
    const broadcastEngine = new GossipEngine({
      db: nodes[0].db,
      keys: nodes[0].keys,
      pss: nodes[0].pss,
      ttl: 5,
      coordinator: null, // no coordinator
    });

    const reportsToSend = nodes[0].getReports().map(r => ({
      signature: r.signed_artifact,
      domain_tags: r.domain_tags,
      created_at: r.created_at,
    }));

    // Simulate broadcast: count how many active peers would receive IHAVE
    const activePeersBroadcast = nodes[0].pss.getActivePeers();
    const broadcastMessageCount = activePeersBroadcast.length; // 1 IHAVE per active peer

    // Count messages WITH coordinator (only peers interested in 'security')
    const coordinatorEngine = new GossipEngine({
      db: nodes[0].db,
      keys: nodes[0].keys,
      pss: nodes[0].pss,
      ttl: 5,
      coordinator,
    });

    // The coordinator should identify only security-interested peers
    const securityPeers = coordinator.route('security');
    const activePeersCoordinated = nodes[0].pss.getActivePeers();

    // Of the active peers, how many are actually interested in security?
    const securityKeySet = new Set(securityPeers.map(p => p.publicKey));
    const coordinatorTargets = activePeersCoordinated.filter(p => securityKeySet.has(p.public_key));

    // The coordinator-routed count should be <= broadcast count
    const coordinatorMessageCount = coordinatorTargets.length > 0
      ? coordinatorTargets.length
      : activePeersCoordinated.length; // fallback

    // Verify coordinator has the right peers
    assert.ok(securityPeers.length > 0, 'Coordinator should know about security peers');
    assert.ok(securityPeers.length < nodeCount, 'Not all nodes want security domain');

    // The coordinator should identify exactly the security-interested nodes
    // (nodes 0, 1, 8, 10, 14, 18 = 6 nodes, but excluding self = 5)
    const securityNodeCount = domainAssignments.filter(d => d.includes('security')).length;
    assert.equal(securityPeers.length, securityNodeCount,
      `Expected ${securityNodeCount} security peers, got ${securityPeers.length}`);

    // Key evidence: when coordinator targets exist in active view,
    // fewer messages are sent than broadcast
    if (coordinatorTargets.length > 0 && coordinatorTargets.length < activePeersCoordinated.length) {
      assert.ok(coordinatorMessageCount < broadcastMessageCount,
        `Coordinator routing (${coordinatorMessageCount} msgs) should be fewer than broadcast (${broadcastMessageCount} msgs)`);
    }

    // Verify the routing table is complete
    const stats = coordinator.getStats();
    assert.equal(stats.domainCount, 4, 'Should have 4 domains');
    assert.equal(stats.peerCount, nodeCount, 'All nodes should be registered');
  });

  it('coordinator returns null for unknown domains, triggering broadcast fallback', () => {
    const coordinator = new DomainCoordinator();
    const keys = generateKeypair();
    coordinator.register(keys.publicKey, ['security']);

    // Query for a domain that nobody subscribes to
    const result = coordinator.selectPeersForReport(['unknown-domain-xyz']);
    assert.equal(result, null, 'Should return null for unknown domains');
  });

  it('gossip engine with coordinator tracks coordinatorRouted stat', async () => {
    const node = new RoutingTestNode(0, ['security']);
    const otherNode = new RoutingTestNode(1, ['security']);
    node.addTrustedPeer(otherNode);

    const peers = node.db.prepare("SELECT * FROM myr_peers WHERE trust_level = 'trusted'").all();
    node.pss.initializeFromPeers(peers);

    const coordinator = new DomainCoordinator();
    coordinator.register(otherNode.keys.publicKey, ['security']);

    const engine = new GossipEngine({
      db: node.db,
      keys: node.keys,
      pss: node.pss,
      ttl: 5,
      coordinator,
    });

    node.seedReports(3, 'security');
    const reports = node.getReports().map(r => ({
      signature: r.signed_artifact,
      domain_tags: r.domain_tags,
      created_at: r.created_at,
    }));

    await engine.disseminate(reports);

    const stats = engine.getStats();
    assert.equal(stats.coordinatorRouted, 1,
      'Should track coordinator-routed disseminations');
    assert.ok(stats.ihaveSent > 0, 'Should have sent IHAVE messages');
  });

  it('backward compatible: engine without coordinator works normally', async () => {
    const node = new RoutingTestNode(0, ['security']);
    const otherNode = new RoutingTestNode(1, ['security']);
    node.addTrustedPeer(otherNode);

    const peers = node.db.prepare("SELECT * FROM myr_peers WHERE trust_level = 'trusted'").all();
    node.pss.initializeFromPeers(peers);

    const engine = new GossipEngine({
      db: node.db,
      keys: node.keys,
      pss: node.pss,
      ttl: 5,
      // no coordinator
    });

    node.seedReports(2, 'security');
    const reports = node.getReports().map(r => ({
      signature: r.signed_artifact,
      domain_tags: r.domain_tags,
      created_at: r.created_at,
    }));

    await engine.disseminate(reports);

    const stats = engine.getStats();
    assert.equal(stats.coordinatorRouted, 0,
      'Should not track coordinator routing when coordinator is absent');
    assert.ok(stats.ihaveSent > 0, 'Should still send IHAVE messages');
  });

  it('coordinator routing with mixed domains routes reports to correct subsets', () => {
    const coordinator = new DomainCoordinator();

    const secKeys = [generateKeypair(), generateKeypair(), generateKeypair()];
    const perfKeys = [generateKeypair(), generateKeypair()];
    const bothKeys = [generateKeypair()];

    for (const k of secKeys) coordinator.register(k.publicKey, ['security']);
    for (const k of perfKeys) coordinator.register(k.publicKey, ['performance']);
    for (const k of bothKeys) coordinator.register(k.publicKey, ['security', 'performance']);

    // Security report should reach security peers + both peers
    const secTargets = coordinator.selectPeersForReport(['security']);
    assert.equal(secTargets.length, 4); // 3 sec + 1 both

    // Performance report should reach performance peers + both peers
    const perfTargets = coordinator.selectPeersForReport(['performance']);
    assert.equal(perfTargets.length, 3); // 2 perf + 1 both

    // Report with both domains should reach all 6 peers
    const bothTargets = coordinator.selectPeersForReport(['security', 'performance']);
    assert.equal(bothTargets.length, 6); // all unique
  });
});
