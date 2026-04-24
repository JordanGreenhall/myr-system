'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  freshnessScore,
  applicationScore,
  contradictionPenalty,
  ratingScore,
  confidenceScore,
  sourceTrustScore,
  scoreReport,
  rankReports,
  explainYield,
  FRESHNESS_HALF_LIFE_DAYS,
} = require('../lib/yield-scoring');

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

    CREATE TABLE myr_applications (
      id TEXT PRIMARY KEY,
      source_yield_id TEXT NOT NULL,
      applied_by_node_id TEXT NOT NULL,
      downstream_use TEXT NOT NULL,
      outcome TEXT,
      applied_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      signed_by TEXT NOT NULL,
      signature TEXT NOT NULL
    );

    CREATE TABLE myr_contradictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      yield_a_id TEXT NOT NULL,
      yield_b_id TEXT NOT NULL,
      domain_tag TEXT,
      contradiction_type TEXT NOT NULL,
      details TEXT DEFAULT '{}',
      detected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(yield_a_id, yield_b_id, contradiction_type, domain_tag)
    );
  `);

  return db;
}

function insertReport(db, overrides = {}) {
  const now = new Date().toISOString();
  const defaults = {
    id: `report-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: now,
    agent_id: 'test-agent',
    node_id: 'n1',
    cycle_intent: 'Test intent',
    domain_tags: '["testing"]',
    yield_type: 'insight',
    question_answered: 'Test question',
    evidence: 'Test evidence',
    what_changes_next: 'Test changes',
    confidence: 0.7,
    created_at: now,
    updated_at: now,
  };
  const r = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO myr_reports (
      id, timestamp, agent_id, node_id, cycle_intent, domain_tags, cycle_context,
      yield_type, question_answered, evidence, what_changes_next,
      what_was_falsified, confidence, operator_rating, auto_draft, imported_from,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r.id, r.timestamp, r.agent_id, r.node_id, r.cycle_intent, r.domain_tags,
    r.cycle_context || null, r.yield_type, r.question_answered, r.evidence,
    r.what_changes_next, r.what_was_falsified || null, r.confidence,
    r.operator_rating || null, r.auto_draft || 0, r.imported_from || null,
    r.created_at, r.updated_at
  );
  return r;
}

