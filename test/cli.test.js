'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair, fingerprint: computeFingerprint } = require('../lib/crypto');
const crypto = require('crypto');
const { sign } = require('../lib/crypto');
const {
  findPeer,
  addPeer,
  approvePeer,
  rejectPeer,
  revokePeerGovernance,
  quarantineYield,
  governanceAudit,
  listPeers,
  getFingerprint,
  getPeerFingerprint,
  syncPeer,
  inferTargetDomains,
  routePeersForSync,
  nodeVerify,
  announceTo,
  verifyPeer,
  publishSubscription,
  makeInviteUrl,
  parseInviteUrl,
  parseDurationMs,
  getAutoSyncSettings,
} = require('../bin/myr');
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
      yield_type TEXT NOT NULL,
      question_answered TEXT NOT NULL,
      evidence TEXT NOT NULL,
      what_changes_next TEXT NOT NULL,
      what_was_falsified TEXT,
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
      trust_level TEXT CHECK(trust_level IN ('trusted', 'pending', 'introduced', 'revoked', 'rejected', 'verified-pending-approval')) DEFAULT 'pending',
      added_at TEXT NOT NULL,
      approved_at TEXT,
      last_sync_at TEXT,
      auto_sync INTEGER DEFAULT 1,
      notes TEXT,
      node_uuid TEXT,
      verification_evidence TEXT,
      auto_approved INTEGER DEFAULT 0
    );

    CREATE TABLE myr_nonces (
      nonce TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX idx_nonces_expires ON myr_nonces(expires_at);

    CREATE TABLE myr_traces (
      trace_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('introduce','approve','share','sync_pull','sync_push','verify','reject','discover','relay_sync','revoke','quarantine','stage_change')),
      actor_fingerprint TEXT NOT NULL,
      target_fingerprint TEXT,
      artifact_signature TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','rejected')),
      rejection_reason TEXT,
      metadata TEXT DEFAULT '{}'
    );

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
  `);

  return db;
}

function seedPeers(db) {
  const insert = db.prepare(
    'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, last_sync_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insert.run('https://gary.myr.network', 'gary', 'aa'.repeat(32), 'trusted', '2026-02-28T12:00:00Z', '2026-03-01T10:30:00Z');
  insert.run('https://jared.myr.network', 'jared', 'bb'.repeat(32), 'pending', '2026-03-01T08:00:00Z', null);
  insert.run('https://eve.myr.network', 'eve', 'cc'.repeat(32), 'rejected', '2026-02-27T08:00:00Z', null);
}

function decodeInvite(inviteUrl) {
  const token = inviteUrl.replace('myr://invite/', '');
  const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function encodeInvite(payload) {
  const token = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `myr://invite/${token}`;
}

describe('invite tokens', () => {
  it('creates a signed invite URL and parses it', () => {
    const keys = generateKeypair();
    const inviteUrl = makeInviteUrl({
      nodeConfig: { node_url: 'https://alpha.myr.network', operator_name: 'alpha' },
      keys,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      token: 'nonce-1',
    });

    const payload = parseInviteUrl(inviteUrl);
    assert.equal(payload.node_url, 'https://alpha.myr.network');
    assert.equal(payload.operator_name, 'alpha');
    assert.equal(payload.public_key, keys.publicKey);
    assert.equal(payload.fingerprint, computeFingerprint(keys.publicKey));
    assert.ok(payload.sig);
  });

  it('rejects tampered payload content', () => {
    const keys = generateKeypair();
    const inviteUrl = makeInviteUrl({
      nodeConfig: { node_url: 'https://alpha.myr.network', operator_name: 'alpha' },
      keys,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      token: 'nonce-2',
    });

    const payload = decodeInvite(inviteUrl);
    payload.operator_name = 'mallory';
    const tampered = encodeInvite(payload);

    assert.throws(() => parseInviteUrl(tampered), /signature verification failed/);
  });

  it('rejects fingerprint and key mismatch', () => {
    const keys = generateKeypair();
    const inviteUrl = makeInviteUrl({
      nodeConfig: { node_url: 'https://alpha.myr.network', operator_name: 'alpha' },
      keys,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      token: 'nonce-3',
    });

    const payload = decodeInvite(inviteUrl);
    payload.fingerprint = 'SHA-256:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00';
    const tampered = encodeInvite(payload);

    assert.throws(() => parseInviteUrl(tampered), /fingerprint does not match public key/);
  });

  it('rejects expired invites', () => {
    const keys = generateKeypair();
    const inviteUrl = makeInviteUrl({
      nodeConfig: { node_url: 'https://alpha.myr.network', operator_name: 'alpha' },
      keys,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      token: 'nonce-4',
    });

    assert.throws(() => parseInviteUrl(inviteUrl), /Invite expired at/);
  });
});

// ---------- findPeer ----------

