'use strict';

const nodeCrypto = require('crypto');
const { sign, verify, fingerprint: computeFingerprint } = require('./crypto');
const { canonicalize } = require('./canonicalize');

const TOPIC_NAME = 'myr-network-v1';
const DEFAULT_ANNOUNCE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_DISCOVER_TIMEOUT_MS = 30 * 1000;       // 30 seconds

/**
 * Returns the 32-byte DHT topic key derived from the MYR network topic name.
 */
function topicKey() {
  return nodeCrypto.createHash('sha256').update(TOPIC_NAME).digest();
}

/**
 * Create a signed announcement payload from an identity document.
 *
 * @param {Object} identityDocument - The /.well-known/myr-node document
 * @param {string} privateKey - Hex-encoded Ed25519 private key
 * @returns {{ payload: Object, signature: string }}
 */
function createAnnouncement(identityDocument, privateKey) {
  const payload = {
    ...identityDocument,
    announced_at: new Date().toISOString(),
  };
  const canonical = canonicalize(payload);
  const signature = sign(canonical, privateKey);
  return { payload, signature };
}

/**
 * Verify a DHT announcement. Returns true if the Ed25519 signature is valid
 * and the payload contains a public_key field.
 *
 * @param {{ payload: Object, signature: string }} announcement
 * @returns {boolean}
 */
function verifyAnnouncement({ payload, signature } = {}) {
  if (!payload || !signature || !payload.public_key) return false;
  try {
    const canonical = canonicalize(payload);
    return verify(canonical, signature, payload.public_key);
  } catch {
    return false;
  }
}

/**
 * Announce this node on the DHT topic using hyperswarm.
 * Returns { swarm, announcement } — call swarm.destroy() when done.
 *
 * @param {Object} params
 * @param {Object} params.identityDocument - /.well-known/myr-node document
 * @param {string} params.privateKey - Hex Ed25519 private key
 * @param {Function} [params._Hyperswarm] - Injectable Hyperswarm constructor for testing
 * @returns {Promise<{ swarm: Object, announcement: Object }>}
 */
async function announceOnDHT({ identityDocument, privateKey, _Hyperswarm }) {
  const HyperswarmClass = _Hyperswarm || (() => {
    try { return require('hyperswarm'); }
    catch { throw new Error('hyperswarm not installed. Run: npm install hyperswarm'); }
  })();

  const announcement = createAnnouncement(identityDocument, privateKey);
  const announcementMsg = Buffer.from(JSON.stringify(announcement));
  const topic = topicKey();
  const swarm = new HyperswarmClass();

  swarm.on('connection', (conn) => {
    try {
      conn.write(announcementMsg);
      conn.end();
    } catch { /* ignore write errors on individual connections */ }
    conn.on('error', () => { /* ignore */ });
  });

  const discovery = swarm.join(topic, { server: true, client: false });
  await discovery.flushed();

  return { swarm, announcement };
}

/**
 * Discover peers on the DHT topic. Listens for timeoutMs, returns verified peers.
 * Unsigned or tampered announcements are silently discarded (onInvalid callback fired).
 *
 * @param {Object} [params]
 * @param {number} [params.timeoutMs=30000] - How long to listen
 * @param {Function} [params.onPeer] - Called with each verified identity document
 * @param {Function} [params.onInvalid] - Called with each invalid/unsigned announcement
 * @param {Function} [params._Hyperswarm] - Injectable constructor for testing
 * @returns {Promise<Array>} Verified identity documents
 */
async function discoverPeers({ timeoutMs = DEFAULT_DISCOVER_TIMEOUT_MS, onPeer, onInvalid, _Hyperswarm } = {}) {
  const HyperswarmClass = _Hyperswarm || (() => {
    try { return require('hyperswarm'); }
    catch { throw new Error('hyperswarm not installed. Run: npm install hyperswarm'); }
  })();

  const topic = topicKey();
  const swarm = new HyperswarmClass();
  const peers = [];

  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      try { await swarm.destroy(); } catch { /* ignore */ }
      resolve(peers);
    }, timeoutMs);

    swarm.on('connection', (conn) => {
      const chunks = [];
      conn.on('data', (chunk) => chunks.push(chunk));
      conn.on('end', () => {
        try {
          const data = Buffer.concat(chunks).toString('utf8');
          const msg = JSON.parse(data);
          if (verifyAnnouncement(msg)) {
            peers.push(msg.payload);
            if (onPeer) onPeer(msg.payload);
          } else {
            if (onInvalid) onInvalid(msg);
          }
        } catch { /* skip malformed data */ }
      });
      conn.on('error', () => { /* ignore */ });
    });

    const discovery = swarm.join(topic, { server: false, client: true });
    discovery.flushed().catch(() => {
      clearTimeout(timer);
      swarm.destroy().catch(() => {});
      resolve(peers);
    });
  });
}

/**
 * Start a background DHT announcer that re-announces every intervalMs.
 * Call stop() to shut down cleanly.
 *
 * @param {Object} params
 * @param {Object} params.identityDocument
 * @param {string} params.privateKey
 * @param {number} [params.intervalMs=1800000] - Re-announce interval (default 30 min)
 * @param {Function} [params.onError] - Error callback
 * @param {Function} [params._Hyperswarm] - Injectable for testing
 * @returns {{ stop: Function }}
 */
function startBackgroundAnnounce({
  identityDocument,
  privateKey,
  intervalMs = DEFAULT_ANNOUNCE_INTERVAL_MS,
  onError,
  _Hyperswarm,
} = {}) {
  let currentSwarm = null;
  let timer = null;
  let stopped = false;

  async function doAnnounce() {
    if (stopped) return;
    if (currentSwarm) {
      try { await currentSwarm.destroy(); } catch { /* ignore */ }
      currentSwarm = null;
    }
    try {
      const result = await announceOnDHT({ identityDocument, privateKey, _Hyperswarm });
      if (!stopped) {
        currentSwarm = result.swarm;
      } else {
        await result.swarm.destroy().catch(() => {});
      }
    } catch (err) {
      if (onError) onError(err);
    }
  }

  // Initial announce
  doAnnounce().catch(onError || (() => {}));

  // Schedule re-announcement
  timer = setInterval(() => {
    doAnnounce().catch(onError || (() => {}));
  }, intervalMs);
  if (timer.unref) timer.unref(); // don't block process exit

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (currentSwarm) {
        try { await currentSwarm.destroy(); } catch { /* ignore */ }
        currentSwarm = null;
      }
    },
  };
}

module.exports = {
  TOPIC_NAME,
  topicKey,
  createAnnouncement,
  verifyAnnouncement,
  announceOnDHT,
  discoverPeers,
  startBackgroundAnnounce,
};
