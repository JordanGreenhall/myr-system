'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { analyzeCluster, synthesize, validateSynthesisRequest } = require('../lib/synthesis');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE myr_reports (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      domain_tags TEXT NOT NULL,
      yield_type TEXT NOT NULL,
      question_answered TEXT NOT NULL,
      evidence TEXT NOT NULL,
      what_changes_next TEXT NOT NULL,
      what_was_falsified TEXT,
      operator_rating INTEGER,
      imported_from TEXT,
      signed_by TEXT,
      import_verified INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE myr_syntheses (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      source_myr_ids TEXT NOT NULL,
      node_ids TEXT NOT NULL,
      domain_tags TEXT NOT NULL,
      synthesis_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function insertReport(db, overrides = {}) {
  const now = overrides.created_at || '2026-04-16T00:00:00.000Z';
  const row = {
    id: overrides.id || `r-${Math.random().toString(16).slice(2)}`,
    node_id: overrides.node_id || 'n1',
    domain_tags: overrides.domain_tags || '["sync"]',
    yield_type: overrides.yield_type || 'insight',
    question_answered: overrides.question_answered || 'default question',
    evidence: overrides.evidence || 'default evidence',
    what_changes_next: overrides.what_changes_next || 'default change',
    what_was_falsified: overrides.what_was_falsified || null,
    operator_rating: overrides.operator_rating ?? null,
    imported_from: overrides.imported_from || null,
    signed_by: overrides.signed_by || null,
    import_verified: overrides.import_verified ? 1 : 0,
    created_at: now,
  };

  db.prepare(`
    INSERT INTO myr_reports (
      id, node_id, domain_tags, yield_type, question_answered, evidence,
      what_changes_next, what_was_falsified, operator_rating, imported_from,
      signed_by, import_verified, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.node_id,
    row.domain_tags,
    row.yield_type,
    row.question_answered,
    row.evidence,
    row.what_changes_next,
    row.what_was_falsified,
    row.operator_rating,
    row.imported_from,
    row.signed_by,
    row.import_verified,
    row.created_at
  );

  return row.id;
}

describe('synthesis', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('handles zero overlap gracefully', () => {
    insertReport(db, {
      id: 'r1',
      node_id: 'n1',
      domain_tags: '["storage"]',
    });

    const result = synthesize(db, { tags: ['sync'], minNodes: 2, store: true });
    assert.equal(result.clusters.length, 0);
    assert.equal(result.sourceCount, 0);
    assert.equal(result.synthId, null);
    assert.match(result.markdown, /No MYRs found matching those tags/);
  });

  it('handles single-source overlap without storing synthesis', () => {
    insertReport(db, {
      id: 'r-single',
      node_id: 'n1',
      domain_tags: '["sync"]',
    });

    const result = synthesize(db, { tags: ['sync'], minNodes: 2, store: true });
    assert.equal(result.sourceCount, 1);
    assert.equal(result.clusters.length, 0);
    assert.equal(result.synthId, null);

    const synthCount = db.prepare('SELECT COUNT(*) AS cnt FROM myr_syntheses').get().cnt;
    assert.equal(synthCount, 0);
  });

  it('detects divergent contradictory findings across nodes', () => {
    const analysis = analyzeCluster([
      {
        id: 'r1',
        node_id: 'n1',
        yield_type: 'insight',
        question_answered: 'What is the bottleneck?',
        what_changes_next: 'Increase cache',
        evidence: 'e1',
      },
      {
        id: 'r2',
        node_id: 'n2',
        yield_type: 'insight',
        question_answered: 'What causes latency?',
        what_changes_next: 'Reduce cache',
        evidence: 'e2',
      },
    ]);

    assert.equal(analysis.divergent.length, 1);
    assert.equal(analysis.convergent.length, 0);
  });

  it('marks rating conflicts for convergent same-question reports', () => {
    const analysis = analyzeCluster([
      {
        id: 'r1',
        node_id: 'n1',
        yield_type: 'insight',
        question_answered: 'Does retry improve reliability?',
        what_changes_next: 'Use retry',
        operator_rating: 1,
        evidence: 'e1',
      },
      {
        id: 'r2',
        node_id: 'n2',
        yield_type: 'insight',
        question_answered: 'Does retry improve reliability?',
        what_changes_next: 'Use retry',
        operator_rating: 5,
        evidence: 'e2',
      },
    ]);

    assert.equal(analysis.convergent.length, 1);
    assert.equal(analysis.convergent[0].ratingConflict, true);
  });

  it('stores provenance chain in synthesis records', () => {
    insertReport(db, {
      id: 'r1',
      node_id: 'n1',
      domain_tags: '["sync"]',
      question_answered: 'How to recover from timeout?',
      imported_from: 'n2',
      signed_by: 'operator-a',
      import_verified: 1,
      operator_rating: 4,
    });
    insertReport(db, {
      id: 'r2',
      node_id: 'n2',
      domain_tags: '["sync"]',
      question_answered: 'How to recover from timeout?',
      imported_from: 'n3',
      signed_by: 'operator-b',
      import_verified: 1,
      operator_rating: 5,
    });

    const result = synthesize(db, { tags: ['sync'], minNodes: 2, store: true });
    assert.ok(result.synthId);
    assert.equal(result.clusters.length, 1);

    const row = db.prepare('SELECT source_myr_ids FROM myr_syntheses WHERE id = ?').get(result.synthId);
    const source = JSON.parse(row.source_myr_ids);
    assert.deepEqual(source.ids.sort(), ['r1', 'r2']);
    assert.equal(source.provenance.length, 2);
    assert.equal(source.provenance[0].importedFrom, 'n2');
  });

  it('validates request payload for synthesis endpoint', () => {
    assert.equal(validateSynthesisRequest({ minNodes: 2 }).valid, false);
    assert.equal(validateSynthesisRequest({ tags: [] }).valid, false);
    assert.equal(validateSynthesisRequest({ tags: ['sync'], minNodes: 0 }).valid, false);
    assert.deepEqual(validateSynthesisRequest({ tags: 'sync,network' }), {
      valid: true,
      tags: ['sync', 'network'],
    });
  });
});