describe('findPeer', () => {
  let db;
  before(() => { db = createTestDb(); seedPeers(db); });
  after(() => db.close());

  it('finds peer by operator_name', () => {
    const peer = findPeer(db, 'gary');
    assert.ok(peer);
    assert.equal(peer.operator_name, 'gary');
    assert.equal(peer.peer_url, 'https://gary.myr.network');
  });

  it('finds peer by public_key prefix', () => {
    const peer = findPeer(db, 'aaaa');
    assert.ok(peer);
    assert.equal(peer.operator_name, 'gary');
  });

  it('returns null for unknown peer', () => {
    assert.equal(findPeer(db, 'unknown'), null);
  });

  it('throws for ambiguous public_key prefix', () => {
    const db2 = createTestDb();
    db2.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run('https://a.test', 'peerA', 'ab'.repeat(32), 'pending', '2026-03-01T00:00:00Z');
    db2.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run('https://b.test', 'peerB', 'ac'.repeat(32), 'pending', '2026-03-01T00:00:00Z');

    assert.throws(() => findPeer(db2, 'a'), /Ambiguous/);
    db2.close();
  });
});

// ---------- approvePeer ----------

describe('approvePeer', () => {
  let db;
  before(() => { db = createTestDb(); seedPeers(db); });
  after(() => db.close());

  it('changes trust_level to trusted and sets approved_at', () => {
    const result = approvePeer({ db, identifier: 'jared' });
    assert.equal(result.message, 'Peer approved: jared');

    const peer = db.prepare('SELECT * FROM myr_peers WHERE operator_name = ?').get('jared');
    assert.equal(peer.trust_level, 'trusted');
    assert.ok(peer.approved_at);
  });

  it('works with public_key prefix', () => {
    const result = approvePeer({ db, identifier: 'cccc' });
    assert.equal(result.message, 'Peer approved: eve');

    const peer = db.prepare('SELECT * FROM myr_peers WHERE operator_name = ?').get('eve');
    assert.equal(peer.trust_level, 'trusted');
  });

  it('throws for unknown peer', () => {
    assert.throws(() => approvePeer({ db, identifier: 'nobody' }), /No peer found/);
  });
});

// ---------- rejectPeer ----------

describe('rejectPeer', () => {
  let db;
  before(() => { db = createTestDb(); seedPeers(db); });
  after(() => db.close());

  it('changes trust_level to rejected', () => {
    const result = rejectPeer({ db, identifier: 'jared' });
    assert.equal(result.message, 'Peer rejected: jared');

    const peer = db.prepare('SELECT * FROM myr_peers WHERE operator_name = ?').get('jared');
    assert.equal(peer.trust_level, 'rejected');
  });

  it('throws for unknown peer', () => {
    assert.throws(() => rejectPeer({ db, identifier: 'nobody' }), /No peer found/);
  });
});