describe('freshnessScore', () => {
  it('returns 1.0 for brand new reports', () => {
    const now = Date.now();
    assert.strictEqual(freshnessScore(new Date(now).toISOString(), now), 1.0);
  });

  it('returns 0.5 at the half-life', () => {
    const now = Date.now();
    const halfLifeAgo = new Date(now - FRESHNESS_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const score = freshnessScore(halfLifeAgo, now);
    assert.ok(Math.abs(score - 0.5) < 0.01, `Expected ~0.5, got ${score}`);
  });

  it('returns near 0 for very old reports', () => {
    const now = Date.now();
    const yearAgo = new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString();
    const score = freshnessScore(yearAgo, now);
    assert.ok(score < 0.01, `Expected near 0, got ${score}`);
  });

  it('returns 0.5 for null createdAt', () => {
    assert.strictEqual(freshnessScore(null), 0.5);
  });
});

describe('ratingScore', () => {
  it('returns 0.5 for unrated', () => {
    const { score } = ratingScore(null);
    assert.strictEqual(score, 0.5);
  });

  it('returns 0 for rating 1', () => {
    const { score } = ratingScore(1);
    assert.strictEqual(score, 0);
  });

  it('returns 1.0 for rating 5', () => {
    const { score } = ratingScore(5);
    assert.strictEqual(score, 1);
  });

  it('returns 0.5 for rating 3', () => {
    const { score } = ratingScore(3);
    assert.strictEqual(score, 0.5);
  });
});

describe('confidenceScore', () => {
  it('returns 0.7 for null confidence', () => {
    const { score } = confidenceScore(null);
    assert.strictEqual(score, 0.7);
  });

  it('returns the value directly for valid confidence', () => {
    const { score } = confidenceScore(0.85);
    assert.strictEqual(score, 0.85);
  });

  it('clamps to 1.0', () => {
    const { score } = confidenceScore(1.5);
    assert.strictEqual(score, 1);
  });
});

describe('applicationScore', () => {
  let db;
  before(() => { db = createTestDb(); });
  after(() => { db.close(); });

  it('returns 0 for no applications', () => {
    const { score, applications } = applicationScore(db, 'nonexistent');
    assert.strictEqual(score, 0);
    assert.strictEqual(applications, 0);
  });

  it('returns positive score for applications', () => {
    const r = insertReport(db, { id: 'app-test-1' });
    db.prepare(`
      INSERT INTO myr_applications (id, source_yield_id, applied_by_node_id, downstream_use, outcome, applied_at, created_at, signed_by, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('app-1', 'app-test-1', 'n2', 'Used in analysis', 'positive', new Date().toISOString(), new Date().toISOString(), 'key1', 'sig1');

    const { score, applications } = applicationScore(db, 'app-test-1');
    assert.ok(score > 0, `Expected positive score, got ${score}`);
    assert.strictEqual(applications, 1);
  });
});

describe('contradictionPenalty', () => {
  let db;
  before(() => { db = createTestDb(); });
  after(() => { db.close(); });

  it('returns 0 for no contradictions', () => {
    const { penalty } = contradictionPenalty(db, 'no-contradictions');
    assert.strictEqual(penalty, 0);
  });

  it('returns penalty for contradicted report', () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO myr_contradictions (yield_a_id, yield_b_id, domain_tag, contradiction_type, detected_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('contra-a', 'contra-b', 'testing', 'observation_vs_falsification', now, now);

    const { penalty, contradictions } = contradictionPenalty(db, 'contra-a');
    assert.ok(penalty > 0);
    assert.strictEqual(contradictions, 1);
  });
});

describe('sourceTrustScore', () => {
  let db;
  before(() => { db = createTestDb(); });
  after(() => { db.close(); });

  it('returns 1.0 for local reports', () => {
    const r = insertReport(db, { id: 'local-1', imported_from: null });
    const row = db.prepare('SELECT * FROM myr_reports WHERE id = ?').get('local-1');
    const { score } = sourceTrustScore(db, row);
    assert.strictEqual(score, 1.0);
  });

  it('returns lower score for imported reports with no trust history', () => {
    const r = insertReport(db, { id: 'imported-1', imported_from: 'unknown-peer' });
    const row = db.prepare('SELECT * FROM myr_reports WHERE id = ?').get('imported-1');
    const { score } = sourceTrustScore(db, row);
    assert.ok(score < 1.0, `Expected < 1.0 for unknown peer, got ${score}`);
  });
});

describe('scoreReport', () => {
  let db;
  before(() => { db = createTestDb(); });
  after(() => { db.close(); });

  it('returns a composite score between 0 and 1', () => {
    insertReport(db, { id: 'score-1', operator_rating: 4, confidence: 0.9 });
    const row = db.prepare('SELECT * FROM myr_reports WHERE id = ?').get('score-1');
    const { score, factors, explanation } = scoreReport(db, row);
    assert.ok(score >= 0 && score <= 1, `Score ${score} out of range`);
    assert.ok(factors.sourceTrust);
    assert.ok(factors.freshness);
    assert.ok(factors.confidence);
    assert.ok(factors.operatorRating);
    assert.ok(factors.applicationFeedback);
    assert.ok(factors.contradictionPenalty);
    assert.ok(typeof explanation === 'string');
  });

  it('scores high-quality local reports higher', () => {
    insertReport(db, { id: 'high-q', operator_rating: 5, confidence: 0.95 });
    insertReport(db, { id: 'low-q', operator_rating: 1, confidence: 0.3, imported_from: 'unknown' });
    const high = db.prepare('SELECT * FROM myr_reports WHERE id = ?').get('high-q');
    const low = db.prepare('SELECT * FROM myr_reports WHERE id = ?').get('low-q');
    const highScore = scoreReport(db, high).score;
    const lowScore = scoreReport(db, low).score;
    assert.ok(highScore > lowScore, `High-quality (${highScore}) should beat low-quality (${lowScore})`);
  });
});

describe('rankReports', () => {
  let db;
  before(() => { db = createTestDb(); });
  after(() => { db.close(); });

  it('sorts reports by composite score descending', () => {
    insertReport(db, { id: 'rank-a', operator_rating: 5, confidence: 0.95 });
    insertReport(db, { id: 'rank-b', operator_rating: 2, confidence: 0.3 });
    insertReport(db, { id: 'rank-c', operator_rating: 4, confidence: 0.8 });

    const rows = db.prepare('SELECT * FROM myr_reports WHERE id IN (?, ?, ?)').all('rank-a', 'rank-b', 'rank-c');
    const ranked = rankReports(db, rows);

    assert.strictEqual(ranked.length, 3);
    assert.ok(ranked[0]._yieldScore >= ranked[1]._yieldScore);
    assert.ok(ranked[1]._yieldScore >= ranked[2]._yieldScore);
  });

  it('filters by minScore', () => {
    insertReport(db, { id: 'min-a', operator_rating: 5, confidence: 0.95 });
    insertReport(db, { id: 'min-b', operator_rating: 1, confidence: 0.1 });

    const rows = db.prepare('SELECT * FROM myr_reports WHERE id IN (?, ?)').all('min-a', 'min-b');
    const ranked = rankReports(db, rows, { minScore: 0.5 });

    // At least the high-quality one should pass
    assert.ok(ranked.some(r => r.id === 'min-a'));
  });
});

describe('explainYield', () => {
  let db;
  before(() => { db = createTestDb(); });
  after(() => { db.close(); });

  it('returns surfaced/withheld decision with reasons', () => {
    insertReport(db, { id: 'explain-1', operator_rating: 4, confidence: 0.9 });
    const row = db.prepare('SELECT * FROM myr_reports WHERE id = ?').get('explain-1');
    const result = explainYield(db, row);

    assert.ok(result.reportId);
    assert.ok(typeof result.score === 'number');
    assert.ok(['surfaced', 'withheld'].includes(result.decision));
    assert.ok(typeof result.explanation === 'string');
    assert.ok(Array.isArray(result.reasons));
    assert.ok(result.factors);
  });

  it('flags contradicted reports', () => {
    insertReport(db, { id: 'explain-contra' });
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO myr_contradictions (yield_a_id, yield_b_id, domain_tag, contradiction_type, detected_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('explain-contra', 'other-report', 'testing', 'opposing_confidence', now, now);

    const row = db.prepare('SELECT * FROM myr_reports WHERE id = ?').get('explain-contra');
    const result = explainYield(db, row);
    assert.ok(result.reasons.some(r => r.includes('contradiction')));
  });
});

describe('trust-weighted recall integration', () => {
  let db;
  before(() => {
    db = createTestDb();

    db.exec(`
      CREATE VIRTUAL TABLE myr_fts USING fts5(
        id, cycle_intent, cycle_context, question_answered, evidence,
        what_changes_next, what_was_falsified, domain_tags,
        content=myr_reports, content_rowid=rowid
      );
      CREATE TRIGGER myr_fts_insert AFTER INSERT ON myr_reports BEGIN
        INSERT INTO myr_fts(rowid, id, cycle_intent, cycle_context, question_answered, evidence, what_changes_next, what_was_falsified, domain_tags)
        VALUES (new.rowid, new.id, new.cycle_intent, new.cycle_context, new.question_answered, new.evidence, new.what_changes_next, new.what_was_falsified, new.domain_tags);
      END;
    `);

    // High-quality local report
    insertReport(db, {
      id: 'tw-local',
      cycle_intent: 'Investigate network routing efficiency',
      domain_tags: '["networking","routing"]',
      question_answered: 'How does trust-weighted routing improve yield',
      evidence: 'Selective routing reduced noise by 60%',
      what_changes_next: 'Deploy trust-weighted routing',
      confidence: 0.9,
      operator_rating: 5,
    });

    // Lower-quality imported report
    insertReport(db, {
      id: 'tw-imported',
      cycle_intent: 'Network routing test from peer',
      domain_tags: '["networking","routing"]',
      question_answered: 'Does routing affect sync performance',
      evidence: 'Some improvement observed',
      what_changes_next: 'More testing needed',
      confidence: 0.4,
      operator_rating: 2,
      imported_from: 'untrusted-peer',
    });
  });

  after(() => { db.close(); });

  it('recall ranks higher-trust reports first', () => {
    const { recall } = require('../lib/recall');
    const result = recall(db, { intent: 'network routing', explain: true });

    assert.ok(result.results.length >= 2);
    // Local high-quality should rank first
    assert.strictEqual(result.results[0].id, 'tw-local');
    assert.ok(result.results[0].yieldScore > result.results[1].yieldScore);
    assert.ok(result.results[0].yieldExplanation);
    assert.ok(result.results[0].yieldFactors);
  });

  it('recall respects minScore filter', () => {
    const { recall } = require('../lib/recall');
    const result = recall(db, { intent: 'network routing', minScore: 0.6 });
    // The low-quality imported one may be filtered out
    for (const r of result.results) {
      assert.ok(r.yieldScore >= 0.6, `Score ${r.yieldScore} below minScore`);
    }
  });
});
