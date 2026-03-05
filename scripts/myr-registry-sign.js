#!/usr/bin/env node
'use strict';

/**
 * myr-registry-sign.js
 *
 * Tool for the network operator to sign/update the MYR node registry
 * and revocation list.
 *
 * Usage:
 *   node scripts/myr-registry-sign.js --nodes network/nodes.json
 *   node scripts/myr-registry-sign.js --revoked network/revoked.json
 *   node scripts/myr-registry-sign.js --nodes network/nodes.json --revoked network/revoked.json
 *
 * Signs with keys/myr-network.private.pem. Bumps version, updates signed_at,
 * re-signs canonical JSON of the payload, writes file back.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalize } = require('../lib/canonicalize');

const ROOT = path.join(__dirname, '..');

// --- Canonical signing ---

/**
 * Sign a registry or revocation payload with the network private key.
 * Payload fields are the full object minus `signature`.
 * Canonical JSON is signed over: keys sorted alphabetically.
 */
function signPayload(payload, privateKeyPem) {
  const privKey = crypto.createPrivateKey(privateKeyPem);

  // Build the signable object (all fields except signature, sorted canonically)
  const signable = {};
  for (const k of Object.keys(payload).filter(k => k !== 'signature').sort()) {
    signable[k] = payload[k];
  }

  const canonical = canonicalize(signable);
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privKey);
  return sig.toString('hex');
}

/**
 * Compute a short fingerprint of a hex signature (first 8 bytes).
 */
function sigFingerprint(sigHex) {
  return sigHex.slice(0, 16) + '...';
}

// --- File processing ---

function processNodes(filePath) {
  const abs = path.resolve(ROOT, filePath);
  if (!fs.existsSync(abs)) {
    console.error(`ERROR: File not found: ${abs}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const privKeyPath = path.join(ROOT, 'keys', 'myr-network.private.pem');

  if (!fs.existsSync(privKeyPath)) {
    console.error(`ERROR: Network private key not found: ${privKeyPath}`);
    console.error('Generate it with: node scripts/myr-registry-keygen.js');
    process.exit(1);
  }

  const privKeyPem = fs.readFileSync(privKeyPath, 'utf8');

  const newVersion = (data.version || 0) + 1;
  const signedAt = new Date().toISOString();

  const payload = {
    nodes: data.nodes || [],
    signed_at: signedAt,
    version: newVersion,
  };

  const signature = signPayload(payload, privKeyPem);

  const output = {
    version: newVersion,
    signed_at: signedAt,
    signature,
    nodes: data.nodes || [],
  };

  fs.writeFileSync(abs, JSON.stringify(output, null, 2) + '\n');

  console.log(`✓ Signed ${filePath}`);
  console.log(`  Version:   ${newVersion}`);
  console.log(`  Signed at: ${signedAt}`);
  console.log(`  Nodes:     ${output.nodes.length}`);
  console.log(`  Sig:       ${sigFingerprint(signature)}`);
}

function processRevoked(filePath) {
  const abs = path.resolve(ROOT, filePath);
  if (!fs.existsSync(abs)) {
    console.error(`ERROR: File not found: ${abs}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const privKeyPath = path.join(ROOT, 'keys', 'myr-network.private.pem');

  if (!fs.existsSync(privKeyPath)) {
    console.error(`ERROR: Network private key not found: ${privKeyPath}`);
    process.exit(1);
  }

  const privKeyPem = fs.readFileSync(privKeyPath, 'utf8');

  const newVersion = (data.version || 0) + 1;
  const signedAt = new Date().toISOString();

  const payload = {
    revoked: data.revoked || [],
    signed_at: signedAt,
    version: newVersion,
  };

  const signature = signPayload(payload, privKeyPem);

  const output = {
    version: newVersion,
    signed_at: signedAt,
    signature,
    revoked: data.revoked || [],
  };

  fs.writeFileSync(abs, JSON.stringify(output, null, 2) + '\n');

  console.log(`✓ Signed ${filePath}`);
  console.log(`  Version:   ${newVersion}`);
  console.log(`  Signed at: ${signedAt}`);
  console.log(`  Revoked:   ${output.revoked.length}`);
  console.log(`  Sig:       ${sigFingerprint(signature)}`);
}

// --- CLI ---

if (require.main === module) {
  const args = process.argv.slice(2);
  let nodesFile = null;
  let revokedFile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--nodes' && args[i + 1]) {
      nodesFile = args[++i];
    } else if (args[i] === '--revoked' && args[i + 1]) {
      revokedFile = args[++i];
    }
  }

  if (!nodesFile && !revokedFile) {
    console.error('Usage: node scripts/myr-registry-sign.js --nodes <file> [--revoked <file>]');
    process.exit(1);
  }

  if (nodesFile) processNodes(nodesFile);
  if (revokedFile) processRevoked(revokedFile);
}

module.exports = { signPayload, sigFingerprint };
