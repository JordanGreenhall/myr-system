'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  STAGES,
  PROMOTION_CRITERIA,
  DEMOTION_TRIGGERS,
  hasCapability,
  stageOrder,
  computeStage,
  computeDomainTrust,
  getPeerDomainTrust,
  enforceStage,
  gatherPeerStats,
  getStageProgress,
} = require('../lib/participation');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE myr_reports (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      session_ref TEXT,
      cycle_intent TEXT NOT NULL,
      domain_tags TEXT NOT NULL,
      cycle_context TEXT,
      yield_type TEXT NOT NULL CHECK(yield_type IN ('technique','insight','falsification','pattern')),
      question_answered TEXT NOT NULL,
      evidence TEXT NOT NULL,
      what_changes_next TEXT NOT NULL,
      what_was_falsified TEXT,
      transferable_to TEXT,
      confidence REAL NOT NULL DEFAULT 0.7,
      operator_rating INTEGER,
      operator_notes TEXT,
      verified_at TEXT,
      signed_by TEXT,
      shared_with TEXT,
      synthesis_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      imported_from TEXT,
      signed_artifact TEXT,
      import_verified INTEGER DEFAULT 0,
      auto_draft INTEGER DEFAULT 0,
      source_memory_id INTEGER,
      share_network INTEGER DEFAULT 0
    );

    CREATE TABLE myr_peers (
      node_id TEXT PRIMARY KEY,
      node_name TEXT,
      public_key TEXT NOT NULL,
      public_key_format TEXT DEFAULT 'pem',
      added_at TEXT NOT NULL,
      last_import_at TEXT,
      myr_count INTEGER DEFAULT 0,
      peer_url TEXT,
      operator_name TEXT,
      trust_level TEXT DEFAULT 'pending',
      approved_at TEXT,
      last_sync_at TEXT,
      auto_sync INTEGER DEFAULT 1,
      notes TEXT,
      node_uuid TEXT,
      verification_evidence TEXT,
      auto_approved INTEGER DEFAULT 0,
      participation_stage TEXT DEFAULT 'local-only',
      domain_trust TEXT DEFAULT '{}',
      stage_evaluated_at TEXT,
      stage_changed_at TEXT,
      stage_evidence TEXT
    );

    CREATE TABLE myr_traces (
      trace_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('introduce','approve','share','sync_pull','sync_push','verify','reject','discover','relay_sync')),
      actor_fingerprint TEXT NOT NULL,
      target_fingerprint TEXT,
      artifact_signature TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','rejected')),
      rejection_reason TEXT,
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX idx_traces_timestamp ON myr_traces(timestamp);
  `);

  return db;
}

function insertPeer(db, overrides = {}) {
  const defaults = {
    node_id: 'peer-1',
    public_key: 'abc123',
    operator_name: 'test-peer',
    trust_level: 'trusted',
    added_at: new Date().toISOString(),
    participation_stage: 'local-only',
  };
  const p = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO myr_peers (node_id, public_key, operator_name, trust_level, added_at, participation_stage)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(p.node_id, p.public_key, p.operator_name, p.trust_level, p.added_at, p.participation_stage);
  return p;
}

function insertReport(db, overrides = {}) {
  const now = new Date().toISOString();
  const defaults = {
    id: `n1-20260416-${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
    timestamp: now,
    agent_id: 'test',
    node_id: 'n1',
    cycle_intent: 'Test',
    domain_tags: '["testing"]',
    yield_type: 'insight',
    question_answered: 'Q',
    evidence: 'E',
    what_changes_next: 'C',
    confidence: 0.7,
    created_at: now,
    updated_at: now,
    share_network: 0,
  };
  const r = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO myr_reports (
      id, timestamp, agent_id, node_id, cycle_intent, domain_tags,
      yield_type, question_answered, evidence, what_changes_next,
      confidence, operator_rating, imported_from, share_network,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r.id, r.timestamp, r.agent_id, r.node_id, r.cycle_intent, r.domain_tags,
    r.yield_type, r.question_answered, r.evidence, r.what_changes_next,
    r.confidence, r.operator_rating || null, r.imported_from || null, r.share_network,
    r.created_at, r.updated_at
  );
  return r.id;
}

// --- Stage definition tests ---

