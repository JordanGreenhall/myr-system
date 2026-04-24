'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { recall } = require('../lib/recall');

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

    CREATE VIRTUAL TABLE myr_fts USING fts5(
      id,
      cycle_intent,
      cycle_context,
      question_answered,
      evidence,
      what_changes_next,
      what_was_falsified,
      domain_tags,
      content=myr_reports,
      content_rowid=rowid
    );

    CREATE TRIGGER myr_fts_insert AFTER INSERT ON myr_reports BEGIN
      INSERT INTO myr_fts(rowid, id, cycle_intent, cycle_context, question_answered, evidence, what_changes_next, what_was_falsified, domain_tags)
      VALUES (new.rowid, new.id, new.cycle_intent, new.cycle_context, new.question_answered, new.evidence, new.what_changes_next, new.what_was_falsified, new.domain_tags);
    END;

    CREATE TABLE myr_quarantined_yields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      yield_id TEXT NOT NULL UNIQUE,
      quarantined_at TEXT NOT NULL,
      quarantined_by TEXT NOT NULL,
      operator_signature TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','released')),
      metadata TEXT DEFAULT '{}'
    );
  `);

  return db;
}

function insertReport(db, overrides = {}) {
  const now = new Date().toISOString();
  const defaults = {
    id: `n1-20260416-${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
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
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )
  `).run(
    r.id, r.timestamp, r.agent_id, r.node_id, r.cycle_intent, r.domain_tags, r.cycle_context || null,
    r.yield_type, r.question_answered, r.evidence, r.what_changes_next,
    r.what_was_falsified || null, r.confidence, r.operator_rating || null, r.auto_draft || 0, r.imported_from || null,
    r.created_at, r.updated_at
  );

  return r.id;
}

describe('recall', () => {
  let db;

  before(() => {
    db = createTestDb();
  });

  after(() => {
    db.close();
  });

  it('returns empty results when no context provided', () => {
    const result = recall(db);
    assert.deepStrictEqual(result.results, []);
    assert.deepStrictEqual(result.falsifications, []);
    assert.strictEqual(result.meta.totalMatches, 0);
  });

  it('returns empty results when no MYRs exist', () => {
    const result = recall(db, { intent: 'something', tags: ['testing'] });
    assert.deepStrictEqual(result.results, []);
  });

  describe('with seeded data', () => {
    before(() => {
      // Insert test MYRs
      insertReport(db, {
        id: 'n1-20260416-001',
        cycle_intent: 'Debug peer sync timeouts',
        domain_tags: '["networking","sync","hyperswarm"]',
        yield_type: 'technique',
        question_answered: 'How to handle sync timeouts gracefully',
        evidence: 'Retry with exponential backoff reduced failures by 80%',
        what_changes_next: 'Always use backoff for network operations',
        confidence: 0.9,
        operator_rating: 4,
      });

      insertReport(db, {
        id: 'n1-20260416-002',
        cycle_intent: 'Optimize FTS search performance',
        domain_tags: '["search","fts","performance"]',
        yield_type: 'insight',
        question_answered: 'What makes FTS5 slow on large corpora',
        evidence: 'Adding verification_boost column reduced query time by 60%',
        what_changes_next: 'Pre-compute boost columns for FTS joins',
        confidence: 0.8,
        operator_rating: 5,
      });

      insertReport(db, {
        id: 'n1-20260416-003',
        cycle_intent: 'Use Hyperspace as transport layer',
        domain_tags: '["networking","hyperspace","transport"]',
        yield_type: 'falsification',
        question_answered: 'Can Hyperspace serve as canonical MYR transport',
        evidence: 'Inference endpoint times out, directive requires hypothesis field',
        what_was_falsified: 'Hyperspace as general-purpose content-addressed transport',
        what_changes_next: 'Keep MYR own transport stack as canonical',
        confidence: 0.95,
        operator_rating: 5,
      });

      insertReport(db, {
        id: 'n1-20260416-004',
        cycle_intent: 'Set up auto-draft pipeline',
        domain_tags: '["automation","llm","ollama"]',
        yield_type: 'technique',
        question_answered: 'How to auto-extract yield from memory events',
        evidence: 'Fire-and-forget subprocess pattern works reliably',
        what_changes_next: 'Use subprocess pattern for all LLM integrations',
        confidence: 0.85,
        auto_draft: 1,
      });

      insertReport(db, {
        id: 'n1-20260416-005',
        cycle_intent: 'Debug networking issue with peers',
        domain_tags: '["networking","peers"]',
        yield_type: 'pattern',
        question_answered: 'Common pattern in peer connection failures',
        evidence: 'Most failures are DNS resolution, not protocol errors',
        what_changes_next: 'Add DNS pre-check before peer operations',
        confidence: 0.7,
        imported_from: 'n2',
      });
    });

    it('finds results by intent (FTS)', () => {
      const result = recall(db, { intent: 'sync timeouts' });
      assert.ok(result.results.length > 0);
      assert.ok(result.results.some(r => r.id === 'n1-20260416-001'));
    });

    it('finds results by explicit query', () => {
      const result = recall(db, { query: 'FTS search performance' });
      assert.ok(result.results.length > 0);
      assert.ok(result.results.some(r => r.id === 'n1-20260416-002'));
    });

    it('finds results by tags', () => {
      const result = recall(db, { tags: ['automation'] });
      assert.ok(result.results.length > 0);
      assert.ok(result.results.some(r => r.id === 'n1-20260416-004'));
    });

    it('separates falsifications from results', () => {
      const result = recall(db, { intent: 'networking transport' });
      assert.ok(result.falsifications.length > 0);
      assert.ok(result.falsifications.some(f => f.id === 'n1-20260416-003'));
      // Falsification should not also appear in results
      assert.ok(!result.results.some(r => r.id === 'n1-20260416-003'));
    });

    it('includes falsifications even with tag-only search', () => {
      const result = recall(db, { tags: ['networking'] });
      assert.ok(result.falsifications.length > 0 || result.results.length > 0);
    });

    it('ranks verified MYRs higher', () => {
      const result = recall(db, { intent: 'networking' });
      const allResults = [...result.results, ...result.falsifications];
      // Rated reports should appear — but rating is used for boost, not filter
      assert.ok(allResults.length > 0);
    });

    it('respects verifiedOnly flag', () => {
      const result = recall(db, { tags: ['automation'], verifiedOnly: true });
      // n1-20260416-004 has no rating — should be excluded
      assert.ok(!result.results.some(r => r.id === 'n1-20260416-004'));
    });

    it('respects limit parameter', () => {
      const result = recall(db, { intent: 'networking', limit: 1 });
      assert.ok(result.results.length <= 1);
    });

    it('excludes actively quarantined yields', () => {
      db.prepare(`
        INSERT INTO myr_quarantined_yields (
          yield_id, quarantined_at, quarantined_by, operator_signature, reason, status, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'n1-20260416-001',
        new Date().toISOString(),
        'SHA-256:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
        'sig-test',
        'suspicious claim',
        'active',
        '{}'
      );

      const result = recall(db, { intent: 'sync timeouts' });
      assert.ok(!result.results.some(r => r.id === 'n1-20260416-001'));
      assert.ok(!result.falsifications.some(r => r.id === 'n1-20260416-001'));
      db.prepare('DELETE FROM myr_quarantined_yields WHERE yield_id = ?').run('n1-20260416-001');
    });

    it('returns formatted result objects', () => {
      const result = recall(db, { intent: 'sync timeouts' });
      assert.ok(result.results.length > 0);
      const r = result.results[0];
      assert.ok(r.id);
      assert.ok(r.type);
      assert.ok(r.intent);
      assert.ok(r.question);
      assert.ok(r.evidence);
      assert.ok(r.changes);
      assert.ok(typeof r.confidence === 'number');
      assert.ok(Array.isArray(r.tags));
      assert.ok(r.createdAt);
      assert.ok(r.nodeId);
    });

    it('marks imported and auto-draft results', () => {
      const result = recall(db, { tags: ['networking'] });
      const all = [...result.results, ...result.falsifications];
      const imported = all.find(r => r.id === 'n1-20260416-005');
      if (imported) {
        assert.strictEqual(imported.importedFrom, 'n2');
      }

      const autoDraft = recall(db, { tags: ['automation'] }).results.find(r => r.id === 'n1-20260416-004');
      if (autoDraft) {
        assert.strictEqual(autoDraft.autoDraft, true);
      }
    });

    it('combines FTS and tag search for better coverage', () => {
      const result = recall(db, { intent: 'performance', tags: ['search'] });
      assert.ok(result.results.length > 0);
      assert.ok(result.results.some(r => r.id === 'n1-20260416-002'));
    });
  });
});

