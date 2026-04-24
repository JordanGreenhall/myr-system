'use strict';

const { describe, it } = require('node:test');
const assert = require('assert/strict');
const http = require('http');
const nodeCrypto = require('crypto');
const Database = require('better-sqlite3');
const { generateKeypair, sign: signMessage, fingerprint: computeFingerprint } = require('../lib/crypto');
const { createApp } = require('../server/index');
const { syncPeer, httpFetch, makeSignedHeaders } = require('../lib/sync');
const { canonicalize } = require('../lib/canonicalize');

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

function startServer(app, port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
    srv.on('error', reject);
  });
}

function signedFetch(url, { method = 'GET', body, keys } = {}) {
  const parsed = new URL(url);
  const urlPath = parsed.pathname;
  const bodyStr = body ? JSON.stringify(body) : undefined;
  const headers = makeSignedHeaders({
    method,
    urlPath,
    body: bodyStr,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });
  return httpFetch(url, { method, headers, body: bodyStr });
}

// ── Expected failure detection latencies ────────────────────────────────────
//
// | Failure mode                  | Detection latency        | Mechanism                    |
// |-------------------------------|--------------------------|------------------------------|
// | Peer offline                  | ≤ 2 sync cycles (≤ 30m)  | last_sync_at ages in DB     |
// | Repeated sync failure         | Immediate (health query) | queue_age_seconds threshold  |
// | Yield queue aging             | Immediate (health query) | /myr/health/node status      |
// | Governance revocation         | Immediate                | trust_level → revoked → 403  |
// | Network degradation (>50%)    | Immediate (health query) | /myr/health/network status   |
// | Flow effectiveness drop       | Immediate (health query) | /myr/health/flow status      |

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Failure visibility: peer offline detection', () => {

  it('health/network reflects stale peer within freshness window', async () => {
    const keys = generateKeypair();
    const db = makeDb();
    const config = {
      node_id: 'monitor-node',
      node_url: 'http://127.0.0.1:37200',
      operator_name: 'monitor',
      port: 37200,
    };

    // Add a peer with a recent sync
    const recentSync = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, last_sync_at)
      VALUES (?, ?, ?, 'trusted', datetime('now'), datetime('now'), ?)
    `).run('http://peer-a.local:9000', 'peer-a', 'aaa111', recentSync);

    const app = createApp({
      config, db,
      publicKeyHex: keys.publicKey,
      privateKeyHex: keys.privateKey,
      createdAt: new Date().toISOString(),
    });
    const srv = await startServer(app, 37200);

    try {
      // Network health should be green (peer synced recently)
      const r1 = await httpFetch('http://127.0.0.1:37200/myr/health/network');
      assert.equal(r1.status, 200);
      assert.equal(r1.body.status, 'green', `Expected green, got ${r1.body.status}`);
      assert.equal(r1.body.metrics.reachable_peers, 1);
      assert.equal(r1.body.metrics.stale_peers, 0);

      // Simulate peer going offline: set last_sync_at to 30 minutes ago (beyond 15m freshness default)
      const staleSync = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      db.prepare('UPDATE myr_peers SET last_sync_at = ? WHERE public_key = ?')
        .run(staleSync, 'aaa111');

      // Network health should now show stale peer
      const r2 = await httpFetch('http://127.0.0.1:37200/myr/health/network');
      assert.equal(r2.status, 200);
      assert.equal(r2.body.metrics.stale_peers, 1);
      assert.equal(r2.body.metrics.reachable_peers, 0);
      // Single peer offline = 0% reachability → red
      assert.equal(r2.body.status, 'red', `Expected red with 0 reachable peers, got ${r2.body.status}`);
    } finally {
      srv.close();
    }
  });

  it('health/network degrades to yellow then red as peers go offline', async () => {
    const keys = generateKeypair();
    const db = makeDb();
    const config = {
      node_id: 'monitor-node-2',
      node_url: 'http://127.0.0.1:37201',
      operator_name: 'monitor-2',
      port: 37201,
    };

    const recentSync = new Date(Date.now() - 60 * 1000).toISOString();
    // Add 5 peers, all recently synced
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, last_sync_at)
        VALUES (?, ?, ?, 'trusted', datetime('now'), datetime('now'), ?)
      `).run(`http://peer-${i}.local:9000`, `peer-${i}`, `key${i}${i}${i}`, recentSync);
    }

    const app = createApp({
      config, db,
      publicKeyHex: keys.publicKey,
      privateKeyHex: keys.privateKey,
      createdAt: new Date().toISOString(),
    });
    const srv = await startServer(app, 37201);

    try {
      // All green
      const r1 = await httpFetch('http://127.0.0.1:37201/myr/health/network');
      assert.equal(r1.body.status, 'green');
      assert.equal(r1.body.metrics.reachable_peers, 5);

      // 2 of 5 go stale → 3/5 = 60% reachable → yellow (≥0.5, <0.8)
      const staleSync = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      db.prepare('UPDATE myr_peers SET last_sync_at = ? WHERE public_key IN (?, ?)')
        .run(staleSync, 'key000', 'key111');

      const r2 = await httpFetch('http://127.0.0.1:37201/myr/health/network');
      assert.equal(r2.body.status, 'yellow', `Expected yellow with 3/5 reachable, got ${r2.body.status}`);
      assert.equal(r2.body.metrics.reachable_peers, 3);
      assert.equal(r2.body.metrics.stale_peers, 2);

      // 4 of 5 go stale → 1/5 = 20% reachable → red (<0.5)
      db.prepare('UPDATE myr_peers SET last_sync_at = ? WHERE public_key IN (?, ?)')
        .run(staleSync, 'key222', 'key333');

      const r3 = await httpFetch('http://127.0.0.1:37201/myr/health/network');
      assert.equal(r3.body.status, 'red', `Expected red with 1/5 reachable, got ${r3.body.status}`);
      assert.equal(r3.body.metrics.stale_peers, 4);
    } finally {
      srv.close();
    }
  });
});

