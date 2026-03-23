'use strict';

const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { generateKeypair, sign, verify } = require('./crypto');
const { canonicalize } = require('./canonicalize');

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

const MYR_DIR = '.myr';
const DEFAULT_KEY_FILENAME = 'node.key';
const DEFAULT_CONFIG_FILENAME = 'config.json';

/**
 * Resolve the default MYR home directory: ~/.myr
 * @returns {string}
 */
function myrHome() {
  return path.join(os.homedir(), MYR_DIR);
}

/**
 * Resolve the keypair path.
 * @param {string} [keyPath] - explicit override; defaults to ~/.myr/keys/node.key
 * @returns {string}
 */
function resolveKeyPath(keyPath) {
  if (keyPath) return keyPath;
  return path.join(myrHome(), 'keys', DEFAULT_KEY_FILENAME);
}

/**
 * Resolve the config file path.
 * Precedence: explicit arg > MYR_CONFIG env > ~/.myr/config.json
 * @param {string} [configPath]
 * @returns {string}
 */
function resolveConfigPath(configPath) {
  if (configPath) return configPath;
  if (process.env.MYR_CONFIG) return process.env.MYR_CONFIG;
  return path.join(myrHome(), DEFAULT_CONFIG_FILENAME);
}

// ---------------------------------------------------------------------------
// Keypair Storage
// ---------------------------------------------------------------------------

/**
 * Generate a new Ed25519 keypair and persist it as JSON at the given path.
 * Creates parent directories as needed. File permissions: 0o600 (owner-only).
 * @param {string} [keyPath]
 * @returns {{ publicKey: string, privateKey: string, path: string }}
 */
function generateAndStoreKeypair(keyPath) {
  const resolved = resolveKeyPath(keyPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const kp = generateKeypair();
  const payload = JSON.stringify({
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
  });
  fs.writeFileSync(resolved, payload, { encoding: 'utf8', mode: 0o600 });
  return { publicKey: kp.publicKey, privateKey: kp.privateKey, path: resolved };
}

/**
 * Load an existing keypair from disk.
 * @param {string} [keyPath]
 * @returns {{ publicKey: string, privateKey: string }}
 */
function loadKeypair(keyPath) {
  const resolved = resolveKeyPath(keyPath);
  const raw = fs.readFileSync(resolved, 'utf8');
  const data = JSON.parse(raw);
  if (!data.publicKey || !data.privateKey) {
    throw new Error(`Invalid keypair file at ${resolved}: missing publicKey or privateKey`);
  }
  return { publicKey: data.publicKey, privateKey: data.privateKey };
}

// ---------------------------------------------------------------------------
// Fingerprint (spec format: base64url of SHA-256 of raw public key bytes)
// ---------------------------------------------------------------------------

/**
 * Compute the identity fingerprint per MYR v1.0 spec.
 * @param {string} publicKeyHex - 64-char hex Ed25519 public key
 * @returns {string} base64url(sha256(public_key_bytes))
 */
function identityFingerprint(publicKeyHex) {
  const pubBytes = Buffer.from(publicKeyHex, 'hex');
  const hash = createHash('sha256').update(pubBytes).digest();
  return hash.toString('base64url');
}

// ---------------------------------------------------------------------------
// Identity Document
// ---------------------------------------------------------------------------

/**
 * Build and sign an identity document per MYR v1.0 spec.
 *
 * @param {object} params
 * @param {string} params.publicKey      - hex Ed25519 public key
 * @param {string} params.privateKey     - hex Ed25519 private key (for signing)
 * @param {string} params.operator_name  - human-readable operator name
 * @param {string} params.node_url       - public HTTPS URL
 * @param {string[]} [params.capabilities] - e.g. ["report-sync","peer-discovery","incremental-sync"]
 * @param {string} [params.created_at]   - ISO8601; defaults to now
 * @returns {object} the signed identity document
 */
function buildIdentityDocument(params) {
  const {
    publicKey,
    privateKey,
    operator_name,
    node_url,
    capabilities = ['report-sync', 'peer-discovery', 'incremental-sync'],
    created_at = new Date().toISOString(),
  } = params;

  const fp = identityFingerprint(publicKey);

  const doc = {
    protocol_version: '1.0.0',
    public_key: publicKey,
    fingerprint: fp,
    operator_name,
    node_url,
    capabilities,
    created_at,
  };

  // Sign the canonicalized document (all fields except signature, keys sorted)
  const canonical = canonicalize(doc);
  const signature = sign(canonical, privateKey);

  return { ...doc, signature };
}

/**
 * Verify an identity document's signature.
 * @param {object} doc - identity document with signature field
 * @returns {boolean} true if signature is valid
 */
function verifyIdentityDocument(doc) {
  if (!doc || !doc.signature || !doc.public_key) return false;

  // Reconstruct the document without the signature field
  const { signature, ...rest } = doc;
  const canonical = canonicalize(rest);
  return verify(canonical, signature, doc.public_key);
}

// ---------------------------------------------------------------------------
// Config Loader/Writer
// ---------------------------------------------------------------------------

/**
 * Load config from disk. Returns empty object if file doesn't exist.
 * @param {string} [configPath]
 * @returns {object}
 */
function loadConfig(configPath) {
  const resolved = resolveConfigPath(configPath);
  if (!fs.existsSync(resolved)) return {};
  const raw = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(raw);
}

/**
 * Write config to disk. Creates parent directories as needed.
 * @param {object} config
 * @param {string} [configPath]
 */
function writeConfig(config, configPath) {
  const resolved = resolveConfigPath(configPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(resolved, JSON.stringify(config, null, 2), 'utf8');
}

module.exports = {
  myrHome,
  resolveKeyPath,
  resolveConfigPath,
  generateAndStoreKeypair,
  loadKeypair,
  identityFingerprint,
  buildIdentityDocument,
  verifyIdentityDocument,
  loadConfig,
  writeConfig,
};