describe('governance interventions', () => {
  let db;
  const keys = generateKeypair();

  before(() => {
    db = createTestDb();
    seedPeers(db);
    db.prepare(`
      INSERT INTO myr_reports (
        id, timestamp, agent_id, node_id, cycle_intent, domain_tags, cycle_context,
        yield_type, question_answered, evidence, what_changes_next, what_was_falsified,
        confidence, operator_rating, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'yield-001',
      '2026-04-16T12:00:00Z',
      'agent1',
      'n1',
      'Debug sync path',
      '["networking","sync"]',
      null,
      'technique',
      'How to reduce sync failures?',
      'Use retry and jitter',
      'Apply retry policy',
      null,
      0.8,
      4,
      '2026-04-16T12:00:00Z',
      '2026-04-16T12:00:00Z'
    );
  });

  after(() => db.close());

  it('revoke sets peer trust_level=revoked so sync is blocked', async () => {
    const revoked = revokePeerGovernance({ db, identifier: 'gary', keys });
    assert.equal(revoked.peer.trust_level, 'revoked');

    await assert.rejects(
      () => syncPeer({ db, peerName: 'gary', keys }),
      /not trusted \(status: revoked\)/
    );
  });

  it('quarantine excludes yield from recall and appears in governance audit', () => {
    const result = quarantineYield({
      db,
      yieldId: 'yield-001',
      reason: 'manual review pending',
      keys,
    });
    assert.equal(result.quarantine.yield_id, 'yield-001');
    assert.equal(result.quarantine.status, 'active');

    const recalled = recall(db, { intent: 'sync failures', tags: ['sync'] });
    assert.ok(!recalled.results.some((r) => r.id === 'yield-001'));
    assert.ok(!recalled.falsifications.some((r) => r.id === 'yield-001'));

    const audit = governanceAudit({ db, limit: 50 });
    assert.ok(audit.quarantines.length >= 1);
    assert.ok(audit.quarantinedYields.some((q) => q.yield_id === 'yield-001'));
  });
});

// ---------- listPeers ----------

describe('listPeers', () => {
  let db;
  before(() => { db = createTestDb(); seedPeers(db); });
  after(() => db.close());

  it('returns all peers', () => {
    const peers = listPeers({ db });
    assert.equal(peers.length, 3);
  });

  it('includes expected fields for each peer', () => {
    const peers = listPeers({ db });
    const gary = peers.find(p => p.operator_name === 'gary');
    assert.ok(gary);
    assert.equal(gary.peer_url, 'https://gary.myr.network');
    assert.equal(gary.trust_level, 'trusted');
    assert.ok(gary.added_at);
    assert.ok(gary.last_sync_at);
  });

  it('returns empty array for empty database', () => {
    const emptyDb = createTestDb();
    const peers = listPeers({ db: emptyDb });
    assert.equal(peers.length, 0);
    emptyDb.close();
  });
});

// ---------- getFingerprint ----------

describe('getFingerprint', () => {
  it('returns SHA-256 fingerprint with 16 hex pairs', () => {
    const keys = generateKeypair();
    const fp = getFingerprint({ publicKeyHex: keys.publicKey });
    assert.ok(fp.startsWith('SHA-256:'));
    // SHA-256 prefix + 16 colon-separated hex pairs
    const parts = fp.split(':');
    assert.equal(parts.length, 17);
    for (let i = 1; i < parts.length; i++) {
      assert.match(parts[i], /^[0-9a-f]{2}$/);
    }
  });

  it('matches lib/crypto fingerprint', () => {
    const keys = generateKeypair();
    const fp = getFingerprint({ publicKeyHex: keys.publicKey });
    assert.equal(fp, computeFingerprint(keys.publicKey));
  });
});

// ---------- getPeerFingerprint ----------

describe('getPeerFingerprint', () => {
  let db;
  before(() => { db = createTestDb(); seedPeers(db); });
  after(() => db.close());

  it('returns peer name and fingerprint', () => {
    const result = getPeerFingerprint({ db, name: 'gary' });
    assert.equal(result.name, 'gary');
    assert.ok(result.fingerprint.startsWith('SHA-256:'));
    assert.equal(result.fingerprint, computeFingerprint('aa'.repeat(32)));
  });

  it('throws for unknown peer', () => {
    assert.throws(() => getPeerFingerprint({ db, name: 'nobody' }), /No peer found/);
  });
});

// ---------- addPeer ----------

describe('addPeer', () => {
  let peerServer, peerPort, peerDb, peerKeys, cliDb;
  const ourKeys = generateKeypair();

  before(() => {
    peerKeys = generateKeypair();
    peerDb = createTestDb();
    cliDb = createTestDb();

    const peerApp = createApp({
      config: {
        node_id: 'peer-node',
        operator_name: 'remotepeer',
        node_url: 'https://remotepeer.myr.network',
        port: 0,
      },
      db: peerDb,
      publicKeyHex: peerKeys.publicKey,
      createdAt: '2026-03-01T10:00:00Z',
    });
    peerServer = peerApp.listen(0);
    peerPort = peerServer.address().port;
  });

  after(() => {
    peerServer.close();
    peerDb.close();
    cliDb.close();
  });

  it('fetches discovery and stores peer locally with pending trust', async () => {
    const result = await addPeer({
      db: cliDb,
      config: {
        operator_name: 'testlocal',
        node_url: 'http://localhost:9999',
        port: 9999,
      },
      url: `http://localhost:${peerPort}`,
      keys: ourKeys,
    });

    assert.ok(result.message.includes('Peer added (pending approval)'));
    assert.ok(result.message.includes('remotepeer'));

    const stored = cliDb.prepare('SELECT * FROM myr_peers WHERE operator_name = ?').get('remotepeer');
    assert.ok(stored);
    assert.equal(stored.trust_level, 'pending');
    assert.equal(stored.public_key, peerKeys.publicKey);
    assert.equal(stored.peer_url, 'https://remotepeer.myr.network');
    assert.ok(stored.added_at);
  });

  it('announces us to the remote peer', () => {
    const remotePeer = peerDb.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(ourKeys.publicKey);
    assert.ok(remotePeer, 'remote should have stored our peer record');
    // Default introduce behavior auto-approves fingerprint-valid peers.
    assert.equal(remotePeer.trust_level, 'trusted');
    assert.equal(remotePeer.operator_name, 'testlocal');
  });

  it('throws when peer already exists', async () => {
    await assert.rejects(
      () => addPeer({
        db: cliDb,
        config: { operator_name: 'testlocal', node_url: 'http://localhost:9999', port: 9999 },
        url: `http://localhost:${peerPort}`,
        keys: ourKeys,
      }),
      /Peer already exists/
    );
  });

  it('throws on network failure', async () => {
    await assert.rejects(
      () => addPeer({
        db: cliDb,
        config: { operator_name: 'testlocal', node_url: 'http://localhost:9999', port: 9999 },
        url: 'http://localhost:1',
        keys: ourKeys,
      }),
    );
  });
});

// ---------- syncPeer ----------

