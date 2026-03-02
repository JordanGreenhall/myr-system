'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeypair, sign, verify, fingerprint } = require('../lib/crypto');

describe('generateKeypair', () => {
  it('returns hex-encoded public and private keys', () => {
    const kp = generateKeypair();
    assert.ok(typeof kp.publicKey === 'string');
    assert.ok(typeof kp.privateKey === 'string');
    assert.match(kp.publicKey, /^[0-9a-f]+$/);
    assert.match(kp.privateKey, /^[0-9a-f]+$/);
  });

  it('returns a 64-char public key (32 bytes) and 64-char private key (32 bytes)', () => {
    const kp = generateKeypair();
    assert.equal(kp.publicKey.length, 64);
    assert.equal(kp.privateKey.length, 64);
  });

  it('generates unique keypairs each time', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    assert.notEqual(a.publicKey, b.publicKey);
    assert.notEqual(a.privateKey, b.privateKey);
  });
});

describe('sign and verify', () => {
  it('round-trips: sign then verify succeeds', () => {
    const kp = generateKeypair();
    const message = '{"created_at":"2026-03-02T09:00:00Z","operator_name":"jordan"}';
    const sig = sign(message, kp.privateKey);
    assert.ok(typeof sig === 'string');
    assert.match(sig, /^[0-9a-f]+$/);
    assert.ok(verify(message, sig, kp.publicKey));
  });

  it('rejects a tampered message', () => {
    const kp = generateKeypair();
    const message = 'original message';
    const sig = sign(message, kp.privateKey);
    assert.ok(!verify('tampered message', sig, kp.publicKey));
  });

  it('rejects a wrong public key', () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    const message = 'test message';
    const sig = sign(message, kp1.privateKey);
    assert.ok(!verify(message, sig, kp2.publicKey));
  });

  it('rejects a corrupted signature', () => {
    const kp = generateKeypair();
    const message = 'test message';
    const sig = sign(message, kp.privateKey);
    const corrupted = 'ff' + sig.slice(2);
    assert.ok(!verify(message, corrupted, kp.publicKey));
  });

  it('rejects an entirely invalid signature string', () => {
    const kp = generateKeypair();
    assert.ok(!verify('msg', 'not-a-valid-hex-signature', kp.publicKey));
  });
});

describe('fingerprint', () => {
  it('starts with SHA-256: prefix', () => {
    const kp = generateKeypair();
    const fp = fingerprint(kp.publicKey);
    assert.ok(fp.startsWith('SHA-256:'));
  });

  it('has colon-separated hex pairs after the prefix', () => {
    const kp = generateKeypair();
    const fp = fingerprint(kp.publicKey);
    const parts = fp.replace('SHA-256:', '').split(':');
    assert.equal(parts.length, 16);
    for (const part of parts) {
      assert.match(part, /^[0-9a-f]{2}$/);
    }
  });

  it('is deterministic for the same key', () => {
    const kp = generateKeypair();
    assert.equal(fingerprint(kp.publicKey), fingerprint(kp.publicKey));
  });

  it('differs for different keys', () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    assert.notEqual(fingerprint(kp1.publicKey), fingerprint(kp2.publicKey));
  });
});