describe('Failure visibility: sync failure degrades node status', () => {

  it('node status degrades to yellow/red as queue ages', async () => {
    const keys = generateKeypair();
    const db = makeDb();
    const config = {
      node_id: 'aging-node',
      node_url: 'http://127.0.0.1:37202',
      operator_name: 'aging-test',
      port: 37202,
    };

    // Add a peer with recent sync
    const recentSync = new Date(Date.now() - 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, last_sync_at)
      VALUES (?, ?, ?, 'trusted', datetime('now'), datetime('now'), ?)
    `).run('http://peer.local:9000', 'test-peer', 'testkey123', recentSync);

    const app = createApp({
      config, db,
      publicKeyHex: keys.publicKey,
      privateKeyHex: keys.privateKey,
      createdAt: new Date().toISOString(),
    });
    const srv = await startServer(app, 37202);

    try {
      // Fresh sync → green (queue age ~60s, below 300s greenMax)
      const r1 = await httpFetch('http://127.0.0.1:37202/myr/health/node');
      assert.equal(r1.status, 200);
      assert.equal(r1.body.status, 'green', `Expected green with recent sync, got ${r1.body.status}`);
      assert.ok(r1.body.metrics.queue_age_seconds <= 300, 'Queue age should be under 300s');

      // Simulate sync failure: set last_sync_at to 10 minutes ago (>300s greenMax, <1800s yellowMax)
      const mediumAge = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      db.prepare('UPDATE myr_peers SET last_sync_at = ? WHERE public_key = ?')
        .run(mediumAge, 'testkey123');

      const r2 = await httpFetch('http://127.0.0.1:37202/myr/health/node');
      assert.equal(r2.body.status, 'yellow', `Expected yellow with 10m stale sync, got ${r2.body.status}`);

      // Simulate prolonged failure: set last_sync_at to 45 minutes ago (>1800s yellowMax)
      const longAge = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      db.prepare('UPDATE myr_peers SET last_sync_at = ? WHERE public_key = ?')
        .run(longAge, 'testkey123');

      const r3 = await httpFetch('http://127.0.0.1:37202/myr/health/node');
      assert.equal(r3.body.status, 'red', `Expected red with 45m stale sync, got ${r3.body.status}`);
    } finally {
      srv.close();
    }
  });

  it('node status is yellow when no sync has ever occurred', async () => {
    const keys = generateKeypair();
    const db = makeDb();
    const config = {
      node_id: 'new-node',
      node_url: 'http://127.0.0.1:37203',
      operator_name: 'new-test',
      port: 37203,
    };

    // Peer with no last_sync_at
    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at)
      VALUES (?, ?, ?, 'trusted', datetime('now'), datetime('now'))
    `).run('http://peer.local:9000', 'unseen-peer', 'nosynkey');

    const app = createApp({
      config, db,
      publicKeyHex: keys.publicKey,
      privateKeyHex: keys.privateKey,
      createdAt: new Date().toISOString(),
    });
    const srv = await startServer(app, 37203);

    try {
      const r = await httpFetch('http://127.0.0.1:37203/myr/health/node');
      assert.equal(r.body.status, 'yellow', 'Node with no sync history should be yellow');
      assert.equal(r.body.metrics.queue_age_seconds, null, 'Queue age should be null with no sync');
    } finally {
      srv.close();
    }
  });
});