describe('syncPeer', () => {
  let peerServer, peerPort, peerDb, peerKeys, cliDb;
  const ourKeys = generateKeypair();

  before(() => {
    peerKeys = generateKeypair();
    peerDb = createTestDb();
    cliDb = createTestDb();

    const insertReport = peerDb.prepare(`
      INSERT INTO myr_reports (id, timestamp, agent_id, node_id, cycle_intent, domain_tags,
        yield_type, question_answered, evidence, what_changes_next, confidence,
        created_at, updated_at, share_network)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertReport.run('r1', '2026-03-01T10:00:00Z', 'agent1', 'peer-node',
      'test method', 'testing', 'technique', 'does it work?', 'yes it does', 'keep going',
      0.8, '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', 1);

    insertReport.run('r2', '2026-03-01T11:00:00Z', 'agent1', 'peer-node',
      'another method', 'testing', 'insight', 'is it fast?', 'pretty fast', 'optimize later',
      0.9, '2026-03-01T11:00:00Z', '2026-03-01T11:00:00Z', 1);

    // Non-shared report (should not be synced)
    insertReport.run('r3', '2026-03-01T12:00:00Z', 'agent1', 'peer-node',
      'private method', 'internal', 'pattern', 'secret?', 'yes', 'hide it',
      0.7, '2026-03-01T12:00:00Z', '2026-03-01T12:00:00Z', 0);

    // Register our key as trusted on the peer
    peerDb.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run('http://localhost:9999', 'us', ourKeys.publicKey, 'trusted', new Date().toISOString());

    const peerApp = createApp({
      config: {
        node_id: 'peer-node',
        operator_name: 'remotepeer',
        node_url: 'https://remotepeer.myr.network',
        port: 0,
      },
      db: peerDb,
      publicKeyHex: peerKeys.publicKey,
      createdAt: '2026-03-01T10:00:00Z',
      privateKeyHex: peerKeys.privateKey,
    });
    peerServer = peerApp.listen(0);
    peerPort = peerServer.address().port;

    // Register remote peer in our DB with actual server URL
    cliDb.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run(`http://localhost:${peerPort}`, 'remotepeer', peerKeys.publicKey, 'trusted', new Date().toISOString());
  });

  after(() => {
    peerServer.close();
    peerDb.close();
    cliDb.close();
  });

  it('imports shared reports from trusted peer', async () => {
    const result = await syncPeer({
      db: cliDb,
      peerName: 'remotepeer',
      keys: ourKeys,
    });

    assert.ok(result.message.includes('Synced'));
    assert.ok(result.message.includes('remotepeer'));
    assert.equal(result.imported, 2);

    const reports = cliDb.prepare('SELECT * FROM myr_reports ORDER BY id').all();
    assert.equal(reports.length, 2);
    assert.equal(reports[0].id, 'r1');
    assert.equal(reports[0].imported_from, 'remotepeer');
    assert.equal(reports[0].import_verified, 1);
    assert.equal(reports[0].share_network, 0);
    assert.equal(reports[1].id, 'r2');
  });

  it('updates last_sync_at after sync', () => {
    const peer = cliDb.prepare('SELECT * FROM myr_peers WHERE operator_name = ?').get('remotepeer');
    assert.ok(peer.last_sync_at);
  });

  it('does not re-import on second sync', async () => {
    const result = await syncPeer({
      db: cliDb,
      peerName: 'remotepeer',
      keys: ourKeys,
    });

    assert.equal(result.imported, 0);
    assert.ok(result.message.includes('Synced 0'));
  });

  it('rejects sync with untrusted peer', async () => {
    const db2 = createTestDb();
    db2.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run('http://localhost:9999', 'pending-peer', 'dd'.repeat(32), 'pending', new Date().toISOString());

    await assert.rejects(
      () => syncPeer({ db: db2, peerName: 'pending-peer', keys: ourKeys }),
      /not trusted/
    );
    db2.close();
  });

  it('throws for unknown peer', async () => {
    await assert.rejects(
      () => syncPeer({ db: cliDb, peerName: 'nonexistent', keys: ourKeys }),
      /No peer found/
    );
  });
});

// ---------- syncPeer (sync-all path) ----------

describe('syncPeer — sync-all behavior', () => {
  let peerServer1, peerPort1, peerDb1, peerKeys1;
  let peerServer2, peerPort2, peerDb2, peerKeys2;
  let cliDb;
  const ourKeys = generateKeypair();

  before(() => {
    peerKeys1 = generateKeypair();
    peerKeys2 = generateKeypair();
    peerDb1 = createTestDb();
    peerDb2 = createTestDb();
    cliDb = createTestDb();

    // Peer 1: has 1 shared report
    peerDb1.prepare(`
      INSERT INTO myr_reports (id, timestamp, agent_id, node_id, cycle_intent, domain_tags,
        yield_type, question_answered, evidence, what_changes_next, confidence,
        created_at, updated_at, share_network)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('p1-r1', '2026-03-01T10:00:00Z', 'agent1', 'peer1-node',
      'method1', 'testing', 'technique', 'question1', 'evidence1', 'next1',
      0.8, '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', 1);

    // Peer 2: has 1 shared report
    peerDb2.prepare(`
      INSERT INTO myr_reports (id, timestamp, agent_id, node_id, cycle_intent, domain_tags,
        yield_type, question_answered, evidence, what_changes_next, confidence,
        created_at, updated_at, share_network)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('p2-r1', '2026-03-01T10:00:00Z', 'agent1', 'peer2-node',
      'method2', 'testing', 'insight', 'question2', 'evidence2', 'next2',
      0.9, '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', 1);

    // Register our key as trusted on both peers
    peerDb1.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run('http://localhost:9999', 'us', ourKeys.publicKey, 'trusted', new Date().toISOString());

    peerDb2.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run('http://localhost:9999', 'us', ourKeys.publicKey, 'trusted', new Date().toISOString());

    const peerApp1 = createApp({
      config: { node_id: 'peer1-node', operator_name: 'peer1', node_url: 'http://localhost', port: 0 },
      db: peerDb1,
      publicKeyHex: peerKeys1.publicKey,
      createdAt: '2026-03-01T10:00:00Z',
      privateKeyHex: peerKeys1.privateKey,
    });
    peerServer1 = peerApp1.listen(0);
    peerPort1 = peerServer1.address().port;

    const peerApp2 = createApp({
      config: { node_id: 'peer2-node', operator_name: 'peer2', node_url: 'http://localhost', port: 0 },
      db: peerDb2,
      publicKeyHex: peerKeys2.publicKey,
      createdAt: '2026-03-01T10:00:00Z',
      privateKeyHex: peerKeys2.privateKey,
    });
    peerServer2 = peerApp2.listen(0);
    peerPort2 = peerServer2.address().port;

    // Register peers in our DB — peer1 trusted with auto_sync=1, peer2 trusted with auto_sync=0
    cliDb.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, auto_sync) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(`http://localhost:${peerPort1}`, 'peer1', peerKeys1.publicKey, 'trusted', new Date().toISOString(), 1);

    cliDb.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, auto_sync) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(`http://localhost:${peerPort2}`, 'peer2', peerKeys2.publicKey, 'trusted', new Date().toISOString(), 0);
  });

  after(() => {
    peerServer1.close();
    peerServer2.close();
    peerDb1.close();
    peerDb2.close();
    cliDb.close();
  });

  it('syncs all trusted auto_sync peers', async () => {
    // Use the CLI syncPeer to sync peer1 (auto_sync=1)
    const result = await syncPeer({ db: cliDb, peerName: 'peer1', keys: ourKeys });
    assert.equal(result.imported, 1);
    assert.ok(result.message.includes('peer1'));
  });

  it('auto_sync=0 peer is still syncable by name', async () => {
    // Direct sync by name should still work even if auto_sync=0
    const result = await syncPeer({ db: cliDb, peerName: 'peer2', keys: ourKeys });
    assert.equal(result.imported, 1);
    assert.ok(result.message.includes('peer2'));
  });

  it('auto_sync=0 peer is excluded from sync-all query', () => {
    // Verify the query that the CLI sync-all path uses
    const peers = cliDb.prepare("SELECT * FROM myr_peers WHERE trust_level = 'trusted' AND auto_sync = 1").all();
    assert.equal(peers.length, 1);
    assert.equal(peers[0].operator_name, 'peer1');
  });
});

