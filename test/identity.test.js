'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  generateAndStoreKeypair,
  loadKeypair,
  identityFingerprint,
  buildIdentityDocument,
  verifyIdentityDocument,
  loadConfig,
  writeConfig,
  resolveConfigPath,
} = require('../lib/identity');

// Use a temp directory for all filesystem operations to avoid touching real ~/.myr
const TEST_DIR = path.join(os.tmpdir(), `myr-identity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. Keypair generation produces valid Ed25519 keypair stored at configured path
// ---------------------------------------------------------------------------

describe('keypair generation and storage', () => {
  const keyPath = path.join(TEST_DIR, 'keys', 'node.key');

  before(() => cleanup());
  after(() => cleanup());

  it('generates a keypair and stores it at the configured path', () => {
    const result = generateAndStoreKeypair(keyPath);

    // File exists
    assert.ok(fs.existsSync(keyPath), 'keypair file should exist');

    // Keys are hex-encoded, 64 chars (32 bytes)
    assert.match(result.publicKey, /^[0-9a-f]{64}$/);
    assert.match(result.privateKey, /^[0-9a-f]{64}$/);

    // Path is reported correctly
    assert.equal(result.path, keyPath);
  });

  it('stored keypair can be loaded back', () => {
    const loaded = loadKeypair(keyPath);
    assert.match(loaded.publicKey, /^[0-9a-f]{64}$/);
    assert.match(loaded.privateKey, /^[0-9a-f]{64}$/);
  });

  it('file permissions restrict access (owner-only)', () => {
    const stats = fs.statSync(keyPath);
    // 0o600 = owner read+write only (on systems that support it)
    const mode = stats.mode & 0o777;
    // On macOS/Linux this should be 0o600; skip strict check on Windows
    if (process.platform !== 'win32') {
      assert.equal(mode, 0o600, `expected 0o600 but got 0o${mode.toString(8)}`);
    }
  });

  it('keypair round-trips through sign/verify', () => {
    const loaded = loadKeypair(keyPath);
    const { sign, verify } = require('../lib/crypto');
    const msg = 'round-trip test';
    const sig = sign(msg, loaded.privateKey);
    assert.ok(verify(msg, sig, loaded.publicKey));
  });
});

// ---------------------------------------------------------------------------
// 2. Fingerprint is correct base64url sha256 of raw public key bytes
// ---------------------------------------------------------------------------

describe('fingerprint', () => {
  it('produces a base64url-encoded string (no padding, no + or /)', () => {
    const { generateKeypair } = require('../lib/crypto');
    const kp = generateKeypair();
    const fp = identityFingerprint(kp.publicKey);

    // base64url: [A-Za-z0-9_-], no =, no +, no /
    assert.match(fp, /^[A-Za-z0-9_-]+$/);
  });

  it('is the sha256 of the raw public key bytes', () => {
    const { createHash } = require('crypto');
    const { generateKeypair } = require('../lib/crypto');
    const kp = generateKeypair();

    const expected = createHash('sha256')
      .update(Buffer.from(kp.publicKey, 'hex'))
      .digest('base64url');

    assert.equal(identityFingerprint(kp.publicKey), expected);
  });

  it('is deterministic for the same key', () => {
    const { generateKeypair } = require('../lib/crypto');
    const kp = generateKeypair();
    assert.equal(identityFingerprint(kp.publicKey), identityFingerprint(kp.publicKey));
  });

  it('differs for different keys', () => {
    const { generateKeypair } = require('../lib/crypto');
    const a = generateKeypair();
    const b = generateKeypair();
    assert.notEqual(identityFingerprint(a.publicKey), identityFingerprint(b.publicKey));
  });
});

// ---------------------------------------------------------------------------
// 3. Identity document signature verifies correctly
// ---------------------------------------------------------------------------

describe('identity document builder and verifier', () => {
  it('builds a document with all required fields and a valid signature', () => {
    const { generateKeypair } = require('../lib/crypto');
    const kp = generateKeypair();

    const doc = buildIdentityDocument({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      operator_name: 'test-operator',
      node_url: 'https://test.myr.network',
      created_at: '2026-03-23T00:00:00.000Z',
    });

    // All spec fields present
    assert.equal(doc.protocol_version, '1.0.0');
    assert.equal(doc.public_key, kp.publicKey);
    assert.equal(doc.fingerprint, identityFingerprint(kp.publicKey));
    assert.equal(doc.operator_name, 'test-operator');
    assert.equal(doc.node_url, 'https://test.myr.network');
    assert.ok(Array.isArray(doc.capabilities));
    assert.equal(doc.created_at, '2026-03-23T00:00:00.000Z');
    assert.ok(typeof doc.signature === 'string');

    // Signature verifies
    assert.ok(verifyIdentityDocument(doc));
  });

  it('accepts custom capabilities', () => {
    const { generateKeypair } = require('../lib/crypto');
    const kp = generateKeypair();
    const doc = buildIdentityDocument({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      operator_name: 'test',
      node_url: 'https://test.example.com',
      capabilities: ['report-sync'],
    });
    assert.deepEqual(doc.capabilities, ['report-sync']);
    assert.ok(verifyIdentityDocument(doc));
  });

  it('defaults created_at to current time', () => {
    const { generateKeypair } = require('../lib/crypto');
    const kp = generateKeypair();
    const before = Date.now();
    const doc = buildIdentityDocument({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      operator_name: 'test',
      node_url: 'https://test.example.com',
    });
    const after = Date.now();
    const ts = new Date(doc.created_at).getTime();
    assert.ok(ts >= before && ts <= after, 'created_at should default to now');
  });
});

// ---------------------------------------------------------------------------
// 4. Config path resolution: ~ expands via os.homedir(), never literal path
// ---------------------------------------------------------------------------

describe('config loader and writer', () => {
  const configDir = path.join(TEST_DIR, 'config-test');
  const configPath = path.join(configDir, 'config.json');

  after(() => cleanup());

  it('resolveConfigPath uses MYR_CONFIG env when set', () => {
    const original = process.env.MYR_CONFIG;
    try {
      process.env.MYR_CONFIG = '/custom/path/config.json';
      const resolved = resolveConfigPath();
      assert.equal(resolved, '/custom/path/config.json');
    } finally {
      if (original === undefined) {
        delete process.env.MYR_CONFIG;
      } else {
        process.env.MYR_CONFIG = original;
      }
    }
  });

  it('resolveConfigPath defaults to os.homedir()/.myr/config.json', () => {
    const original = process.env.MYR_CONFIG;
    try {
      delete process.env.MYR_CONFIG;
      const resolved = resolveConfigPath();
      const expected = path.join(os.homedir(), '.myr', 'config.json');
      assert.equal(resolved, expected);
      // Verify the path is built from os.homedir(), not a literal string in source.
      // We check that the resolved path starts with the dynamic homedir value.
      assert.ok(resolved.startsWith(os.homedir()), 'path should start with os.homedir()');
      assert.ok(resolved.endsWith(path.join('.myr', 'config.json')), 'path should end with .myr/config.json');
    } finally {
      if (original !== undefined) {
        process.env.MYR_CONFIG = original;
      }
    }
  });

  it('writes and reads config correctly', () => {
    const config = {
      node_url: 'https://test.myr.network',
      port: 3719,
      operator_name: 'test-node',
    };
    writeConfig(config, configPath);
    assert.ok(fs.existsSync(configPath));

    const loaded = loadConfig(configPath);
    assert.deepEqual(loaded, config);
  });

  it('loadConfig returns empty object if file does not exist', () => {
    const nonexistent = path.join(TEST_DIR, 'nonexistent', 'config.json');
    const result = loadConfig(nonexistent);
    assert.deepEqual(result, {});
  });

  it('source code contains no hard-coded home directory paths', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'identity.js'), 'utf8');
    // Must not contain literal /Users/ or /home/ paths
    assert.ok(!/\/Users\/\w+/.test(source), 'identity.js must not contain /Users/<username> paths');
    assert.ok(!/\/home\/\w+/.test(source), 'identity.js must not contain /home/<username> paths');
    // Must use os.homedir()
    assert.ok(source.includes('os.homedir()'), 'identity.js must use os.homedir() for path resolution');
  });
});

// ---------------------------------------------------------------------------
// 5. Tampered identity document fails verification
// ---------------------------------------------------------------------------

describe('tampered identity document rejection', () => {
  it('rejects a document with a modified operator_name', () => {
    const { generateKeypair } = require('../lib/crypto');
    const kp = generateKeypair();
    const doc = buildIdentityDocument({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      operator_name: 'original',
      node_url: 'https://original.myr.network',
    });

    // Tamper
    const tampered = { ...doc, operator_name: 'attacker' };
    assert.ok(!verifyIdentityDocument(tampered));
  });

  it('rejects a document with a modified node_url', () => {
    const { generateKeypair } = require('../lib/crypto');
    const kp = generateKeypair();
    const doc = buildIdentityDocument({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      operator_name: 'test',
      node_url: 'https://legit.myr.network',
    });

    const tampered = { ...doc, node_url: 'https://evil.example.com' };
    assert.ok(!verifyIdentityDocument(tampered));
  });

  it('rejects a document with a swapped public key', () => {
    const { generateKeypair } = require('../lib/crypto');
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    const doc = buildIdentityDocument({
      publicKey: kp1.publicKey,
      privateKey: kp1.privateKey,
      operator_name: 'test',
      node_url: 'https://test.myr.network',
    });

    // Swap public key to kp2 — signature won't match
    const tampered = { ...doc, public_key: kp2.publicKey };
    assert.ok(!verifyIdentityDocument(tampered));
  });

  it('rejects a document with a corrupted signature', () => {
    const { generateKeypair } = require('../lib/crypto');
    const kp = generateKeypair();
    const doc = buildIdentityDocument({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      operator_name: 'test',
      node_url: 'https://test.myr.network',
    });

    const tampered = { ...doc, signature: 'ff' + doc.signature.slice(2) };
    assert.ok(!verifyIdentityDocument(tampered));
  });

  it('rejects null/undefined/missing fields', () => {
    assert.ok(!verifyIdentityDocument(null));
    assert.ok(!verifyIdentityDocument(undefined));
    assert.ok(!verifyIdentityDocument({}));
    assert.ok(!verifyIdentityDocument({ signature: 'abc' }));
  });
});