describe('STAGES', () => {
  it('defines exactly 4 stages', () => {
    assert.strictEqual(Object.keys(STAGES).length, 4);
  });

  it('stages have correct order', () => {
    assert.strictEqual(STAGES['local-only'].order, 0);
    assert.strictEqual(STAGES['provisional'].order, 1);
    assert.strictEqual(STAGES['bounded'].order, 2);
    assert.strictEqual(STAGES['trusted-full'].order, 3);
  });

  it('local-only cannot sync or send/receive yield', () => {
    const cap = STAGES['local-only'].capabilities;
    assert.strictEqual(cap.canSync, false);
    assert.strictEqual(cap.canSendYield, false);
    assert.strictEqual(cap.canReceiveYield, false);
    assert.strictEqual(cap.canRelay, false);
  });

  it('local-only can discover and announce', () => {
    const cap = STAGES['local-only'].capabilities;
    assert.strictEqual(cap.canDiscover, true);
    assert.strictEqual(cap.canAnnounce, true);
    assert.strictEqual(cap.canIntroduce, true);
  });

  it('provisional can sync with limited peers', () => {
    const cap = STAGES['provisional'].capabilities;
    assert.strictEqual(cap.canSync, true);
    assert.strictEqual(cap.canSendYield, true);
    assert.strictEqual(cap.canReceiveYield, true);
    assert.strictEqual(cap.canRelay, false);
    assert.strictEqual(cap.maxSyncPeers, 3);
  });

  it('bounded can relay and has higher peer limit', () => {
    const cap = STAGES['bounded'].capabilities;
    assert.strictEqual(cap.canRelay, true);
    assert.strictEqual(cap.maxSyncPeers, 20);
  });

  it('trusted-full has no restrictions', () => {
    assert.strictEqual(STAGES['trusted-full'].restrictions.length, 0);
    assert.strictEqual(STAGES['trusted-full'].capabilities.maxSyncPeers, Infinity);
  });
});

describe('hasCapability', () => {
  it('returns true for allowed capabilities', () => {
    assert.strictEqual(hasCapability('provisional', 'canSync'), true);
    assert.strictEqual(hasCapability('bounded', 'canRelay'), true);
  });

  it('returns false for disallowed capabilities', () => {
    assert.strictEqual(hasCapability('local-only', 'canSync'), false);
    assert.strictEqual(hasCapability('provisional', 'canRelay'), false);
  });

  it('returns false for unknown stage', () => {
    assert.strictEqual(hasCapability('nonexistent', 'canSync'), false);
  });
});

describe('stageOrder', () => {
  it('returns correct order indices', () => {
    assert.strictEqual(stageOrder('local-only'), 0);
    assert.strictEqual(stageOrder('provisional'), 1);
    assert.strictEqual(stageOrder('bounded'), 2);
    assert.strictEqual(stageOrder('trusted-full'), 3);
  });

  it('returns -1 for unknown stage', () => {
    assert.strictEqual(stageOrder('unknown'), -1);
  });
});

// --- Promotion/demotion tests ---

describe('PROMOTION_CRITERIA', () => {
  it('defines 3 promotion paths', () => {
    assert.strictEqual(Object.keys(PROMOTION_CRITERIA).length, 3);
  });

  it('local-only→provisional requires 1 mutual approval', () => {
    assert.ok(PROMOTION_CRITERIA['local-only→provisional'].check({ mutualApprovals: 1 }));
    assert.ok(!PROMOTION_CRITERIA['local-only→provisional'].check({ mutualApprovals: 0 }));
  });

  it('provisional→bounded requires 3 approvals, 10 MYRs, avg rating 3.0', () => {
    assert.ok(PROMOTION_CRITERIA['provisional→bounded'].check({
      mutualApprovals: 3, sharedMyrCount: 10, avgRating: 3.0,
    }));
    assert.ok(!PROMOTION_CRITERIA['provisional→bounded'].check({
      mutualApprovals: 2, sharedMyrCount: 10, avgRating: 3.0,
    }));
  });

  it('bounded→trusted-full has strict requirements', () => {
    assert.ok(PROMOTION_CRITERIA['bounded→trusted-full'].check({
      mutualApprovals: 10, sharedMyrCount: 50, avgRating: 3.5, activeDays: 30, recentRejections: 0,
    }));
    assert.ok(!PROMOTION_CRITERIA['bounded→trusted-full'].check({
      mutualApprovals: 10, sharedMyrCount: 50, avgRating: 3.5, activeDays: 29, recentRejections: 0,
    }));
  });
});

