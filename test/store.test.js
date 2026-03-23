'use strict';

/**
 * Layer 2 persistence tests (MYR v1.0 spec, STA-46)
 *
 * Covers all five required unit test cases:
 * 1. Trace written for each operation type
 * 2. Report import rejects tampered/unsigned reports with trace entry
 * 3. Report deduplication: importing same signature twice = one record
 * 4. Nonce table expires correctly
 * 5. Path resolution: all SQLite paths use os.homedir() not hard-coded paths
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { canonicalize } = require('../lib/canonicalize');

const {
  ensureV1Schema,
  writeTrace,
  upsertPeer,
  approvePeer,
  revokePeer,
  getPeer,
  getPeerByPublicKey,
  listPeers,
  updateSyncCursor,
  importReport,
  cleanExpiredNonces,
  hasNonce,
  storeNonce,
} = require('../lib/store');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureV1Schema(db);
  return db;
}

/** Build a valid network report with a correct sha256 signature. */
function makeReport(overrides = {}) {
  const base = {
    operator_name: 'test-operator',
    created_at: '2026-03-23T10:00:00.000Z',
    updated_at: '2026-03-23T10:00:00.000Z',
    week_label: '2026-W12',
    content_body: 'test content',
    ...overrides,
  };
  // Remove signature if present in overrides before computing hash
  const { signature: _ignored, ...rest } = base;
  const canonical = canonicalize(rest);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  return { ...base, signature: `sha256:${hash}` };
}