describe('routePeersForSync', () => {
  let db;

  before(() => {
    db = createTestDb();

    const addPeer = db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, auto_sync, last_sync_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    addPeer.run('https://alpha.test', 'alpha', '11'.repeat(32), 'trusted', '2026-03-01T00:00:00Z', 1, '2026-04-14T00:00:00Z');
    addPeer.run('https://beta.test', 'beta', '22'.repeat(32), 'trusted', '2026-03-01T00:00:00Z', 1, '2026-04-15T00:00:00Z');
    addPeer.run('https://gamma.test', 'gamma', '33'.repeat(32), 'trusted', '2026-03-01T00:00:00Z', 1, '2026-04-13T00:00:00Z');
    addPeer.run('https://delta.test', 'delta', '44'.repeat(32), 'trusted', '2026-03-01T00:00:00Z', 1, '2026-04-12T00:00:00Z');

    const addReport = db.prepare(`
      INSERT INTO myr_reports (
        id, timestamp, agent_id, node_id, cycle_intent, domain_tags, yield_type,
        question_answered, evidence, what_changes_next, confidence, operator_rating,
        created_at, updated_at, share_network, imported_from
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // alpha: strongly trusted in security domain
    for (let i = 0; i < 8; i++) {
      addReport.run(
        `alpha-${i}`,
        `2026-04-0${(i % 5) + 1}T00:00:00Z`,
        'agent',
        'node',
        'security method',
        '["security"]',
        'insight',
        'q',
        'e',
        'n',
        0.8,
        4,
        `2026-04-0${(i % 5) + 1}T00:00:00Z`,
        `2026-04-0${(i % 5) + 1}T00:00:00Z`,
        1,
        'alpha'
      );
    }

    // beta: high rating + most recent, but weak domain trust for security
    addReport.run('beta-1', '2026-04-10T00:00:00Z', 'agent', 'node', 'network method', '["networking"]',
      'insight', 'q', 'e', 'n', 0.8, 5, '2026-04-10T00:00:00Z', '2026-04-10T00:00:00Z', 1, 'beta');

    // gamma: one falsification should boost routing inclusion
    addReport.run('gamma-1', '2026-04-09T00:00:00Z', 'agent', 'node', 'security test', '["security"]',
      'falsification', 'q', 'e', 'n', 0.8, 3, '2026-04-09T00:00:00Z', '2026-04-09T00:00:00Z', 1, 'gamma');

    // local reports used for inferred target domains
    addReport.run('local-1', '2026-04-11T00:00:00Z', 'agent', 'node', 'local security', '["security"]',
      'insight', 'q', 'e', 'n', 0.8, 4, '2026-04-11T00:00:00Z', '2026-04-11T00:00:00Z', 1, null);
  });

  after(() => {
    db.close();
  });

  it('orders peers by falsification boost, then domain trust, then rating/recency', () => {
    const peers = db.prepare("SELECT * FROM myr_peers WHERE trust_level = 'trusted' AND auto_sync = 1").all();
    const route = routePeersForSync({
      db,
      peers,
      participationStage: 'trusted-full',
      targetDomains: ['security'],
    });

    assert.equal(route.ranked[0].peer.operator_name, 'gamma');
    assert.equal(route.ranked[1].peer.operator_name, 'alpha');
  });

  it('enforces provisional stage limit of 3 peers', () => {
    const peers = db.prepare("SELECT * FROM myr_peers WHERE trust_level = 'trusted' AND auto_sync = 1").all();
    const route = routePeersForSync({
      db,
      peers,
      participationStage: 'provisional',
      targetDomains: ['security'],
    });

    assert.equal(route.maxSyncPeers, 3);
    assert.equal(route.selected.length, 3);
    assert.equal(route.skipped.length, 1);
  });

  it('infers target domains from recent local shared reports', () => {
    const domains = inferTargetDomains(db);
    assert.ok(domains.includes('security'));
  });
});

// ---------- syncPeer (relay auto-fallback) ----------

describe('syncPeer — relay auto-fallback via nodeConfig', () => {
  let peerServer, peerPort, peerDb, peerKeys, cliDb;
  const ourKeys = generateKeypair();

  before(() => {
    peerKeys = generateKeypair();
    peerDb = createTestDb();
    cliDb = createTestDb();

    peerDb.prepare(`
      INSERT INTO myr_reports (id, timestamp, agent_id, node_id, cycle_intent, domain_tags,
        yield_type, question_answered, evidence, what_changes_next, confidence,
        created_at, updated_at, share_network)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('relay-r1', '2026-03-01T10:00:00Z', 'agent1', 'peer-node',
      'test method', 'testing', 'technique', 'does relay work?', 'yes', 'keep going',
      0.8, '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', 1);

    // Register our key as trusted on the peer
    peerDb.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run('http://localhost:9999', 'us', ourKeys.publicKey, 'trusted', new Date().toISOString());

    const peerApp = createApp({
      config: { node_id: 'peer-node', operator_name: 'relay-peer', node_url: 'https://relay-peer.test', port: 0 },
      db: peerDb,
      publicKeyHex: peerKeys.publicKey,
      createdAt: '2026-03-01T10:00:00Z',
      privateKeyHex: peerKeys.privateKey,
    });
    peerServer = peerApp.listen(0);
    peerPort = peerServer.address().port;

    // Register peer with WRONG URL so direct fetch fails — relay will use correct port
    cliDb.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run('http://localhost:1', 'relay-peer', peerKeys.publicKey, 'trusted', new Date().toISOString());
  });

  after(() => {
    peerServer.close();
    peerDb.close();
    cliDb.close();
  });

  it('auto-falls back to relay when direct connection fails', async () => {
    const http = require('http');
    const { httpFetch } = require('../lib/sync');

    // Start a minimal relay that proxies to the real peer
    const relayServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/myr/relay') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const relayReq = JSON.parse(body);
        const inner = JSON.parse(Buffer.from(relayReq.payload_b64, 'base64').toString('utf8'));

        // Forward inner request to actual peer
        const targetUrl = `http://localhost:${peerPort}${inner.path}`;
        try {
          const proxyRes = await httpFetch(targetUrl, {
            method: inner.method,
            headers: inner.headers || {},
            body: inner.body ? JSON.stringify(inner.body) : undefined,
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: proxyRes.status, body: proxyRes.body, headers: proxyRes.headers }));
        } catch (err) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'relay_error', message: err.message } }));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(r => relayServer.listen(0, r));
    const relayPort = relayServer.address().port;

    try {
      const result = await syncPeer({
        db: cliDb,
        peerName: 'relay-peer',
        keys: ourKeys,
        nodeConfig: {
          relay: { enabled: true, url: `http://localhost:${relayPort}`, fallback_only: true },
        },
      });

      assert.ok(result.imported >= 1, `Expected imported >= 1, got ${result.imported}`);
      assert.equal(result.relayUsed, true, 'Should report relay was used');
      assert.ok(result.message.includes('via relay'), 'Message should mention relay');
    } finally {
      relayServer.close();
    }
  });

  it('succeeds without relay when nodeConfig has no relay configured', async () => {
    // Re-point the peer to the real server for direct connection
    cliDb.prepare('UPDATE myr_peers SET peer_url = ? WHERE operator_name = ?')
      .run(`http://localhost:${peerPort}`, 'relay-peer');

    const result = await syncPeer({
      db: cliDb,
      peerName: 'relay-peer',
      keys: ourKeys,
      nodeConfig: {},
    });

    assert.equal(result.relayUsed, false, 'Relay should not be used for direct connection');
    // already synced relay-r1, so 0 new imports
    assert.equal(result.imported, 0);
  });
});