describe('DEMOTION_TRIGGERS', () => {
  it('defines 3 demotion paths', () => {
    assert.strictEqual(Object.keys(DEMOTION_TRIGGERS).length, 3);
  });

  it('trusted-full→bounded triggers on high rejection rate', () => {
    assert.ok(DEMOTION_TRIGGERS['trusted-full→bounded'].check({
      recentRejectionRate: 0.15, consecutiveRejectedSyncs: 0,
    }));
  });

  it('trusted-full→bounded triggers on 3 consecutive rejected syncs', () => {
    assert.ok(DEMOTION_TRIGGERS['trusted-full→bounded'].check({
      recentRejectionRate: 0, consecutiveRejectedSyncs: 3,
    }));
  });

  it('provisional→local-only triggers when no mutual approvals', () => {
    assert.ok(DEMOTION_TRIGGERS['provisional→local-only'].check({
      mutualApprovals: 0,
    }));
    assert.ok(!DEMOTION_TRIGGERS['provisional→local-only'].check({
      mutualApprovals: 1,
    }));
  });
});

// --- computeStage tests ---

describe('computeStage', () => {
  let db;
  before(() => { db = createTestDb(); });
  after(() => { db.close(); });

  it('holds at local-only with no peers', () => {
    const result = computeStage(db, 'abc', 'local-only');
    assert.strictEqual(result.stage, 'local-only');
    assert.strictEqual(result.action, 'hold');
  });

  it('promotes to provisional with 1 trusted peer', () => {
    insertPeer(db, { node_id: 'p1', public_key: 'key1', trust_level: 'trusted' });
    const result = computeStage(db, 'abc', 'local-only');
    assert.strictEqual(result.stage, 'provisional');
    assert.strictEqual(result.action, 'promote');
  });

  it('returns stats in result', () => {
    const result = computeStage(db, 'abc', 'provisional');
    assert.ok(result.stats);
    assert.ok(typeof result.stats.mutualApprovals === 'number');
    assert.ok(typeof result.stats.sharedMyrCount === 'number');
    assert.ok(typeof result.stats.avgRating === 'number');
  });
});

describe('getStageProgress', () => {
  it('shows unmet baseline and next-step guidance for local-only', () => {
    const result = getStageProgress('local-only', {
      mutualApprovals: 0,
      sharedMyrCount: 0,
      avgRating: 0,
      activeDays: 0,
      recentRejections: 0,
    });

    assert.strictEqual(result.current.key, 'local-only');
    assert.strictEqual(result.minimumViable.met, false);
    assert.strictEqual(result.nextStage.key, 'provisional');
    assert.strictEqual(result.progress.metChecks, 0);
    assert.ok(result.guidance[0].includes('trusted peer approval'));
  });

  it('shows partial progress from provisional to bounded', () => {
    const result = getStageProgress('provisional', {
      mutualApprovals: 2,
      sharedMyrCount: 10,
      avgRating: 2.5,
      activeDays: 4,
      recentRejections: 0,
    });

    assert.strictEqual(result.minimumViable.met, true);
    assert.strictEqual(result.nextStage.key, 'bounded');
    assert.strictEqual(result.progress.totalChecks, 3);
    assert.strictEqual(result.progress.metChecks, 1);
    assert.ok(result.guidance.some((line) => line.includes('trusted peer approval')));
    assert.ok(result.guidance.some((line) => line.includes('operator rating')));
  });

  it('shows terminal state at trusted-full', () => {
    const result = getStageProgress('trusted-full', {
      mutualApprovals: 12,
      sharedMyrCount: 80,
      avgRating: 4.2,
      activeDays: 200,
      recentRejections: 0,
    });

    assert.strictEqual(result.minimumViable.met, true);
    assert.strictEqual(result.nextStage, null);
    assert.strictEqual(result.progress.percent, 100);
    assert.ok(result.guidance[0].includes('Maximum participation stage'));
  });
});

// --- Domain trust tests ---

describe('computeDomainTrust', () => {
  let db;
  before(() => {
    db = createTestDb();
    // Insert imported reports from peer-x in networking domain
    for (let i = 0; i < 5; i++) {
      insertReport(db, {
        id: `px-20260416-${String(i).padStart(3, '0')}`,
        node_id: 'peer-x',
        domain_tags: '["networking","sync"]',
        operator_rating: 4,
        imported_from: 'peer-x',
      });
    }
    // One falsification
    insertReport(db, {
      id: 'px-20260416-010',
      node_id: 'peer-x',
      domain_tags: '["networking"]',
      yield_type: 'falsification',
      operator_rating: 5,
      imported_from: 'peer-x',
    });
  });
  after(() => { db.close(); });

  it('returns score > 0 for peer with contributions', () => {
    const result = computeDomainTrust(db, 'peer-x', 'networking');
    assert.ok(result.score > 0);
    assert.ok(result.count > 0);
    assert.ok(result.avgRating > 0);
  });

  it('returns score 0 for peer with no contributions', () => {
    const result = computeDomainTrust(db, 'peer-y', 'networking');
    assert.strictEqual(result.score, 0);
  });

  it('counts falsifications separately', () => {
    const result = computeDomainTrust(db, 'peer-x', 'networking');
    assert.ok(result.falsifications >= 1);
  });

  it('includes evidence string', () => {
    const result = computeDomainTrust(db, 'peer-x', 'networking');
    assert.ok(typeof result.evidence === 'string');
    assert.ok(result.evidence.includes('verified MYRs'));
  });
});