/** Build a minimal peer identity document. */
function makePeerDoc(overrides = {}) {
  const fp = crypto.randomBytes(16).toString('hex');
  const pubKey = crypto.randomBytes(32).toString('hex');
  return {
    fingerprint: fp,
    public_key: pubKey,
    node_url: 'https://test.myr.network',
    operator_name: 'test-peer',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Trace written for each operation type
// ---------------------------------------------------------------------------

describe('writeTrace — all event types produce trace records', () => {
  const db = makeDb();
  const fp = 'aaaa1111';
  const target = 'bbbb2222';

  const eventTypes = [
    'introduce',
    'approve',
    'share',
    'sync_pull',
    'sync_push',
    'verify',
    'reject',
  ];

  for (const event_type of eventTypes) {
    it(`writes a trace for event_type=${event_type}`, () => {
      const traceId = writeTrace(db, {
        event_type,
        actor_fingerprint: fp,
        target_fingerprint: target,
        outcome: event_type === 'reject' ? 'rejected' : 'success',
      });

      assert.ok(typeof traceId === 'string' && traceId.length > 0,
        'should return a trace_id');

      const row = db.prepare(
        'SELECT * FROM myr_traces WHERE trace_id = ?',
      ).get(traceId);

      assert.ok(row, 'trace row should exist');
      assert.equal(row.event_type, event_type);
      assert.equal(row.actor_fingerprint, fp);
      assert.equal(row.target_fingerprint, target);
      assert.ok(row.timestamp, 'timestamp should be set');
    });
  }

  it('stores metadata as JSON', () => {
    const traceId = writeTrace(db, {
      event_type: 'verify',
      actor_fingerprint: fp,
      outcome: 'success',
      metadata: { reports_count: 3, peer: 'node-b' },
    });
    const row = db.prepare('SELECT metadata FROM myr_traces WHERE trace_id=?').get(traceId);
    assert.deepEqual(JSON.parse(row.metadata), { reports_count: 3, peer: 'node-b' });
  });

  it('stores rejection_reason', () => {
    const traceId = writeTrace(db, {
      event_type: 'reject',
      actor_fingerprint: fp,
      outcome: 'rejected',
      rejection_reason: 'bad signature',
    });
    const row = db.prepare('SELECT rejection_reason FROM myr_traces WHERE trace_id=?').get(traceId);
    assert.equal(row.rejection_reason, 'bad signature');
  });
});

// ---------------------------------------------------------------------------
// 2. Report import rejects tampered/unsigned reports with trace entry
// ---------------------------------------------------------------------------

describe('importReport — rejection writes trace and returns false', () => {
  const db = makeDb();
  const sourceFp = 'source-fp-001';

  it('rejects report with no signature', () => {
    const doc = { operator_name: 'test', created_at: '2026-01-01T00:00:00Z' };
    const result = importReport(db, doc, sourceFp);
    assert.equal(result, false);

    const traces = db.prepare(
      "SELECT * FROM myr_traces WHERE event_type='reject' AND actor_fingerprint=?",
    ).all(sourceFp);
    assert.ok(traces.length > 0, 'should write a reject trace');
    assert.ok(traces.some(t => t.rejection_reason.includes('signature')));
  });

  it('rejects report with signature in wrong format (no sha256: prefix)', () => {
    const doc = { operator_name: 'test', signature: 'abc123' };
    const result = importReport(db, doc, sourceFp);
    assert.equal(result, false);
  });

  it('rejects a tampered report (signature does not match content)', () => {
    const valid = makeReport();
    const tampered = { ...valid, operator_name: 'attacker' };
    const result = importReport(db, tampered, sourceFp);
    assert.equal(result, false);

    const traces = db.prepare(
      "SELECT * FROM myr_traces WHERE event_type='reject' AND artifact_signature=?",
    ).all(valid.signature);
    assert.ok(traces.length > 0, 'should write reject trace with signature');
    assert.ok(
      traces.some(t => t.rejection_reason.includes('sha256')),
      'rejection reason should mention sha256',
    );
  });

  it('rejects null/undefined/non-object input', () => {
    assert.equal(importReport(db, null, sourceFp), false);
    assert.equal(importReport(db, undefined, sourceFp), false);
    assert.equal(importReport(db, 'string', sourceFp), false);
  });

  it('accepts a valid report and writes a share trace', () => {
    const doc = makeReport({ operator_name: 'honest-operator' });
    const result = importReport(db, doc, sourceFp);
    assert.equal(result, true);

    const sharTrace = db.prepare(
      "SELECT * FROM myr_traces WHERE event_type='share' AND artifact_signature=?",
    ).get(doc.signature);
    assert.ok(sharTrace, 'should write a share trace on success');
    assert.equal(sharTrace.outcome, 'success');
  });
});

// ---------------------------------------------------------------------------
// 3. Report deduplication: importing same signature twice = one record
// ---------------------------------------------------------------------------

describe('importReport — deduplication (idempotency)', () => {
  const db = makeDb();
  const sourceFp = 'source-fp-002';

  it('first import stores the record', () => {
    const doc = makeReport({ week_label: '2026-W01' });
    const first = importReport(db, doc, sourceFp);
    assert.equal(first, true);

    const count = db.prepare(
      'SELECT COUNT(*) as n FROM myr_network_reports WHERE signature=?',
    ).get(doc.signature).n;
    assert.equal(count, 1);
  });

  it('second import of same signature does not error and still has one record', () => {
    const doc = makeReport({ week_label: '2026-W01' });

    // Import twice
    importReport(db, doc, sourceFp);
    importReport(db, doc, sourceFp);

    const count = db.prepare(
      'SELECT COUNT(*) as n FROM myr_network_reports WHERE signature=?',
    ).get(doc.signature).n;
    assert.equal(count, 1, 'should still be exactly one record after duplicate import');
  });

  it('different reports produce separate records', () => {
    const doc1 = makeReport({ content_body: 'report alpha', week_label: '2026-W02' });
    const doc2 = makeReport({ content_body: 'report beta', week_label: '2026-W03' });

    importReport(db, doc1, sourceFp);
    importReport(db, doc2, sourceFp);

    assert.notEqual(doc1.signature, doc2.signature);

    const count = db.prepare(
      'SELECT COUNT(*) as n FROM myr_network_reports WHERE source_fingerprint=?',
    ).get(sourceFp).n;
    assert.ok(count >= 2);
  });
});

// ---------------------------------------------------------------------------
// 4. Nonce table expires correctly
// ---------------------------------------------------------------------------

describe('nonce management', () => {
  const db = makeDb();

  it('storeNonce + hasNonce round-trip', () => {
    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    assert.equal(hasNonce(db, nonce), false, 'nonce should not exist yet');
    storeNonce(db, nonce, expiresAt);
    assert.equal(hasNonce(db, nonce), true, 'nonce should be stored');
  });

  it('cleanExpiredNonces removes expired nonces', () => {
    const expiredNonce = crypto.randomBytes(32).toString('hex');
    const activeNonce = crypto.randomBytes(32).toString('hex');

    // Expired: 1 hour ago
    const pastExpiry = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    // Active: 10 minutes from now
    const futureExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    storeNonce(db, expiredNonce, pastExpiry);
    storeNonce(db, activeNonce, futureExpiry);

    assert.equal(hasNonce(db, expiredNonce), true);
    assert.equal(hasNonce(db, activeNonce), true);

    cleanExpiredNonces(db);

    assert.equal(hasNonce(db, expiredNonce), false, 'expired nonce should be removed');
    assert.equal(hasNonce(db, activeNonce), true, 'active nonce should remain');
  });

  it('cleanExpiredNonces is safe to call on empty table', () => {
    const freshDb = makeDb();
    assert.doesNotThrow(() => cleanExpiredNonces(freshDb));
  });
});

// ---------------------------------------------------------------------------
// 5. Path resolution: os.homedir(), no hard-coded paths in source
// ---------------------------------------------------------------------------

describe('path resolution — portable, no hard-coded paths', () => {
  it('lib/store.js source file contains no hard-coded home directory', () => {
    const fs = require('fs');
    const sourcePath = require.resolve('../lib/store');
    const source = fs.readFileSync(sourcePath, 'utf8');

    // Check for any hard-coded Unix home path patterns
    assert.ok(
      !(/\/Users\/[a-zA-Z]+\//.test(source)),
      'source must not contain /Users/<username>/',
    );
    assert.ok(
      !(/\/home\/[a-zA-Z]+\//.test(source)),
      'source must not contain /home/<username>/',
    );
  });

  it('SQLite path uses os.homedir() via config, not a literal string', () => {
    // The store module itself doesn't open a DB — it receives an already-open
    // db connection. The path resolution responsibility belongs to the caller
    // (home-config.js / home-db.js). Verify home-db.js resolves via os.homedir().
    const homeConfigSrc = require('fs').readFileSync(
      require.resolve('../lib/home-config'),
      'utf8',
    );
    assert.ok(
      homeConfigSrc.includes('os.homedir()'),
      'home-config must use os.homedir() for path resolution',
    );
    assert.ok(
      !(/\/Users\/[a-zA-Z]+\//.test(homeConfigSrc)),
      'home-config must not contain hard-coded /Users/<username>/',
    );
  });
});

// ---------------------------------------------------------------------------
// Peer management
// ---------------------------------------------------------------------------

describe('peer management', () => {
  const db = makeDb();

  it('upsertPeer creates a new peer with introduced trust_level', () => {
    const peer = makePeerDoc();
    const created = upsertPeer(db, peer);
    assert.equal(created, true);

    const row = getPeer(db, peer.fingerprint);
    assert.ok(row, 'peer should be found');
    assert.equal(row.trust_level, 'introduced');
    assert.equal(row.public_key, peer.public_key);
    assert.equal(row.node_url, peer.node_url);
    assert.ok(row.introduced_at);
  });

  it('upsertPeer on existing peer updates URL/name but preserves trust_level', () => {
    const peer = makePeerDoc();
    upsertPeer(db, peer);
    approvePeer(db, peer.fingerprint); // set to trusted

    // Re-introduce with updated URL
    upsertPeer(db, { ...peer, node_url: 'https://new-url.myr.network' });

    const row = getPeer(db, peer.fingerprint);
    assert.equal(row.trust_level, 'trusted', 'trust_level should be preserved');
    assert.equal(row.node_url, 'https://new-url.myr.network', 'URL should be updated');
  });

  it('approvePeer sets trust_level=trusted and records approved_at', () => {
    const peer = makePeerDoc();
    upsertPeer(db, peer);

    approvePeer(db, peer.fingerprint);

    const row = getPeer(db, peer.fingerprint);
    assert.equal(row.trust_level, 'trusted');
    assert.ok(row.approved_at, 'approved_at should be set');
  });

  it('revokePeer sets trust_level=revoked', () => {
    const peer = makePeerDoc();
    upsertPeer(db, peer);
    revokePeer(db, peer.fingerprint);

    const row = getPeer(db, peer.fingerprint);
    assert.equal(row.trust_level, 'revoked');
  });

  it('getPeerByPublicKey finds peer by hex public key', () => {
    const peer = makePeerDoc();
    upsertPeer(db, peer);

    const found = getPeerByPublicKey(db, peer.public_key);
    assert.ok(found);
    assert.equal(found.fingerprint, peer.fingerprint);
  });

  it('getPeer returns null for unknown fingerprint', () => {
    assert.equal(getPeer(db, 'nonexistent-fp'), null);
  });

  it('listPeers returns all peers ordered by introduced_at', () => {
    const freshDb = makeDb();
    const p1 = makePeerDoc();
    const p2 = makePeerDoc();
    upsertPeer(freshDb, p1);
    upsertPeer(freshDb, p2);

    const peers = listPeers(freshDb);
    assert.equal(peers.length, 2);
    // Both introduced_at timestamps should be valid ISO strings
    for (const p of peers) {
      assert.ok(new Date(p.introduced_at).getTime() > 0);
    }
  });

  it('updateSyncCursor sets last_sync_at for a peer', () => {
    const peer = makePeerDoc();
    upsertPeer(db, peer);

    const ts = '2026-03-23T15:00:00.000Z';
    updateSyncCursor(db, peer.fingerprint, ts);

    const row = getPeer(db, peer.fingerprint);
    assert.equal(row.last_sync_at, ts);
  });
});

// ---------------------------------------------------------------------------
// ensureV1Schema is idempotent
// ---------------------------------------------------------------------------

describe('ensureV1Schema', () => {
  it('is safe to call multiple times on the same db', () => {
    const db = makeDb();
    assert.doesNotThrow(() => {
      ensureV1Schema(db);
      ensureV1Schema(db);
      ensureV1Schema(db);
    });
  });

  it('creates all required tables', () => {
    const db = makeDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all().map(r => r.name);

    assert.ok(tables.includes('myr_traces'), 'myr_traces table missing');
    assert.ok(tables.includes('myr_v1_peers'), 'myr_v1_peers table missing');
    assert.ok(tables.includes('myr_network_reports'), 'myr_network_reports table missing');
    assert.ok(tables.includes('myr_nonces'), 'myr_nonces table missing');
  });
});