describe('Failure visibility: yield queue aging alerts', () => {

  it('health/flow shows degraded effectiveness when sync failures accumulate', async () => {
    const keys = generateKeypair();
    const db = makeDb();
    const config = {
      node_id: 'flow-node',
      node_url: 'http://127.0.0.1:37204',
      operator_name: 'flow-test',
      port: 37204,
    };

    const app = createApp({
      config, db,
      publicKeyHex: keys.publicKey,
      privateKeyHex: keys.privateKey,
      createdAt: new Date().toISOString(),
    });
    const srv = await startServer(app, 37204);

    try {
      // No sync events → effectiveness defaults to 1.0 (green)
      const r1 = await httpFetch('http://127.0.0.1:37204/myr/health/flow');
      assert.equal(r1.status, 200);
      assert.equal(r1.body.status, 'green');

      // Add some successful sync traces
      const now = new Date().toISOString();
      for (let i = 0; i < 8; i++) {
        db.prepare(`
          INSERT INTO myr_traces (trace_id, timestamp, event_type, actor_fingerprint, outcome, metadata)
          VALUES (?, ?, 'sync_pull', 'actor-fp', 'success', '{}')
        `).run(nodeCrypto.randomUUID(), now);
      }

      // 8 success, 0 fail → 100% → green
      const r2 = await httpFetch('http://127.0.0.1:37204/myr/health/flow');
      assert.equal(r2.body.status, 'green');
      assert.equal(r2.body.metrics.retrieval_effectiveness, 1);

      // Add failures to push below 0.9 threshold (yellow zone)
      // Need 8 success + 2 fail = 80% (below 0.9 green, above 0.75 yellow)
      for (let i = 0; i < 2; i++) {
        db.prepare(`
          INSERT INTO myr_traces (trace_id, timestamp, event_type, actor_fingerprint, outcome, metadata)
          VALUES (?, ?, 'sync_pull', 'actor-fp', 'failure', '{}')
        `).run(nodeCrypto.randomUUID(), now);
      }

      const r3 = await httpFetch('http://127.0.0.1:37204/myr/health/flow');
      assert.equal(r3.body.status, 'yellow', `Expected yellow with 80% effectiveness, got ${r3.body.status}`);

      // Add more failures to push below 0.75 threshold (red zone)
      // Need 8 success + 6 fail = ~57% (below 0.75)
      for (let i = 0; i < 4; i++) {
        db.prepare(`
          INSERT INTO myr_traces (trace_id, timestamp, event_type, actor_fingerprint, outcome, metadata)
          VALUES (?, ?, 'sync_pull', 'actor-fp', 'failure', '{}')
        `).run(nodeCrypto.randomUUID(), now);
      }

      const r4 = await httpFetch('http://127.0.0.1:37204/myr/health/flow');
      assert.equal(r4.body.status, 'red', `Expected red with ~57% effectiveness, got ${r4.body.status}`);
    } finally {
      srv.close();
    }
  });

  it('health/node queue_age_seconds accurately reflects sync staleness', async () => {
    const keys = generateKeypair();
    const db = makeDb();
    const config = {
      node_id: 'queue-node',
      node_url: 'http://127.0.0.1:37205',
      operator_name: 'queue-test',
      port: 37205,
    };

    // Set last_sync_at to exactly 600 seconds ago
    const syncTime = new Date(Date.now() - 600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, last_sync_at)
      VALUES (?, ?, ?, 'trusted', datetime('now'), datetime('now'), ?)
    `).run('http://peer.local:9000', 'queue-peer', 'queuekey', syncTime);

    const app = createApp({
      config, db,
      publicKeyHex: keys.publicKey,
      privateKeyHex: keys.privateKey,
      createdAt: new Date().toISOString(),
    });
    const srv = await startServer(app, 37205);

    try {
      const r = await httpFetch('http://127.0.0.1:37205/myr/health/node');
      // Allow ±5 seconds tolerance for test execution time
      const age = r.body.metrics.queue_age_seconds;
      assert.ok(age >= 595 && age <= 610, `Queue age should be ~600s, got ${age}s`);
      // 600s is between greenMax (300) and yellowMax (1800) → yellow
      assert.equal(r.body.status, 'yellow');
    } finally {
      srv.close();
    }
  });
});

describe('Failure visibility: governance revocation blocks sync immediately', () => {

  it('revoked peer is immediately rejected on sync attempt', async () => {
    const keysA = generateKeypair();
    const keysB = generateKeypair();
    const dbA = makeDb();

    const configA = {
      node_id: 'gov-node-a',
      node_url: 'http://127.0.0.1:37206',
      operator_name: 'gov-a',
      port: 37206,
    };

    // Add B as trusted peer on A
    dbA.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at)
      VALUES (?, ?, ?, 'trusted', datetime('now'), datetime('now'))
    `).run('http://peer-b.local:9000', 'gov-b', keysB.publicKey);

    const app = createApp({
      config: configA, db: dbA,
      publicKeyHex: keysA.publicKey,
      privateKeyHex: keysA.privateKey,
      createdAt: new Date().toISOString(),
    });
    const srv = await startServer(app, 37206);

    try {
      // B can access A's reports (trusted)
      const r1 = await signedFetch('http://127.0.0.1:37206/myr/reports', { keys: keysB });
      assert.equal(r1.status, 200, 'Trusted peer should get 200');

      // A revokes B via governance endpoint
      const revokeRes = await signedFetch('http://127.0.0.1:37206/myr/governance/revoke', {
        method: 'POST',
        body: { peer_fingerprint: computeFingerprint(keysB.publicKey) },
        keys: keysA,  // local operator
      });
      assert.equal(revokeRes.status, 200, 'Revocation should succeed');
      assert.equal(revokeRes.body.status, 'revoked');

      // B is immediately blocked (403)
      const r2 = await signedFetch('http://127.0.0.1:37206/myr/reports', { keys: keysB });
      assert.equal(r2.status, 403, `Revoked peer should get 403, got ${r2.status}`);

      // Verify trust_level in DB
      const peer = dbA.prepare('SELECT trust_level FROM myr_peers WHERE public_key = ?')
        .get(keysB.publicKey);
      assert.equal(peer.trust_level, 'revoked');

      // Verify revocation trace exists
      const traces = dbA.prepare(
        "SELECT * FROM myr_traces WHERE event_type = 'revoke'"
      ).all();
      assert.ok(traces.length >= 1, 'Revocation trace should be recorded');
    } finally {
      srv.close();
    }
  });

  it('revoked peer sync attempt fails immediately', async () => {
    const keysA = generateKeypair();
    const keysB = generateKeypair();
    const dbA = makeDb();
    const dbB = makeDb();

    const configA = {
      node_id: 'sync-block-a',
      node_url: 'http://127.0.0.1:37207',
      operator_name: 'sync-block-a',
      port: 37207,
    };

    // B has A as peer, A has B as revoked
    dbA.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at)
      VALUES (?, ?, ?, 'revoked', datetime('now'))
    `).run('http://peer-b.local:9000', 'sync-block-b', keysB.publicKey);

    dbB.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, auto_sync)
      VALUES (?, ?, ?, 'trusted', datetime('now'), datetime('now'), 1)
    `).run('http://127.0.0.1:37207', 'sync-block-a', keysA.publicKey);

    const app = createApp({
      config: configA, db: dbA,
      publicKeyHex: keysA.publicKey,
      privateKeyHex: keysA.privateKey,
      createdAt: new Date().toISOString(),
    });
    const srv = await startServer(app, 37207);

    try {
      // B tries to sync from A — should fail (403 or peerNotTrusted)
      const peerRecord = dbB.prepare('SELECT * FROM myr_peers WHERE public_key = ?')
        .get(keysA.publicKey);

      let syncBlocked = false;
      try {
        const result = await syncPeer({
          db: dbB,
          peer: peerRecord,
          keys: keysB,
          fetch: httpFetch,
        });
        // If syncPeer returns (rather than throws), check peerNotTrusted flag
        syncBlocked = result.peerNotTrusted === true;
        assert.equal(result.imported, 0, 'No reports should be imported');
      } catch (err) {
        // syncPeer throws for non-peerNotTrusted 403s — this is also a valid block
        syncBlocked = err.message.includes('403');
      }

      assert.ok(syncBlocked, 'Revoked peer sync must be blocked immediately');
    } finally {
      srv.close();
    }
  });
});