describe('getPeerDomainTrust', () => {
  let db;
  before(() => {
    db = createTestDb();
    insertReport(db, {
      id: 'pa-001',
      node_id: 'pa',
      domain_tags: '["crypto","security"]',
      operator_rating: 4,
      imported_from: 'pa',
    });
    insertReport(db, {
      id: 'pa-002',
      node_id: 'pa',
      domain_tags: '["networking"]',
      operator_rating: 3,
      imported_from: 'pa',
    });
  });
  after(() => { db.close(); });

  it('returns trust scores for all domains', () => {
    const result = getPeerDomainTrust(db, 'pa');
    assert.ok(Object.keys(result).length > 0);
    assert.ok('crypto' in result || 'security' in result || 'networking' in result);
  });

  it('each domain has a score object', () => {
    const result = getPeerDomainTrust(db, 'pa');
    for (const domain of Object.keys(result)) {
      assert.ok(typeof result[domain].score === 'number');
      assert.ok(result[domain].score >= 0 && result[domain].score <= 1);
    }
  });
});

// --- enforceStage tests ---

describe('enforceStage', () => {
  let db;
  before(() => {
    db = createTestDb();
    insertPeer(db, {
      node_id: 'enforce-local',
      public_key: 'key-local',
      trust_level: 'pending',
      participation_stage: 'local-only',
    });
    insertPeer(db, {
      node_id: 'enforce-prov',
      public_key: 'key-prov',
      trust_level: 'trusted',
      participation_stage: 'provisional',
    });
    insertPeer(db, {
      node_id: 'enforce-full',
      public_key: 'key-full',
      trust_level: 'trusted',
      participation_stage: 'trusted-full',
    });
  });
  after(() => { db.close(); });

  it('local-only peer cannot sync', () => {
    const result = enforceStage(db, 'key-local', 'canSync');
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.stage, 'local-only');
  });

  it('provisional peer can sync', () => {
    const result = enforceStage(db, 'key-prov', 'canSync');
    assert.strictEqual(result.allowed, true);
  });

  it('provisional peer cannot relay', () => {
    const result = enforceStage(db, 'key-prov', 'canRelay');
    assert.strictEqual(result.allowed, false);
  });

  it('trusted-full peer can do everything', () => {
    assert.strictEqual(enforceStage(db, 'key-full', 'canSync').allowed, true);
    assert.strictEqual(enforceStage(db, 'key-full', 'canRelay').allowed, true);
    assert.strictEqual(enforceStage(db, 'key-full', 'canReceiveYield').allowed, true);
  });

  it('returns null for unknown peer', () => {
    assert.strictEqual(enforceStage(db, 'nonexistent', 'canSync'), null);
  });

  it('legacy compat: trusted peer with no stage gets provisional', () => {
    // Insert a peer with trust_level=trusted but stage=local-only (legacy)
    insertPeer(db, {
      node_id: 'legacy',
      public_key: 'key-legacy',
      trust_level: 'trusted',
      participation_stage: 'local-only',
    });
    const result = enforceStage(db, 'key-legacy', 'canSync');
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.stage, 'provisional');
  });
});

// --- Server endpoint tests ---

describe('participation server endpoints', () => {
  let db, app;

  before(() => {
    db = createTestDb();
    const { createApp } = require('../server/index');
    const config = {
      port: 0,
      node_url: 'http://localhost:0',
      operator_name: 'test',
      node_id: 'test-node',
      participation_stage: 'provisional',
    };
    app = createApp({ config, db, publicKeyHex: 'a'.repeat(64), createdAt: new Date().toISOString() });
  });

  after(() => { db.close(); });

  it('GET /myr/participation/stages returns all stages', async () => {
    const http = require('http');
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/myr/participation/stages`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(body.stages);
      assert.ok(body.stages['local-only']);
      assert.ok(body.stages['provisional']);
      assert.ok(body.stages['bounded']);
      assert.ok(body.stages['trusted-full']);
    } finally {
      server.close();
    }
  });

  it('GET /myr/participation/evaluate returns current stage evaluation', async () => {
    const http = require('http');
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/myr/participation/evaluate`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(body.currentStage);
      assert.ok(body.evaluation);
      assert.ok(body.evaluation.stats);
      assert.ok(body.domainTrust !== undefined);
    } finally {
      server.close();
    }
  });
});
