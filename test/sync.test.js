'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { generateKeypair, sign } = require('../lib/crypto');
const { canonicalize } = require('../lib/canonicalize');
const { syncPeer, cleanupNonces } = require('../lib/sync');

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
      yield_type TEXT NOT NULL,
      question_answered TEXT NOT NULL,
      evidence TEXT NOT NULL,
      what_changes_next TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.7,
      operator_rating INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      share_network INTEGER DEFAULT 0,
      imported_from TEXT,
      import_verified INTEGER DEFAULT 0,
      signed_artifact TEXT
    );

    CREATE TABLE myr_peers (
      id INTEGER PRIMARY KEY,
      peer_url TEXT UNIQUE NOT NULL,
      operator_name TEXT NOT NULL,
      public_key TEXT UNIQUE NOT NULL,
      trust_level TEXT CHECK(trust_level IN ('trusted', 'pending', 'introduced', 'revoked', 'rejected')) DEFAULT 'pending',
      added_at TEXT NOT NULL,
      approved_at TEXT,
      last_sync_at TEXT,
      auto_sync INTEGER DEFAULT 1,
      notes TEXT
    );

    CREATE TABLE myr_nonces (
      nonce TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX idx_nonces_expires ON myr_nonces(expires_at);
  `);

  return db;
}

function createSignedReport(overrides, signingKey) {
  const report = {
    id: 'test-' + crypto.randomBytes(4).toString('hex'),
    timestamp: '2026-03-01T10:00:00Z',
    agent_id: 'test-agent',
    node_id: 'test-node',
    session_ref: null,
    cycle_intent: 'test method',
    domain_tags: 'testing',
    yield_type: 'technique',
    question_answered: 'does it work?',
    evidence: 'evidence here',
    what_changes_next: 'next steps',
    confidence: 0.8,
    operator_rating: 3,
    created_at: '2026-03-01T10:00:00Z',
    updated_at: '2026-03-01T10:00:00Z',
    share_network: 1,
    ...overrides,
  };

  const canonical = canonicalize(report);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  report.signature = 'sha256:' + hash;

  if (signingKey) {
    report.operator_signature = sign(canonical, signingKey);
  }

  return report;
}

function createMockFetch(reports, options = {}) {
  const calls = [];

  const fn = async (url, reqOptions) => {
    calls.push({ url, options: reqOptions });

    if (options.networkError) {
      throw new Error('Connection refused');
    }

    // Report listing
    if (url.match(/\/myr\/reports(\?|$)/) && !url.match(/\/myr\/reports\/sha256:/)) {
      if (options.return403) {
        return {
          status: 403,
          body: { error: { code: 'peer_not_trusted', message: "Peer relationship exists but trust_level != 'trusted'" } },
          rawBody: '{"error":{"code":"peer_not_trusted"}}',
          headers: {},
        };
      }

      const urlObj = new URL(url, 'http://localhost');
      const since = urlObj.searchParams.get('since');

      let filtered = reports;
      if (since) {
        filtered = reports.filter((r) => r.created_at > since);
      }

      const listing = filtered.map((r) => ({
        signature: r.signature,
        operator_name: 'testpeer',
        created_at: r.created_at,
        method_name: r.cycle_intent,
        operator_rating: r.operator_rating,
        size_bytes: 1000,
        url: '/myr/reports/' + r.signature,
      }));

      const body = { reports: listing, total: listing.length, since };
      return { status: 200, body, rawBody: JSON.stringify(body), headers: {} };
    }

    // Single report fetch
    if (url.includes('/myr/reports/sha256:')) {
      const sig = decodeURIComponent(url.split('/myr/reports/')[1].split('?')[0]);
      const report = reports.find((r) => r.signature === sig);
      if (!report) {
        return { status: 404, body: { error: { code: 'report_not_found' } }, rawBody: '{}', headers: {} };
      }
      const body = JSON.stringify(report);
      return { status: 200, body: report, rawBody: body, headers: {} };
    }

    return { status: 404, body: {}, rawBody: '{}', headers: {} };
  };

  fn.calls = calls;
  return fn;
}

// ---------- syncPeer ----------

describe('syncPeer (lib/sync)', () => {
  const peerKeys = generateKeypair();
  const ourKeys = generateKeypair();

  it('imports new reports from trusted peer', async () => {
    const db = createTestDb();
    const r1 = createSignedReport({ id: 'r1', created_at: '2026-03-01T10:00:00Z' }, peerKeys.privateKey);
    const r2 = createSignedReport({ id: 'r2', created_at: '2026-03-01T11:00:00Z', cycle_intent: 'second method' }, peerKeys.privateKey);
    const mockFetch = createMockFetch([r1, r2]);

    const peer = {
      peer_url: 'http://localhost:9999',
      operator_name: 'testpeer',
      public_key: peerKeys.publicKey,
      last_sync_at: null,
    };
    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run(peer.peer_url, peer.operator_name, peer.public_key, 'trusted', '2026-03-01T00:00:00Z');

    const result = await syncPeer({ db, peer, keys: ourKeys, fetch: mockFetch });

    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.failed, 0);

    const reports = db.prepare('SELECT * FROM myr_reports ORDER BY id').all();
    assert.equal(reports.length, 2);
    assert.equal(reports[0].id, 'r1');
    assert.equal(reports[0].imported_from, 'testpeer');
    assert.equal(reports[0].import_verified, 1);
    assert.equal(reports[0].share_network, 0);
    assert.ok(reports[0].signed_artifact.startsWith('sha256:'));
    assert.equal(reports[1].id, 'r2');

    db.close();
  });

  it('skips existing reports (dedup by signature)', async () => {
    const db = createTestDb();
    const r1 = createSignedReport({ id: 'r1', created_at: '2026-03-01T10:00:00Z' }, peerKeys.privateKey);

    // Pre-import r1 with its signature stored in signed_artifact
    db.prepare(`
      INSERT INTO myr_reports (id, timestamp, agent_id, node_id, cycle_intent, domain_tags,
        yield_type, question_answered, evidence, what_changes_next, confidence,
        created_at, updated_at, share_network, signed_artifact)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('r1', r1.timestamp, r1.agent_id, r1.node_id, r1.cycle_intent, r1.domain_tags,
      r1.yield_type, r1.question_answered, r1.evidence, r1.what_changes_next, r1.confidence,
      r1.created_at, r1.updated_at, 0, r1.signature);

    const mockFetch = createMockFetch([r1]);

    const peer = {
      peer_url: 'http://localhost:9999',
      operator_name: 'testpeer',
      public_key: peerKeys.publicKey,
      last_sync_at: null,
    };
    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run(peer.peer_url, peer.operator_name, peer.public_key, 'trusted', '2026-03-01T00:00:00Z');

    const result = await syncPeer({ db, peer, keys: ourKeys, fetch: mockFetch });

    assert.equal(result.imported, 0);
    assert.equal(result.skipped, 1);

    // Should not have fetched the individual report (skipped at listing stage)
    const reportFetches = mockFetch.calls.filter((c) => c.url.includes('/myr/reports/sha256:'));
    assert.equal(reportFetches.length, 0);

    db.close();
  });

  it('verifies report signatures and rejects invalid', async () => {
    const db = createTestDb();
    const wrongKeys = generateKeypair();

    // Sign with wrong key — should fail verification
    const badReport = createSignedReport({ id: 'bad1', created_at: '2026-03-01T10:00:00Z' }, wrongKeys.privateKey);

    const mockFetch = createMockFetch([badReport]);

    const peer = {
      peer_url: 'http://localhost:9999',
      operator_name: 'testpeer',
      public_key: peerKeys.publicKey,
      last_sync_at: null,
    };
    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run(peer.peer_url, peer.operator_name, peer.public_key, 'trusted', '2026-03-01T00:00:00Z');

    const result = await syncPeer({ db, peer, keys: ourKeys, fetch: mockFetch });

    assert.equal(result.imported, 0);
    assert.equal(result.failed, 1);

    const reports = db.prepare('SELECT * FROM myr_reports').all();
    assert.equal(reports.length, 0);

    db.close();
  });

  it('updates last_sync_at after sync', async () => {
    const db = createTestDb();
    const r1 = createSignedReport({ id: 'r1', created_at: '2026-03-01T10:00:00Z' }, peerKeys.privateKey);
    const mockFetch = createMockFetch([r1]);

    const peer = {
      peer_url: 'http://localhost:9999',
      operator_name: 'testpeer',
      public_key: peerKeys.publicKey,
      last_sync_at: null,
    };
    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run(peer.peer_url, peer.operator_name, peer.public_key, 'trusted', '2026-03-01T00:00:00Z');

    const beforeSync = new Date().toISOString();
    await syncPeer({ db, peer, keys: ourKeys, fetch: mockFetch });

    const updatedPeer = db.prepare('SELECT last_sync_at FROM myr_peers WHERE public_key = ?').get(peerKeys.publicKey);
    assert.ok(updatedPeer.last_sync_at);
    assert.ok(updatedPeer.last_sync_at >= beforeSync);

    db.close();
  });

  it('uses since parameter for incremental sync', async () => {
    const db = createTestDb();
    const r1 = createSignedReport({ id: 'r1', created_at: '2026-03-02T10:00:00Z' }, peerKeys.privateKey);
    const mockFetch = createMockFetch([r1]);

    const lastSyncAt = '2026-03-01T12:00:00Z';
    const peer = {
      peer_url: 'http://localhost:9999',
      operator_name: 'testpeer',
      public_key: peerKeys.publicKey,
      last_sync_at: lastSyncAt,
    };
    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, last_sync_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(peer.peer_url, peer.operator_name, peer.public_key, 'trusted', '2026-03-01T00:00:00Z', lastSyncAt);

    await syncPeer({ db, peer, keys: ourKeys, fetch: mockFetch });

    // Verify the listing request included the since parameter
    const listCall = mockFetch.calls.find((c) =>
      c.url.match(/\/myr\/reports\?/) && !c.url.includes('/myr/reports/sha256:')
    );
    assert.ok(listCall, 'should have made a list request');
    assert.ok(listCall.url.includes('since='), 'URL should contain since parameter');
    assert.ok(listCall.url.includes(encodeURIComponent(lastSyncAt)), 'since should match last_sync_at');

    db.close();
  });

  it('handles 403 peer_not_trusted gracefully', async () => {
    const db = createTestDb();
    const mockFetch = createMockFetch([], { return403: true });

    const peer = {
      peer_url: 'http://localhost:9999',
      operator_name: 'testpeer',
      public_key: peerKeys.publicKey,
      last_sync_at: null,
    };
    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run(peer.peer_url, peer.operator_name, peer.public_key, 'trusted', '2026-03-01T00:00:00Z');

    const result = await syncPeer({ db, peer, keys: ourKeys, fetch: mockFetch });

    assert.equal(result.peerNotTrusted, true);
    assert.equal(result.imported, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.failed, 0);

    db.close();
  });

  it('handles network errors gracefully', async () => {
    const db = createTestDb();
    const mockFetch = createMockFetch([], { networkError: true });

    const peer = {
      peer_url: 'http://localhost:9999',
      operator_name: 'testpeer',
      public_key: peerKeys.publicKey,
      last_sync_at: null,
    };
    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run(peer.peer_url, peer.operator_name, peer.public_key, 'trusted', '2026-03-01T00:00:00Z');

    await assert.rejects(
      () => syncPeer({ db, peer, keys: ourKeys, fetch: mockFetch }),
      /Network error/
    );

    db.close();
  });
});

// ---------- cleanupNonces ----------

describe('cleanupNonces', () => {
  it('removes expired nonces and keeps valid ones', () => {
    const db = createTestDb();

    const now = new Date();
    const expired = new Date(now.getTime() - 60000).toISOString();
    const future = new Date(now.getTime() + 600000).toISOString();

    db.prepare('INSERT INTO myr_nonces (nonce, seen_at, expires_at) VALUES (?, ?, ?)')
      .run('expired-nonce', expired, expired);
    db.prepare('INSERT INTO myr_nonces (nonce, seen_at, expires_at) VALUES (?, ?, ?)')
      .run('valid-nonce', now.toISOString(), future);

    const result = cleanupNonces(db);
    assert.equal(result.changes, 1);

    const remaining = db.prepare('SELECT * FROM myr_nonces').all();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].nonce, 'valid-nonce');

    db.close();
  });
});