describe('Failure visibility: documented detection latencies', () => {

  it('health endpoints expose thresholds for monitoring integration', async () => {
    const keys = generateKeypair();
    const db = makeDb();
    const config = {
      node_id: 'threshold-node',
      node_url: 'http://127.0.0.1:37208',
      operator_name: 'threshold-test',
      port: 37208,
    };

    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, last_sync_at)
      VALUES (?, ?, ?, 'trusted', datetime('now'), datetime('now'), datetime('now'))
    `).run('http://p.local:9000', 'p', 'pkey');

    const app = createApp({
      config, db,
      publicKeyHex: keys.publicKey,
      privateKeyHex: keys.privateKey,
      createdAt: new Date().toISOString(),
    });
    const srv = await startServer(app, 37208);

    try {
      // Node health exposes queue age thresholds
      const nodeHealth = await httpFetch('http://127.0.0.1:37208/myr/health/node');
      assert.ok(nodeHealth.body.thresholds, 'Node health should expose thresholds');
      assert.ok(nodeHealth.body.thresholds.queue_age_seconds, 'Should expose queue_age_seconds thresholds');
      assert.equal(nodeHealth.body.thresholds.queue_age_seconds.greenMax, 300,
        'Green threshold should be 300s (5 min)');
      assert.equal(nodeHealth.body.thresholds.queue_age_seconds.yellowMax, 1800,
        'Yellow threshold should be 1800s (30 min)');

      // Network health exposes reachability thresholds
      const netHealth = await httpFetch('http://127.0.0.1:37208/myr/health/network');
      assert.ok(netHealth.body.thresholds, 'Network health should expose thresholds');
      assert.equal(netHealth.body.thresholds.min_reachability_ratio_green, 0.8);
      assert.equal(netHealth.body.thresholds.min_reachability_ratio_yellow, 0.5);

      // Flow health exposes effectiveness thresholds
      const flowHealth = await httpFetch('http://127.0.0.1:37208/myr/health/flow');
      assert.ok(flowHealth.body.thresholds, 'Flow health should expose thresholds');
      assert.equal(flowHealth.body.thresholds.retrieval_effectiveness_green, 0.9);
      assert.equal(flowHealth.body.thresholds.retrieval_effectiveness_yellow, 0.75);

      // Document the expected detection latencies
      console.log('\n  ═══ FAILURE DETECTION LATENCIES ═══');
      console.log('  ┌──────────────────────────────────┬─────────────────────────┬─────────────────────────────┐');
      console.log('  │ Failure Mode                     │ Detection Latency       │ Mechanism                   │');
      console.log('  ├──────────────────────────────────┼─────────────────────────┼─────────────────────────────┤');
      console.log('  │ Peer offline                     │ ≤ 2 sync cycles (≤30m)  │ last_sync_at stale → yellow │');
      console.log('  │ Repeated sync failure            │ Immediate on query      │ queue_age > 300s → yellow   │');
      console.log('  │ Prolonged sync failure           │ Immediate on query      │ queue_age > 1800s → red     │');
      console.log('  │ Yield queue aging                │ Immediate on query      │ /myr/health/node status     │');
      console.log('  │ Governance revocation            │ Immediate               │ trust_level=revoked → 403   │');
      console.log('  │ Network degradation (20-50%)     │ Immediate on query      │ reachability < 0.8 → yellow │');
      console.log('  │ Network degradation (>50%)       │ Immediate on query      │ reachability < 0.5 → red    │');
      console.log('  │ Flow effectiveness drop          │ Immediate on query      │ effectiveness < 0.9 → yellow│');
      console.log('  │ Flow effectiveness critical      │ Immediate on query      │ effectiveness < 0.75 → red  │');
      console.log('  └──────────────────────────────────┴─────────────────────────┴─────────────────────────────┘');
    } finally {
      srv.close();
    }
  });
});
