'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { canonicalize } = require('../lib/canonicalize');
const { verifyRegistrySignature, syncRegistry, upsertPeer, applyRevocation } = require('../scripts/myr-sync-registry');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Generate a fresh Ed25519 keypair for testing.
 * Returns { privateKeyPem, publicKeyPem, publicKeyHex }
 */
function makeTestKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyHex = spkiDer.slice(-32).toString('hex');
  return { privateKeyPem, publicKeyPem, publicKeyHex };
}

/**
 * Sign a registry-style payload (nodes or revoked) using the test private key.
 * Returns the complete signed object.
 */
function signTestPayload(payload, privateKeyPem) {
  const privKey = crypto.createPrivateKey(privateKeyPem);

  const signable = {};
  for (const k of Object.keys(payload).sort()) {
    signable[k] = payload[k];
  }

  const canonical = canonicalize(signable);
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privKey).toString('hex');

  return { ...payload, signature: sig };
}

/**
 * Create an in-memory SQLite DB with the myr_peers schema.
 */
function makeTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE myr_peers (
      node_id TEXT PRIMARY KEY,
      node_name TEXT,
      public_key TEXT NOT NULL,
      public_key_format TEXT DEFAULT 'pem',
      added_at TEXT NOT NULL,
      last_import_at TEXT,
      myr_count INTEGER DEFAULT 0,
      peer_url TEXT,
      operator_name TEXT,
      trust_level TEXT DEFAULT 'pending',
      approved_at TEXT,
      last_sync_at TEXT,
      auto_sync INTEGER DEFAULT 1,
      notes TEXT
    );
  `);
  return db;
}

/**
 * Create an in-memory config store for tests (avoids touching config.json).
 */
function makeConfigStore(initialVersion = 0) {
  let v = initialVersion;
  return { get: () => v, set: (val) => { v = val; } };
}

/**
 * Build a minimal nodes registry object.
 */
function makeNodesRegistry(kp, nodes, version = 1) {
  const payload = {
    nodes,
    signed_at: new Date().toISOString(),
    version,
  };
  return signTestPayload(payload, kp.privateKeyPem);
}

/**
 * Build a minimal revocation registry object.
 */
function makeRevokedRegistry(kp, revoked, version = 1) {
  const payload = {
    revoked,
    signed_at: new Date().toISOString(),
    version,
  };
  return signTestPayload(payload, kp.privateKeyPem);
}

// ---------------------------------------------------------------------------
// Tests: verifyRegistrySignature
// ---------------------------------------------------------------------------

describe('verifyRegistrySignature', () => {
  it('accepts a valid signed nodes registry', () => {
    const kp = makeTestKeypair();
    const registry = makeNodesRegistry(kp, []);
    assert.ok(verifyRegistrySignature(registry, kp.publicKeyHex));
  });

  it('accepts a valid signed revocation list', () => {
    const kp = makeTestKeypair();
    const rev = makeRevokedRegistry(kp, []);
    assert.ok(verifyRegistrySignature(rev, kp.publicKeyHex));
  });

  it('rejects a tampered nodes array', () => {
    const kp = makeTestKeypair();
    const registry = makeNodesRegistry(kp, []);
    const tampered = { ...registry, nodes: [{ node_id: 'evil', url: 'http://evil.example' }] };
    assert.ok(!verifyRegistrySignature(tampered, kp.publicKeyHex));
  });

  it('rejects a wrong signing key', () => {
    const kp1 = makeTestKeypair();
    const kp2 = makeTestKeypair();
    const registry = makeNodesRegistry(kp1, []);
    assert.ok(!verifyRegistrySignature(registry, kp2.publicKeyHex));
  });

  it('rejects a missing signature', () => {
    const kp = makeTestKeypair();
    const registry = makeNodesRegistry(kp, []);
    const { signature: _, ...noSig } = registry;
    assert.ok(!verifyRegistrySignature(noSig, kp.publicKeyHex));
  });

  it('rejects a corrupted signature', () => {
    const kp = makeTestKeypair();
    const registry = makeNodesRegistry(kp, []);
    const corrupted = { ...registry, signature: 'ff' + registry.signature.slice(2) };
    assert.ok(!verifyRegistrySignature(corrupted, kp.publicKeyHex));
  });

  it('rejects a tampered version field', () => {
    const kp = makeTestKeypair();
    const registry = makeNodesRegistry(kp, [], 1);
    const tampered = { ...registry, version: 999 };
    assert.ok(!verifyRegistrySignature(tampered, kp.publicKeyHex));
  });
});

// ---------------------------------------------------------------------------
// Tests: upsertPeer
// ---------------------------------------------------------------------------

describe('upsertPeer', () => {
  it('inserts a new peer as pending', () => {
    const db = makeTestDb();
    const { publicKeyPem } = makeTestKeypair();
    const node = {
      node_id: 'n42',
      operator: 'alice',
      url: 'http://alice.example:3719',
      public_key: publicKeyPem,
      registered_at: new Date().toISOString(),
    };

    const inserted = upsertPeer(db, node);
    assert.ok(inserted);

    const row = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(publicKeyPem);
    assert.ok(row);
    assert.equal(row.trust_level, 'pending');
    assert.equal(row.operator_name, 'alice');
    assert.equal(row.peer_url, 'http://alice.example:3719');
  });

  it('does not insert the same peer twice', () => {
    const db = makeTestDb();
    const { publicKeyPem } = makeTestKeypair();
    const node = {
      node_id: 'n43',
      operator: 'bob',
      url: 'http://bob.example:3719',
      public_key: publicKeyPem,
      registered_at: new Date().toISOString(),
    };

    const first = upsertPeer(db, node);
    const second = upsertPeer(db, node);
    assert.ok(first);
    assert.ok(!second);

    const rows = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').all(publicKeyPem);
    assert.equal(rows.length, 1);
  });

  it('does not downgrade a trusted peer', () => {
    const db = makeTestDb();
    const { publicKeyPem } = makeTestKeypair();
    const now = new Date().toISOString();

    // Pre-insert as trusted
    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at)
      VALUES (?, ?, ?, 'trusted', ?)
    `).run('http://trusted.example:3719', 'carol', publicKeyPem, now);

    const node = {
      node_id: 'n44',
      operator: 'carol',
      url: 'http://trusted.example:3719',
      public_key: publicKeyPem,
      registered_at: now,
    };

    const inserted = upsertPeer(db, node);
    assert.ok(!inserted); // already exists

    const row = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(publicKeyPem);
    assert.equal(row.trust_level, 'trusted'); // still trusted
  });
});