// ---------- nodeVerify ----------

describe('nodeVerify', () => {
  it('happy path: mock discovery and health, verify succeeds', async () => {
    const keys = generateKeypair();
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomBytes(32).toString('hex');
    const signature = sign(timestamp + nonce, keys.privateKey);

    const mockFetch = async (url) => {
      if (url.includes('/.well-known/myr-node')) {
        return {
          public_key: keys.publicKey,
          operator_name: 'mock-operator',
          fingerprint: computeFingerprint(keys.publicKey),
        };
      }
      if (url.includes('/myr/health')) {
        return {
          status: 'ok',
          liveness_proof: { timestamp, nonce, signature },
        };
      }
    };

    const result = await nodeVerify({
      url: 'http://mock.node:3719',
      fetchFn: mockFetch,
    });
    assert.equal(result.verified, true);
    assert.equal(result.operator_name, 'mock-operator');
    assert.ok(result.fingerprint);
    assert.ok(result.latency_ms >= 0);
  });

  it('unreachable node: returns verified:false with reason', async () => {
    const mockFetch = async () => {
      const err = new Error('connection refused');
      err.code = 'ECONNREFUSED';
      throw err;
    };

    const result = await nodeVerify({
      url: 'http://dead.node:3719',
      fetchFn: mockFetch,
    });
    assert.equal(result.verified, false);
    assert.ok(result.reason.includes('Could not reach'));
  });

  it('missing liveness_proof: returns pre-1.5 message', async () => {
    const keys = generateKeypair();
    const mockFetch = async (url) => {
      if (url.includes('/.well-known/myr-node')) {
        return {
          public_key: keys.publicKey,
          operator_name: 'oldnode',
          fingerprint: computeFingerprint(keys.publicKey),
        };
      }
      return { status: 'ok' }; // no liveness_proof
    };

    const result = await nodeVerify({
      url: 'http://old.node:3719',
      fetchFn: mockFetch,
    });
    assert.equal(result.verified, false);
    assert.ok(result.reason.includes('pre-1.5'));
  });

  it('bad signature: returns signature failure reason', async () => {
    const keys = generateKeypair();
    const otherKeys = generateKeypair();
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomBytes(32).toString('hex');
    // Sign with wrong key
    const signature = sign(timestamp + nonce, otherKeys.privateKey);

    const mockFetch = async (url) => {
      if (url.includes('/.well-known/myr-node')) {
        return {
          public_key: keys.publicKey,
          operator_name: 'bad-node',
          fingerprint: computeFingerprint(keys.publicKey),
        };
      }
      return {
        status: 'ok',
        liveness_proof: { timestamp, nonce, signature },
      };
    };

    const result = await nodeVerify({
      url: 'http://bad.node:3719',
      fetchFn: mockFetch,
    });
    assert.equal(result.verified, false);
    assert.ok(result.reason.includes('Signature verification failed'));
  });

  it('stale timestamp: returns stale message', async () => {
    const keys = generateKeypair();
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const nonce = crypto.randomBytes(32).toString('hex');
    const signature = sign(staleTime + nonce, keys.privateKey);

    const mockFetch = async (url) => {
      if (url.includes('/.well-known/myr-node')) {
        return {
          public_key: keys.publicKey,
          operator_name: 'stale-node',
          fingerprint: computeFingerprint(keys.publicKey),
        };
      }
      return {
        status: 'ok',
        liveness_proof: { timestamp: staleTime, nonce, signature },
      };
    };

    const result = await nodeVerify({
      url: 'http://stale.node:3719',
      fetchFn: mockFetch,
    });
    assert.equal(result.verified, false);
    assert.ok(result.reason.includes('stale'), `Expected 'stale' in reason, got: ${result.reason}`);
  });
});

