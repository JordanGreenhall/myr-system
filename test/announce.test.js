'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair } = require('../lib/crypto');
const { signRequest } = require('./helpers/signRequest');

function request(port, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

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
      share_network INTEGER DEFAULT 0
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

const OUR_PUBLIC_KEY_HEX = 'ab'.repeat(32);
const OUR_CREATED_AT = '2026-03-01T10:00:00Z';
const TEST_CONFIG = {
  node_id: 'test-node',
  operator_name: 'testoperator',
  node_url: 'https://test.myr.network',
  port: 0,
};

const peerKeys = generateKeypair();

function makeAnnounceBody(overrides = {}) {
  return {
    peer_url: 'https://newpeer.myr.network',
    public_key: peerKeys.publicKey,
    operator_name: 'newpeer',
    timestamp: new Date().toISOString(),
    nonce: require('crypto').randomBytes(32).toString('hex'),
    ...overrides,
  };
}

describe('POST /myr/peers/announce', () => {
  let server, port, db;

  before(() => {
    db = createTestDb();
    const app = createApp({
      config: TEST_CONFIG,
      db,
      publicKeyHex: OUR_PUBLIC_KEY_HEX,
      createdAt: OUR_CREATED_AT,
    });
    server = app.listen(0);
    port = server.address().port;
  });

  after(() => {
    server.close();
    db.close();
  });

  it('valid announce from unknown peer succeeds with pending_approval', async () => {
    const body = makeAnnounceBody();
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: peerKeys.privateKey,
      publicKey: peerKeys.publicKey,
    });

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'pending_approval');
    assert.equal(res.body.message, 'Peer request received. Awaiting operator approval.');
    assert.equal(res.body.approval_required, true);
  });

  it('response includes our_public_key', async () => {
    const peerKeys2 = generateKeypair();
    const body = makeAnnounceBody({
      public_key: peerKeys2.publicKey,
      operator_name: 'peer2',
      peer_url: 'https://peer2.myr.network',
    });
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: peerKeys2.privateKey,
      publicKey: peerKeys2.publicKey,
    });

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.our_public_key, OUR_PUBLIC_KEY_HEX);
  });

  it('peer stored in database with trust_level=pending', async () => {
    const peerKeys3 = generateKeypair();
    const body = makeAnnounceBody({
      public_key: peerKeys3.publicKey,
      operator_name: 'peer3',
      peer_url: 'https://peer3.myr.network',
    });
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: peerKeys3.privateKey,
      publicKey: peerKeys3.publicKey,
    });

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    assert.equal(res.status, 200);

    const row = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?')
      .get(peerKeys3.publicKey);
    assert.ok(row, 'peer should be stored in database');
    assert.equal(row.trust_level, 'pending');
    assert.equal(row.operator_name, 'peer3');
    assert.equal(row.peer_url, 'https://peer3.myr.network');
    assert.ok(row.added_at, 'added_at should be set');
  });

  it('400 key_mismatch when body and header keys differ', async () => {
    const otherKeys = generateKeypair();
    const body = makeAnnounceBody({
      public_key: 'ff'.repeat(32),
      peer_url: 'https://mismatch.myr.network',
    });
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: otherKeys.privateKey,
      publicKey: otherKeys.publicKey,
    });

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'key_mismatch');
  });

  it('400 invalid_request for missing required fields', async () => {
    const missingKeys = generateKeypair();
    const requiredFields = ['peer_url', 'public_key', 'operator_name', 'timestamp', 'nonce'];

    for (const field of requiredFields) {
      const body = makeAnnounceBody({
        public_key: missingKeys.publicKey,
        peer_url: `https://missing-${field}.myr.network`,
      });
      delete body[field];

      const signed = signRequest({
        method: 'POST',
        path: '/myr/peers/announce',
        body,
        privateKey: missingKeys.privateKey,
        publicKey: missingKeys.publicKey,
      });

      const res = await request(port, {
        method: 'POST',
        path: '/myr/peers/announce',
        headers: signed.headers,
        body,
      });

      assert.equal(res.status, 400, `should be 400 when missing ${field}`);
      assert.equal(res.body.error.code, 'invalid_request',
        `should be invalid_request when missing ${field}`);
      assert.ok(res.body.error.message.includes(field),
        `error message should mention missing field: ${field}`);
    }
  });

  it('409 conflict when pending peer re-announces', async () => {
    const body = makeAnnounceBody();
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: peerKeys.privateKey,
      publicKey: peerKeys.publicKey,
    });

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'peer_exists');
  });

  it('trusted peer re-announcing is auto-approved with updated URL', async () => {
    const trustedKeys = generateKeypair();
    const newUrl = 'https://trusted-peer-new-ip.myr.network';

    // Seed a trusted peer into the DB directly
    db.prepare(
      `INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at)
       VALUES (?, ?, ?, 'trusted', ?, ?)`
    ).run('https://trusted-peer-old-ip.myr.network', 'trustedpeer',
      trustedKeys.publicKey, new Date().toISOString(), new Date().toISOString());

    const body = makeAnnounceBody({
      public_key: trustedKeys.publicKey,
      operator_name: 'trustedpeer',
      peer_url: newUrl,
    });
    const signed = signRequest({
      method: 'POST',
      path: '/myr/peers/announce',
      body,
      privateKey: trustedKeys.privateKey,
      publicKey: trustedKeys.publicKey,
    });

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      headers: signed.headers,
      body,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'connected');
    assert.equal(res.body.approval_required, false);
    assert.ok(res.body.our_public_key, 'response should include our public key');

    // URL should be updated in DB
    const row = db.prepare('SELECT peer_url, trust_level FROM myr_peers WHERE public_key = ?')
      .get(trustedKeys.publicKey);
    assert.equal(row.peer_url, newUrl);
    assert.equal(row.trust_level, 'trusted');
  });

  it('401 without auth headers', async () => {
    const body = makeAnnounceBody();

    const res = await request(port, {
      method: 'POST',
      path: '/myr/peers/announce',
      body,
    });

    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'auth_required');
  });
});