// ---------------------------------------------------------------------------
// Tests: applyRevocation
// ---------------------------------------------------------------------------

describe('applyRevocation', () => {
  it('sets trust_level=rejected for a known peer', () => {
    const db = makeTestDb();
    const { publicKeyPem } = makeTestKeypair();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at)
      VALUES (?, ?, ?, 'trusted', ?)
    `).run('http://badnode.example:3719', 'badactor', publicKeyPem, now);

    const applied = applyRevocation(db, { node_id: 'n-bad', public_key: publicKeyPem });
    assert.ok(applied);

    const row = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(publicKeyPem);
    assert.equal(row.trust_level, 'rejected');
  });

  it('returns false for unknown peer (no-op)', () => {
    const db = makeTestDb();
    const { publicKeyPem } = makeTestKeypair();

    const applied = applyRevocation(db, { node_id: 'unknown', public_key: publicKeyPem });
    assert.ok(!applied);
  });

  it('is idempotent for already-rejected peers', () => {
    const db = makeTestDb();
    const { publicKeyPem } = makeTestKeypair();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at)
      VALUES (?, ?, ?, 'rejected', ?)
    `).run('http://rejected.example:3719', 'badactor', publicKeyPem, now);

    const applied = applyRevocation(db, { node_id: 'n-bad', public_key: publicKeyPem });
    assert.ok(!applied); // no change needed

    const row = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(publicKeyPem);
    assert.equal(row.trust_level, 'rejected');
  });
});

// ---------------------------------------------------------------------------
// Tests: syncRegistry (end-to-end with mocked fetch)
// ---------------------------------------------------------------------------

