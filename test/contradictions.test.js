'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { detectContradictions } = require('../lib/contradictions');
const { listContradictions } = require('../bin/myr');

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE myr_reports (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      yield_type TEXT NOT NULL,
      domain_tags TEXT NOT NULL,
      question_answered TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function seedContradictingYields(db) {
  const insert = db.prepare(`
    INSERT INTO myr_reports (
      id, node_id, yield_type, domain_tags, question_answered, confidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    'yield-obs-high',
    'node-a',
    'insight',
    JSON.stringify(['rag', 'retrieval']),
    'Does retrieval reranking improve answer quality?',
    0.92,
    '2026-04-16T10:00:00Z'
  );

  insert.run(
    'yield-falsify',
    'node-b',
    'falsification',
    JSON.stringify(['rag', 'evaluation']),
    'Does retrieval reranking improve answer quality?',
    0.81,
    '2026-04-16T10:05:00Z'
  );

  insert.run(
    'yield-obs-low',
    'node-c',
    'insight',
    JSON.stringify(['rag']),
    'Does retrieval reranking improve answer quality?',
    0.12,
    '2026-04-16T10:10:00Z'
  );
}

describe('detectContradictions', () => {
  let db;

  before(() => {
    db = createTestDb();
    seedContradictingYields(db);
  });

  after(() => db.close());

  it('stores contradiction pairs and returns observation/falsification + opposing confidence', () => {
    const result = detectContradictions(db, { domain: 'rag' });

    assert.equal(result.scannedReports, 3);
    assert.ok(result.detectedCount >= 2);
    assert.ok(result.contradictions.some((c) => c.contradiction_type === 'observation_vs_falsification'));
    assert.ok(result.contradictions.some((c) => c.contradiction_type === 'opposing_confidence'));

    const stored = db.prepare('SELECT * FROM myr_contradictions ORDER BY id ASC').all();
    assert.ok(stored.length >= 2);
    assert.ok(stored.every((row) => row.yield_a_id && row.yield_b_id));
  });
});

describe('GET /myr/contradictions', () => {
  let db;
  let server;
  let port;

  before(() => {
    db = createTestDb();
    seedContradictingYields(db);
    const app = createApp({
      config: {
        node_id: 'test-node',
        node_name: 'Test Node',
        operator_name: 'test-operator',
        node_url: 'http://localhost:0',
        port: 0,
      },
      db,
      publicKeyHex: 'ab'.repeat(32),
      privateKeyHex: 'cd'.repeat(32),
      createdAt: '2026-04-16T00:00:00Z',
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('returns detected contradictions for a domain', async () => {
    const res = await get(port, '/myr/contradictions?domain=rag');
    assert.equal(res.status, 200);
    assert.equal(res.body.domain, 'rag');
    assert.equal(res.body.scanned_reports, 3);
    assert.ok(Array.isArray(res.body.contradictions));
    assert.ok(res.body.contradictions.length >= 1);
  });
});

describe('listContradictions (CLI business function)', () => {
  let db;

  before(() => {
    db = createTestDb();
    seedContradictingYields(db);
  });

  after(() => db.close());

  it('returns contradiction scan results usable by the CLI command', () => {
    const result = listContradictions({ db, domain: 'rag' });
    assert.equal(result.scannedReports, 3);
    assert.ok(result.contradictions.length >= 1);
  });
});
