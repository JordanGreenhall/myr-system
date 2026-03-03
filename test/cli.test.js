'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair, fingerprint: computeFingerprint } = require('../lib/crypto');
const {
  findPeer,
  addPeer,
  approvePeer,
  rejectPeer,
  listPeers,
  getFingerprint,
  getPeerFingerprint,
  syncPeer,
} = require('../bin/myr');

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
      import_verified INTEGER DEFAULT 0
    );

    CREATE TABLE myr_peers (
      id INTEGER PRIMARY KEY,
      peer_url TEXT UNIQUE NOT NULL,
      operator_name TEXT NOT NULL,
      public_key TEXT UNIQUE NOT NULL,
      trust_level TEXT CHECK(trust_level IN ('trusted', 'pending', 'rejected')) DEFAULT 'pending',
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

function seedPeers(db) {
  const insert = db.prepare(
    'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, last_sync_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insert.run('https://gary.myr.network', 'gary', 'aa'.repeat(32), 'trusted', '2026-02-28T12:00:00Z', '2026-03-01T10:30:00Z');
  insert.run('https://jared.myr.network', 'jared', 'bb'.repeat(32), 'pending', '2026-03-01T08:00:00Z', null);
  insert.run('https://eve.myr.network', 'eve', 'cc'.repeat(32), 'rejected', '2026-02-27T08:00:00Z', null);
}

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
    assert.equal(remotePeer.trust_level, 'pending');
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
