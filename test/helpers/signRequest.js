'use strict';

const crypto = require('crypto');
const { sign } = require('../../lib/crypto');

function signRequest({ method = 'GET', path, body, privateKey, publicKey, timestamp, nonce }) {
  const ts = timestamp || new Date().toISOString();
  const nc = nonce || crypto.randomBytes(32).toString('hex');
  const rawBody = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  const canonical = `${method}\n${path}\n${ts}\n${nc}\n${bodyHash}`;
  const sig = sign(canonical, privateKey);

  return {
    headers: {
      'x-myr-timestamp': ts,
      'x-myr-nonce': nc,
      'x-myr-signature': sig,
      'x-myr-public-key': publicKey,
    },
    timestamp: ts,
    nonce: nc,
    rawBody,
    canonical,
  };
}

module.exports = { signRequest };
