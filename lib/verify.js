'use strict';

const { verify, fingerprint: computeFingerprint } = require('./crypto');
const { verifyLivenessProof, verifyNode } = require('./liveness');

/**
 * Perform a 3-way fingerprint verification for a peer announce.
 *
 * The three checks:
 *   1. Announced fingerprint matches the fingerprint computed from the announced public key.
 *   2. Discovery document is fetched from the peer's URL and contains public_key + fingerprint.
 *   3. Discovery document fingerprint matches both the announced fingerprint and the computed one.
 *
 * @param {object} opts
 * @param {string} opts.publicKey     - Hex-encoded public key from the announce body
 * @param {string} opts.fingerprint   - Fingerprint string from the announce body
 * @param {string} opts.peerUrl       - Base URL of the announcing peer (for discovery fetch)
 * @param {string} [opts.nodeUuid]    - Optional node_uuid from the announce body
 * @param {Function} [opts.fetchFn]   - Override fetch (for testing)
 * @param {number}   [opts.timeoutMs] - HTTP timeout for discovery fetch (default: 10000)
 * @returns {Promise<{ verified: boolean, evidence: object, reason?: string }>}
 */
async function verifyPeerFingerprint({ publicKey, fingerprint, peerUrl, nodeUuid, fetchFn, timeoutMs = 10000 }) {
  const evidence = {
    announced_fingerprint: fingerprint,
    computed_fingerprint: null,
    discovery_fingerprint: null,
    node_uuid: nodeUuid || null,
    checks: { key_matches_fingerprint: false, discovery_fetched: false, discovery_matches: false },
  };

  // Step 1: Compute fingerprint from announced public key and compare
  const computed = computeFingerprint(publicKey);
  evidence.computed_fingerprint = computed;

  if (computed !== fingerprint) {
    evidence.checks.key_matches_fingerprint = false;
    return {
      verified: false,
      evidence,
      reason: 'Announced fingerprint does not match public key.',
    };
  }
  evidence.checks.key_matches_fingerprint = true;

  // Step 2: Fetch discovery document from peer URL
  const fetcher = fetchFn || defaultFetch;
  let discoveryDoc;
  try {
    const baseUrl = peerUrl.replace(/\/$/, '');
    discoveryDoc = await fetcher(`${baseUrl}/.well-known/myr-node`, { timeoutMs });
  } catch (err) {
    evidence.checks.discovery_fetched = false;
    return {
      verified: false,
      evidence,
      reason: `Could not fetch discovery document: ${err.message}`,
    };
  }

  if (!discoveryDoc || !discoveryDoc.public_key || !discoveryDoc.fingerprint) {
    evidence.checks.discovery_fetched = false;
    return {
      verified: false,
      evidence,
      reason: 'Discovery document is missing or malformed (no public_key or fingerprint).',
    };
  }
  evidence.checks.discovery_fetched = true;
  evidence.discovery_fingerprint = discoveryDoc.fingerprint;

  // Step 3: Discovery fingerprint must match both announced and computed
  const discoveryComputed = computeFingerprint(discoveryDoc.public_key);

  const keysMatch = discoveryDoc.public_key === publicKey;
  const fpFromDiscoveryMatchesAnnounced = discoveryDoc.fingerprint === fingerprint;
  const fpFromDiscoveryMatchesComputed = discoveryComputed === computed;

  if (!keysMatch || !fpFromDiscoveryMatchesAnnounced || !fpFromDiscoveryMatchesComputed) {
    evidence.checks.discovery_matches = false;
    const reasons = [];
    if (!keysMatch) reasons.push('discovery public_key differs from announced key');
    if (!fpFromDiscoveryMatchesAnnounced) reasons.push('discovery fingerprint differs from announced fingerprint');
    if (!fpFromDiscoveryMatchesComputed) reasons.push('discovery key fingerprint differs from computed fingerprint');
    return {
      verified: false,
      evidence,
      reason: `3-way verification failed: ${reasons.join('; ')}.`,
    };
  }
  evidence.checks.discovery_matches = true;

  return { verified: true, evidence };
}

/**
 * Default HTTP JSON fetch using Node.js built-in modules.
 */
function defaultFetch(url, { timeoutMs = 10000 } = {}) {
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

module.exports = {
  verifyPeerFingerprint,
  // Re-export underlying primitives for convenience
  computeFingerprint,
  verifySignature: verify,
  verifyLivenessProof,
  verifyNode,
};
