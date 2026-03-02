'use strict';

const { createHash } = require('crypto');
const ed = require('@noble/ed25519');
const { sha512 } = require('@noble/hashes/sha2.js');

// @noble/ed25519 v2 requires an explicit sha512 implementation for sync ops
ed.hashes.sha512 = (...msgs) => {
  const h = sha512.create();
  for (const msg of msgs) h.update(msg);
  return h.digest();
};

function bytesToHex(bytes) {
  return ed.etc.bytesToHex(bytes);
}

function hexToBytes(hex) {
  return ed.etc.hexToBytes(hex);
}

/**
 * Generate an Ed25519 keypair.
 * @returns {{ publicKey: string, privateKey: string }} hex-encoded keys
 */
function generateKeypair() {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = ed.getPublicKey(privateKey);
  return {
    publicKey: bytesToHex(publicKey),
    privateKey: bytesToHex(privateKey),
  };
}

/**
 * Sign a message with an Ed25519 private key.
 * @param {string} message - UTF-8 message to sign
 * @param {string} privateKey - hex-encoded private key
 * @returns {string} hex-encoded signature
 */
function sign(message, privateKey) {
  const msgBytes = new TextEncoder().encode(message);
  const sig = ed.sign(msgBytes, hexToBytes(privateKey));
  return bytesToHex(sig);
}

/**
 * Verify an Ed25519 signature.
 * @param {string} message - UTF-8 message that was signed
 * @param {string} signature - hex-encoded signature
 * @param {string} publicKey - hex-encoded public key
 * @returns {boolean}
 */
function verify(message, signature, publicKey) {
  try {
    const msgBytes = new TextEncoder().encode(message);
    return ed.verify(hexToBytes(signature), msgBytes, hexToBytes(publicKey));
  } catch {
    return false;
  }
}

/**
 * Compute a fingerprint of a public key.
 * Format: SHA-256:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx
 * (first 16 bytes of the SHA-256 hash, colon-separated hex pairs)
 * @param {string} publicKey - hex-encoded public key
 * @returns {string}
 */
function fingerprint(publicKey) {
  const hash = createHash('sha256').update(Buffer.from(publicKey, 'hex')).digest();
  const pairs = [];
  for (let i = 0; i < 16; i++) {
    pairs.push(hash[i].toString(16).padStart(2, '0'));
  }
  return 'SHA-256:' + pairs.join(':');
}

module.exports = { generateKeypair, sign, verify, fingerprint };
