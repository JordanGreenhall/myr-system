#!/usr/bin/env node
'use strict';

/**
 * myr-sync-registry.js
 *
 * Fetches the signed MYR node registry and revocation list from GitHub,
 * verifies signatures, and applies updates to the local myr_peers table.
 *
 * Steps:
 *  1. Fetch REGISTRY_URL and REVOCATION_URL
 *  2. Verify Ed25519 signatures against pinned NETWORK_SIGNING_KEY_HEX
 *  3. Reject if version ≤ stored registry_version (replay protection)
 *  4. Upsert new peers with trust_level='pending' (don't downgrade existing)
 *  5. Apply revocations: set trust_level='rejected' for revoked keys
 *  6. Update registry_version in config.json
 *
 * Usage:
 *   node scripts/myr-sync-registry.js
 *   node bin/myr.js sync-registry
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { canonicalize } = require('../lib/canonicalize');
const { NETWORK_SIGNING_KEY_HEX, REGISTRY_URL, REVOCATION_URL } = require('../lib/registry-constants');

const ROOT = path.join(__dirname, '..');

// --- Signature verification ---

/**
 * Verify an Ed25519 signature over a registry or revocation payload.
 * The signable object is all fields except 'signature', sorted canonically.
 *
 * @param {object} data - parsed JSON object with 'signature' field
 * @param {string} publicKeyHex - 32-byte raw Ed25519 public key as hex
 * @returns {boolean}
 */
function verifyRegistrySignature(data, publicKeyHex) {
  try {
    const { signature, ...rest } = data;
    if (!signature) return false;

    // Build signable object: all fields except signature, sorted
    const signable = {};
    for (const k of Object.keys(rest).sort()) {
      signable[k] = rest[k];
    }

    const canonical = canonicalize(signable);

    // Reconstruct public key from raw 32-byte hex
    const rawPubKeyBytes = Buffer.from(publicKeyHex, 'hex');

    // Build SPKI DER for Ed25519: fixed 12-byte header + 32-byte key
    const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiDer = Buffer.concat([spkiHeader, rawPubKeyBytes]);

    const pubKey = crypto.createPublicKey({ key: spkiDer, type: 'spki', format: 'der' });
    const sigBytes = Buffer.from(signature, 'hex');

    return crypto.verify(null, Buffer.from(canonical, 'utf8'), pubKey, sigBytes);
  } catch (err) {
    return false;
  }
}

// --- HTTP fetch (built-in, no external deps) ---

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https://') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        } else {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
          }
        }
      });
    }).on('error', reject);
  });
}

// --- Config read/write ---

function loadConfigRaw() {
  const configPath = path.join(ROOT, 'config.json');
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function saveConfigRaw(cfg) {
  const configPath = path.join(ROOT, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
}

// --- Peer upsert ---

/**
 * Upsert a node from the registry into myr_peers.
 * - If peer doesn't exist: insert with trust_level='pending'
 * - If peer exists but trust_level != 'trusted': leave it alone (don't downgrade trusted)
 * Returns true if a new peer was inserted.
 */
function upsertPeer(db, node) {
  // public_key in the registry is PEM format; store as-is
  // Check if peer already exists by public_key
  const existing = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(node.public_key);

  if (!existing) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(node.url, node.operator, node.public_key, now);
    return true;
  }

  // Peer exists — don't downgrade trust level
  return false;
}

/**
 * Apply a revocation: set trust_level='rejected' for the given public_key.
 * Returns true if a peer was updated.
 */
function applyRevocation(db, revokedEntry) {
  const key = revokedEntry.public_key;
  if (!key) return false;

  const existing = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(key);
  if (!existing) return false;
  if (existing.trust_level === 'rejected') return false;

  db.prepare("UPDATE myr_peers SET trust_level = 'rejected' WHERE public_key = ?").run(key);
  return true;
}

// --- Main sync logic ---

async function syncRegistry({ db, fetch: fetchFn, signingKeyHex, registryUrl, revocationUrl, configStore } = {}) {
  fetchFn = fetchFn || fetchUrl;
  signingKeyHex = signingKeyHex || NETWORK_SIGNING_KEY_HEX;
  registryUrl = registryUrl || REGISTRY_URL;
  revocationUrl = revocationUrl || REVOCATION_URL;

  // configStore: injectable for tests. Must have get() and set(version) methods.
  // Default: reads/writes config.json
  if (!configStore) {
    let _cfg = loadConfigRaw();
    configStore = {
      get: () => _cfg.registry_version || 0,
      set: (v) => { _cfg.registry_version = v; saveConfigRaw(_cfg); },
    };
  }

  // Load current stored version
  const storedVersion = configStore.get();

  // Fetch registry
  console.log(`Fetching registry from ${registryUrl}...`);
  const registry = await fetchFn(registryUrl);

  // Verify signature
  if (!verifyRegistrySignature(registry, signingKeyHex)) {
    throw new Error('Registry signature verification FAILED. Rejecting update.');
  }

  // Replay protection
  if (registry.version <= storedVersion) {
    throw new Error(
      `Registry version ${registry.version} ≤ stored version ${storedVersion}. Rejecting replay.`
    );
  }

  // Fetch revocation list
  console.log(`Fetching revocation list from ${revocationUrl}...`);
  const revocation = await fetchFn(revocationUrl);

  // Verify revocation signature
  if (!verifyRegistrySignature(revocation, signingKeyHex)) {
    throw new Error('Revocation list signature verification FAILED. Rejecting update.');
  }

  // Apply peers
  let newPeers = 0;
  for (const node of (registry.nodes || [])) {
    if (upsertPeer(db, node)) {
      newPeers++;
      console.log(`  + New peer: ${node.operator} (${node.url})`);
    }
  }

  // Apply revocations
  let revocations = 0;
  for (const entry of (revocation.revoked || [])) {
    if (applyRevocation(db, entry)) {
      revocations++;
      console.log(`  ✗ Revoked: ${entry.node_id || entry.public_key?.slice(0, 16)}`);
    }
  }

  // Update stored registry_version
  configStore.set(registry.version);

  const summary = {
    newPeers,
    revocations,
    registryVersion: registry.version,
  };

  console.log(`\nRegistry sync complete (v${registry.version}):`);
  console.log(`  ${newPeers} new peer(s) added`);
  console.log(`  ${revocations} revocation(s) applied`);

  return summary;
}

// --- CLI entry point ---

if (require.main === module) {
  const { getDb } = require('./db');

  let db;
  syncRegistry({ db: (db = getDb()) })
    .then(() => {
      if (db) db.close();
    })
    .catch(err => {
      console.error('ERROR:', err.message);
      if (db) db.close();
      process.exit(1);
    });
}

module.exports = { syncRegistry, verifyRegistrySignature, upsertPeer, applyRevocation };