describe('syncRegistry', () => {
  it('adds new peers and returns correct summary', async () => {
    const db = makeTestDb();
    const kp = makeTestKeypair();
    const { publicKeyPem } = makeTestKeypair(); // node's key

    const nodes = [
      {
        node_id: 'n10',
        operator: 'dave',
        url: 'http://dave.example:3719',
        public_key: publicKeyPem,
        registered_at: new Date().toISOString(),
      },
    ];

    const registry = makeNodesRegistry(kp, nodes, 1);
    const revocation = makeRevokedRegistry(kp, [], 1);

    // Mock fetch: return pre-built objects
    async function mockFetch(url) {
      if (url.includes('nodes')) return registry;
      if (url.includes('revoked')) return revocation;
      throw new Error('Unknown URL: ' + url);
    }

    const summary = await syncRegistry({
      db,
      fetch: mockFetch,
      signingKeyHex: kp.publicKeyHex,
      registryUrl: 'https://example.com/nodes.json',
      revocationUrl: 'https://example.com/revoked.json',
      configStore: makeConfigStore(),
    });

    assert.equal(summary.newPeers, 1);
    assert.equal(summary.revocations, 0);
    assert.equal(summary.registryVersion, 1);

    const row = db.prepare('SELECT * FROM myr_peers WHERE operator_name = ?').get('dave');
    assert.ok(row);
    assert.equal(row.trust_level, 'pending');
  });

  it('rejects registry with invalid signature', async () => {
    const db = makeTestDb();
    const kp = makeTestKeypair();
    const wrongKp = makeTestKeypair();

    // Sign with correct key but verify against wrong key
    const registry = makeNodesRegistry(kp, [], 1);

    async function mockFetch() { return registry; }

    await assert.rejects(
      syncRegistry({
        db,
        fetch: mockFetch,
        signingKeyHex: wrongKp.publicKeyHex,
        registryUrl: 'https://example.com/nodes.json',
        revocationUrl: 'https://example.com/revoked.json',
        configStore: makeConfigStore(),
      }),
      /signature verification FAILED/i
    );
  });

  it('rejects replay: version <= stored version', async () => {
    const db = makeTestDb();
    const kp = makeTestKeypair();

    const registry = makeNodesRegistry(kp, [], 1);
    const revocation = makeRevokedRegistry(kp, [], 1);

    async function mockFetch(url) {
      if (url.includes('nodes')) return registry;
      return revocation;
    }

    const configStore = makeConfigStore();

    // First sync succeeds (stored version goes to 1)
    await syncRegistry({
      db,
      fetch: mockFetch,
      signingKeyHex: kp.publicKeyHex,
      registryUrl: 'https://example.com/nodes.json',
      revocationUrl: 'https://example.com/revoked.json',
      configStore,
    });

    // Second sync with same version (1 <= 1) should be rejected
    await assert.rejects(
      syncRegistry({
        db,
        fetch: mockFetch,
        signingKeyHex: kp.publicKeyHex,
        registryUrl: 'https://example.com/nodes.json',
        revocationUrl: 'https://example.com/revoked.json',
        configStore,
      }),
      /Rejecting replay/i
    );
  });

  it('applies revocations to existing peers', async () => {
    const db = makeTestDb();
    const kp = makeTestKeypair();
    const { publicKeyPem } = makeTestKeypair();
    const now = new Date().toISOString();

    // Pre-insert a peer as trusted
    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at)
      VALUES (?, ?, ?, 'trusted', ?)
    `).run('http://victim.example:3719', 'victim', publicKeyPem, now);

    const nodes = [];
    const revoked = [{ node_id: 'n-victim', public_key: publicKeyPem }];

    const registry = makeNodesRegistry(kp, nodes, 1);
    const revocation = makeRevokedRegistry(kp, revoked, 1);

    async function mockFetch(url) {
      if (url.includes('nodes')) return registry;
      return revocation;
    }

    const summary = await syncRegistry({
      db,
      fetch: mockFetch,
      signingKeyHex: kp.publicKeyHex,
      registryUrl: 'https://example.com/nodes.json',
      revocationUrl: 'https://example.com/revoked.json',
      configStore: makeConfigStore(),
    });

    assert.equal(summary.revocations, 1);

    const row = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(publicKeyPem);
    assert.equal(row.trust_level, 'rejected');
  });

  it('does not downgrade trusted peers added by registry', async () => {
    const db = makeTestDb();
    const kp = makeTestKeypair();
    const { publicKeyPem } = makeTestKeypair();
    const now = new Date().toISOString();

    // Pre-insert as trusted
    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at)
      VALUES (?, ?, ?, 'trusted', ?)
    `).run('http://trusted.example:3719', 'trustedguy', publicKeyPem, now);

    const nodes = [{
      node_id: 'n-trusted',
      operator: 'trustedguy',
      url: 'http://trusted.example:3719',
      public_key: publicKeyPem,
      registered_at: now,
    }];

    const registry = makeNodesRegistry(kp, nodes, 1);
    const revocation = makeRevokedRegistry(kp, [], 1);

    async function mockFetch(url) {
      if (url.includes('nodes')) return registry;
      return revocation;
    }

    const summary = await syncRegistry({
      db,
      fetch: mockFetch,
      signingKeyHex: kp.publicKeyHex,
      registryUrl: 'https://example.com/nodes.json',
      revocationUrl: 'https://example.com/revoked.json',
      configStore: makeConfigStore(),
    });

    assert.equal(summary.newPeers, 0); // already existed

    const row = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(publicKeyPem);
    assert.equal(row.trust_level, 'trusted'); // still trusted
  });
});