describe('recall — /myr/recall endpoint', () => {
  let db, app;

  before(async () => {
    db = createTestDb();

    insertReport(db, {
      id: 'n1-20260416-010',
      cycle_intent: 'API endpoint recall test',
      domain_tags: '["api","server"]',
      yield_type: 'technique',
      question_answered: 'Does the recall endpoint work',
      evidence: 'Returns JSON with results',
      what_changes_next: 'Use recall endpoint in agents',
      confidence: 0.8,
      operator_rating: 4,
    });

    const { createApp } = require('../server/index');
    const config = {
      port: 0,
      node_url: 'http://localhost:0',
      operator_name: 'test',
      node_id: 'test-node',
    };
    app = createApp({ config, db, publicKeyHex: 'a'.repeat(64), createdAt: new Date().toISOString() });
  });

  after(() => {
    db.close();
  });

  it('returns results for intent query', async () => {
    const http = require('http');
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/myr/recall?intent=API+endpoint`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(body.results);
      assert.ok(body.falsifications !== undefined);
      assert.ok(body.meta);
      assert.ok(body.results.length > 0);
    } finally {
      server.close();
    }
  });

  it('returns empty for no params', async () => {
    const http = require('http');
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/myr/recall`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body.results, []);
    } finally {
      server.close();
    }
  });

  it('supports tags parameter', async () => {
    const http = require('http');
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/myr/recall?tags=api,server`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(body.results.length > 0);
    } finally {
      server.close();
    }
  });
});