// ---------- announceTo ----------

describe('announceTo', () => {
  let peerServer, peerPort, peerDb, peerKeys;
  let ourServer, ourPort, ourDb;
  let cliDb;
  const ourKeys = generateKeypair();

  before(() => {
    peerKeys = generateKeypair();
    peerDb = createTestDb();
    ourDb = createTestDb();
    cliDb = createTestDb();

    // Set up peer server with auto-approve enabled
    const peerApp = createApp({
      config: {
        node_id: 'announce-peer',
        operator_name: 'announce-target',
        node_url: 'http://localhost',
        port: 0,
        auto_approve_verified_peers: true,
        auto_approve_min_protocol_version: '1.2.0',
      },
      db: peerDb,
      publicKeyHex: peerKeys.publicKey,
      privateKeyHex: peerKeys.privateKey,
      createdAt: '2026-03-01T10:00:00Z',
    });
    peerServer = peerApp.listen(0);
    peerPort = peerServer.address().port;

    // Set up our own server so the peer can fetch our discovery doc
    const ourApp = createApp({
      config: {
        node_id: 'our-node',
        operator_name: 'test-announcer',
        node_url: 'http://localhost',
        port: 0,
      },
      db: ourDb,
      publicKeyHex: ourKeys.publicKey,
      privateKeyHex: ourKeys.privateKey,
      createdAt: '2026-03-01T10:00:00Z',
    });
    ourServer = ourApp.listen(0);
    ourPort = ourServer.address().port;
  });

  after(() => {
    peerServer.close();
    ourServer.close();
    peerDb.close();
    ourDb.close();
    cliDb.close();
  });

  it('happy path: announce to URL, get connected/verified', async () => {
    const result = await announceTo({
      db: cliDb,
      config: {
        operator_name: 'test-announcer',
        node_url: `http://localhost:${ourPort}`,
        port: ourPort,
        node_uuid: 'test-uuid-123',
      },
      target: `http://localhost:${peerPort}`,
      keys: ourKeys,
    });

    assert.ok(result.status);
    assert.ok(['connected', 'verified', 'pending'].includes(result.status),
      `Expected connected/verified/pending, got: ${result.status}`);
  });

  it('announce to known peer by name', async () => {
    // Register the peer in our DB first
    cliDb.prepare(
      'INSERT OR IGNORE INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run(`http://localhost:${peerPort}`, 'announce-target', peerKeys.publicKey, 'pending', new Date().toISOString());

    const result = await announceTo({
      db: cliDb,
      config: {
        operator_name: 'test-announcer',
        node_url: `http://localhost:${ourPort}`,
        port: ourPort,
      },
      target: 'announce-target',
      keys: ourKeys,
    });

    assert.ok(result.status);
  });

  it('throws for unknown peer name', async () => {
    await assert.rejects(
      () => announceTo({
        db: cliDb,
        config: { operator_name: 'test', node_url: 'http://localhost:9999' },
        target: 'nonexistent-peer',
        keys: ourKeys,
      }),
      /No peer found/
    );
  });
});

// ---------- verifyPeer ----------

describe('verifyPeer', () => {
  let peerServer, peerPort, peerDb, peerKeys, cliDb;

  before(() => {
    peerKeys = generateKeypair();
    peerDb = createTestDb();
    cliDb = createTestDb();

    const peerApp = createApp({
      config: {
        node_id: 'verify-peer-node',
        operator_name: 'verify-target',
        node_url: 'http://localhost',
        port: 0,
      },
      db: peerDb,
      publicKeyHex: peerKeys.publicKey,
      createdAt: '2026-03-01T10:00:00Z',
    });
    peerServer = peerApp.listen(0);
    peerPort = peerServer.address().port;

    // Register peer in our DB with matching key
    cliDb.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run(`http://localhost:${peerPort}`, 'verify-target', peerKeys.publicKey, 'pending', new Date().toISOString());
  });

  after(() => {
    peerServer.close();
    peerDb.close();
    cliDb.close();
  });

  it('happy path: all 3 checks pass', async () => {
    const result = await verifyPeer({
      db: cliDb,
      target: 'verify-target',
    });

    assert.equal(result.verified, true);
    assert.equal(result.operator_name, 'verify-target');
    assert.ok(result.fingerprint.startsWith('SHA-256:'));
  });

  it('fails when discovery returns different key', async () => {
    const otherKeys = generateKeypair();
    const badKeys = generateKeypair();

    // Use a separate in-memory DB to avoid UNIQUE conflicts
    const db2 = createTestDb();
    db2.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run('http://fake-peer:3719', 'fake-peer', otherKeys.publicKey, 'pending', new Date().toISOString());

    // Mock fetch returns a discovery doc with a different key
    const mockFetchFn = async () => ({
      public_key: badKeys.publicKey,
      fingerprint: computeFingerprint(badKeys.publicKey),
      operator_name: 'fake-peer',
    });

    const result = await verifyPeer({
      db: db2,
      target: 'fake-peer',
      fetchFn: mockFetchFn,
    });

    assert.equal(result.verified, false);
    assert.ok(result.reason, 'Expected a failure reason');
    db2.close();
  });

  it('throws for unknown peer', async () => {
    await assert.rejects(
      () => verifyPeer({ db: cliDb, target: 'nobody' }),
      /No peer found/
    );
  });
});

describe('publishSubscription', () => {
  let db;
  const keys = generateKeypair();

  before(() => {
    db = createTestDb();
    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run('http://peer-a.test', 'peer-a', 'aa'.repeat(32), 'trusted', new Date().toISOString());
  });

  after(() => db.close());

  it('stores active local subscription signals', async () => {
    const result = await publishSubscription({
      db,
      keys,
      operatorName: 'local-op',
      tags: ['cryptography'],
      intentDescription: 'need crypto yield',
      status: 'active',
      hops: 0,
    });

    assert.equal(result.subscription.status, 'active');
    assert.deepEqual(result.subscription.tags, ['cryptography']);
    assert.equal(result.propagation.attempted, 0);
  });

  it('updates the same signal to inactive on unsubscribe', async () => {
    await publishSubscription({
      db,
      keys,
      operatorName: 'local-op',
      tags: ['cryptography'],
      status: 'inactive',
      hops: 0,
    });

    const row = db.prepare(
      'SELECT status FROM myr_subscriptions WHERE owner_public_key = ?'
    ).get(keys.publicKey);
    assert.equal(row.status, 'inactive');
  });
});

describe('auto-sync interval settings', () => {
  it('parses duration strings with units', () => {
    assert.equal(parseDurationMs('15m', 123), 15 * 60 * 1000);
    assert.equal(parseDurationMs('2h', 123), 2 * 60 * 60 * 1000);
    assert.equal(parseDurationMs('45s', 123), 45 * 1000);
  });

  it('falls back when duration strings are invalid', () => {
    assert.equal(parseDurationMs('', 777), 777);
    assert.equal(parseDurationMs('invalid', 777), 777);
    assert.equal(parseDurationMs('0m', 777), 777);
  });

  it('enforces minimum sync interval floor', () => {
    const settings = getAutoSyncSettings({
      auto_sync_interval: '5m',
      min_sync_interval: '15m',
    });
    assert.equal(settings.intervalMs, 15 * 60 * 1000);
    assert.equal(settings.minIntervalMs, 15 * 60 * 1000);
    assert.equal(settings.intervalLabel, '15m');
  });

  it('supports disabling auto-sync explicitly', () => {
    const settings = getAutoSyncSettings({
      auto_sync: false,
      auto_sync_interval: '1h',
    });
    assert.equal(settings.enabled, false);
    assert.equal(settings.intervalMs, 60 * 60 * 1000);
  });
});
