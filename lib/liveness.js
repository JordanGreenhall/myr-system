'use strict';

const { verify, fingerprint: computeFingerprint } = require('./crypto');

const DEFAULT_MAX_AGE_SEC = 300; // 5 minutes

/**
 * Verify a liveness_proof block from a /myr/health response.
 *
 * @param {object} livenessProof - The liveness_proof object { timestamp, nonce, signature }
 * @param {string} publicKey - Hex-encoded Ed25519 public key of the node
 * @param {object} [options]
 * @param {number} [options.maxAgeSec=300] - Maximum age of timestamp in seconds
 * @param {Date}   [options.now] - Override current time (for testing)
 * @returns {{ verified: boolean, reason?: string }}
 */
function verifyLivenessProof(livenessProof, publicKey, options = {}) {
  const maxAgeSec = options.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
  const now = options.now || new Date();

  if (!livenessProof) {
    return { verified: false, reason: 'Node does not support signed health check (pre-1.5)' };
  }

  const { timestamp, nonce, signature } = livenessProof;

  if (!timestamp || !nonce || !signature) {
    return { verified: false, reason: 'Incomplete liveness_proof — missing timestamp, nonce, or signature' };
  }

  // Check timestamp freshness
  const proofTime = new Date(timestamp);
  if (isNaN(proofTime.getTime())) {
    return { verified: false, reason: 'Invalid timestamp in liveness_proof' };
  }

  const ageSec = (now.getTime() - proofTime.getTime()) / 1000;
  if (ageSec > maxAgeSec) {
    return { verified: false, reason: `Liveness proof is stale (${Math.round(ageSec)}s > ${maxAgeSec}s) — clock skew or cached response` };
  }

  // Verify Ed25519 signature over timestamp||nonce
  const message = timestamp + nonce;
  const valid = verify(message, signature, publicKey);
  if (!valid) {
    return { verified: false, reason: 'Signature verification failed — node may not control claimed key' };
  }

  return { verified: true };
}

/**
 * Fetch a node's /myr/health and /.well-known/myr-node, then verify liveness.
 *
 * @param {string} nodeUrl - Base URL of the target node (e.g. https://node.example.com)
 * @param {object} [options]
 * @param {number} [options.timeoutMs=10000] - HTTP request timeout
 * @param {number} [options.maxAgeSec=300] - Maximum liveness proof age
 * @param {Date}   [options.now] - Override current time (for testing)
 * @param {Function} [options.fetchFn] - Override fetch function (for testing)
 * @returns {Promise<{ verified: boolean, fingerprint?: string, operator_name?: string, latency_ms?: number, timestamp?: string, reason?: string }>}
 */
async function verifyNode(nodeUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const fetchFn = options.fetchFn || globalFetch;
  const start = Date.now();

  // Fetch /.well-known/myr-node for identity
  let identity;
  try {
    identity = await fetchFn(`${nodeUrl}/.well-known/myr-node`, { timeoutMs });
  } catch (err) {
    return {
      verified: false,
      reason: `Could not reach ${nodeUrl} — ${err.code || err.message}`,
    };
  }

  if (!identity || !identity.public_key) {
    return {
      verified: false,
      reason: `No MYR identity document at ${nodeUrl}`,
    };
  }

  // Fetch /myr/health for liveness proof
  let health;
  try {
    health = await fetchFn(`${nodeUrl}/myr/health`, { timeoutMs });
  } catch (err) {
    return {
      verified: false,
      reason: `Could not reach ${nodeUrl}/myr/health — ${err.code || err.message}`,
    };
  }

  if (!health || !health.liveness_proof) {
    return {
      verified: false,
      fingerprint: identity.fingerprint,
      operator_name: identity.operator_name,
      reason: 'Node does not support signed health check (pre-1.5)',
    };
  }

  const latencyMs = Date.now() - start;

  const result = verifyLivenessProof(health.liveness_proof, identity.public_key, {
    maxAgeSec: options.maxAgeSec,
    now: options.now,
  });

  if (!result.verified) {
    return {
      verified: false,
      fingerprint: identity.fingerprint || computeFingerprint(identity.public_key),
      operator_name: identity.operator_name,
      reason: result.reason,
    };
  }

  return {
    verified: true,
    fingerprint: identity.fingerprint || computeFingerprint(identity.public_key),
    operator_name: identity.operator_name,
    latency_ms: latencyMs,
    timestamp: health.liveness_proof.timestamp,
  };
}

/**
 * Default HTTP JSON fetch using Node.js built-in modules.
 */
function globalFetch(url, { timeoutMs = 10000 } = {}) {
  const mod = url.startsWith('https') ? require('https') : require('http');

  return new Promise((resolve, reject) => {
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid JSON from ${url}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      const err = new Error(`Request to ${url} timed out`);
      err.code = 'ETIMEDOUT';
      reject(err);
    });
    req.on('error', reject);
  });
}

module.exports = { verifyLivenessProof, verifyNode, DEFAULT_MAX_AGE_SEC };
