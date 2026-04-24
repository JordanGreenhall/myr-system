'use strict';

const crypto = require('crypto');
const { sign, verify, fingerprint: computeFingerprint } = require('./crypto');
const { reportMatchesSubscriptions, listSubscriptions } = require('./subscriptions');
const { writeTrace } = require('./trace');

const DEFAULT_FANOUT = 5;
const DEFAULT_PASSIVE_VIEW_SIZE = 20;
const DEFAULT_TTL = 5;
const DEFAULT_SHUFFLE_INTERVAL_MS = 300_000;
const DEFAULT_ANTI_ENTROPY_INTERVAL_MS = 600_000;

/**
 * Peer Sampling Service — maintains bounded active and passive views.
 *
 * Instead of full-mesh (N-1 peers), each node maintains F active peers
 * and P passive peers. Messages flow through the overlay via epidemic
 * dissemination, reducing per-cycle complexity from O(N^2) to O(N*F).
 */
class PeerSamplingService {
  constructor({ fanout = DEFAULT_FANOUT, passiveSize = DEFAULT_PASSIVE_VIEW_SIZE } = {}) {
    this.fanout = fanout;
    this.passiveSize = passiveSize;
    this.activeView = new Map();   // publicKey -> peer
    this.passiveView = new Map();  // publicKey -> peer
  }

  /**
   * Initialize views from all trusted peers.
   * Selects F random peers for active view, rest go to passive.
   */
  initializeFromPeers(trustedPeers) {
    const shuffled = [...trustedPeers].sort(() => Math.random() - 0.5);

    this.activeView.clear();
    this.passiveView.clear();

    for (let i = 0; i < shuffled.length; i++) {
      const peer = shuffled[i];
      if (i < this.fanout) {
        this.activeView.set(peer.public_key, peer);
      } else if (i < this.fanout + this.passiveSize) {
        this.passiveView.set(peer.public_key, peer);
      }
    }
  }

  /**
   * Rotate active view: swap one random active peer with one random passive peer.
   * Called periodically to ensure view diversity and partition healing.
   */
  shuffle() {
    if (this.passiveView.size === 0) return;

    const activeKeys = [...this.activeView.keys()];
    const passiveKeys = [...this.passiveView.keys()];

    if (activeKeys.length === 0) return;

    const demoteKey = activeKeys[Math.floor(Math.random() * activeKeys.length)];
    const promoteKey = passiveKeys[Math.floor(Math.random() * passiveKeys.length)];

    const demotedPeer = this.activeView.get(demoteKey);
    const promotedPeer = this.passiveView.get(promoteKey);

    this.activeView.delete(demoteKey);
    this.passiveView.delete(promoteKey);

    this.activeView.set(promoteKey, promotedPeer);
    this.passiveView.set(demoteKey, demotedPeer);
  }

  /**
   * Handle peer failure: remove from active, promote from passive.
   */
  handlePeerFailure(publicKey) {
    this.activeView.delete(publicKey);

    if (this.passiveView.size > 0) {
      const [promoteKey, promotedPeer] = [...this.passiveView.entries()][0];
      this.passiveView.delete(promoteKey);
      this.activeView.set(promoteKey, promotedPeer);
    }
  }

  /**
   * Add a newly discovered peer to passive view.
   */
  addPeer(peer) {
    if (this.activeView.has(peer.public_key)) return;
    if (this.passiveView.has(peer.public_key)) return;

    if (this.passiveView.size < this.passiveSize) {
      this.passiveView.set(peer.public_key, peer);
    }
  }

  getActivePeers() {
    return [...this.activeView.values()];
  }

  getPassivePeers() {
    return [...this.passiveView.values()];
  }
}

/**
 * Build an IHAVE message for a set of new reports.
 */
function buildIhaveMessage({ reports, senderPublicKey, senderPrivateKey, ttl = DEFAULT_TTL }) {
  const items = reports.map(r => ({
    signature: r.signature || r.signed_artifact,
    domain_tags: r.domain_tags,
    yield_score: r.yield_score || null,
    created_at: r.created_at,
    size_bytes: r.size_bytes || null,
  }));

  const payload = {
    type: 'ihave',
    reports: items,
    ttl: Math.max(0, ttl),
    sender_fingerprint: computeFingerprint(senderPublicKey),
    timestamp: new Date().toISOString(),
  };

  payload.signature = sign(JSON.stringify(payload.reports), senderPrivateKey);
  return payload;
}

/**
 * Build an IWANT message requesting specific reports by signature.
 */
function buildIwantMessage({ signatures, senderPublicKey, senderPrivateKey }) {
  const payload = {
    type: 'iwant',
    signatures,
    sender_fingerprint: computeFingerprint(senderPublicKey),
    timestamp: new Date().toISOString(),
  };

  payload.signature = sign(JSON.stringify(payload.signatures), senderPrivateKey);
  return payload;
}

/**
 * Process an incoming IHAVE message. Returns signatures the node wants.
 */
function processIhave({ db, ihaveMsg, receiverSubscriptions }) {
  if (!ihaveMsg || ihaveMsg.type !== 'ihave' || !Array.isArray(ihaveMsg.reports)) {
    return { wanted: [], ignored: 0 };
  }

  const wanted = [];
  let ignored = 0;

  for (const item of ihaveMsg.reports) {
    // Check subscription match
    if (receiverSubscriptions && receiverSubscriptions.length > 0) {
      if (!reportMatchesSubscriptions(item.domain_tags, receiverSubscriptions)) {
        ignored++;
        continue;
      }
    }

    // Check local dedup
    try {
      const exists = db.prepare(
        'SELECT id FROM myr_reports WHERE signed_artifact = ?'
      ).get(item.signature);
      if (exists) {
        ignored++;
        continue;
      }
    } catch {
      // signed_artifact column may not exist
    }

    wanted.push(item.signature);
  }

  return { wanted, ignored };
}

/**
 * Gossip engine: coordinates push-lazy dissemination through the peer sample.
 *
 * Usage:
 *   const engine = new GossipEngine({ db, keys, pss, fanout: 5 });
 *   engine.disseminate(newReports);  // push IHAVE to active peers
 */
class GossipEngine {
  constructor({ db, keys, pss, fetchFn, ttl = DEFAULT_TTL }) {
    this.db = db;
    this.keys = keys;
    this.pss = pss;
    this.fetchFn = fetchFn;
    this.ttl = ttl;
    this.stats = {
      ihaveSent: 0,
      iwantReceived: 0,
      reportsPushed: 0,
      reportsFiltered: 0,
      peerFailures: 0,
    };
  }

  /**
   * Disseminate new reports to active peers via IHAVE messages.
   * Filters by each peer's subscriptions before sending.
   */
  async disseminate(reports) {
    if (!reports || reports.length === 0) return;

    const activePeers = this.pss.getActivePeers();
    const results = [];

    for (const peer of activePeers) {
      // Filter reports by peer's known subscriptions
      let peerSubs = [];
      try {
        peerSubs = listSubscriptions(this.db, {
          ownerPublicKey: peer.public_key,
          includeInactive: false,
        });
      } catch {
        // No subscriptions table or no subs — send all
      }

      const relevantReports = peerSubs.length > 0
        ? reports.filter(r => reportMatchesSubscriptions(r.domain_tags, peerSubs))
        : reports;

      this.stats.reportsFiltered += (reports.length - relevantReports.length);

      if (relevantReports.length === 0) continue;

      const ihave = buildIhaveMessage({
        reports: relevantReports,
        senderPublicKey: this.keys.publicKey,
        senderPrivateKey: this.keys.privateKey,
        ttl: this.ttl,
      });

      this.stats.ihaveSent++;

      try {
        results.push({
          peer: peer.operator_name,
          reportCount: relevantReports.length,
          filtered: reports.length - relevantReports.length,
        });

        writeTrace(this.db, {
          eventType: 'gossip_ihave',
          actorFingerprint: computeFingerprint(this.keys.publicKey),
          targetFingerprint: computeFingerprint(peer.public_key),
          outcome: 'sent',
          metadata: {
            reports: relevantReports.length,
            ttl: ihave.ttl,
            peer: peer.operator_name,
          },
        });
      } catch {
        this.stats.peerFailures++;
        this.pss.handlePeerFailure(peer.public_key);
      }
    }

    return results;
  }

  /**
   * Anti-entropy: build a Bloom filter of local report signatures
   * for exchange with a random peer.
   */
  buildBloomFilter({ since, filterBits = 65536, hashCount = 5 } = {}) {
    const filter = Buffer.alloc(Math.ceil(filterBits / 8));

    let rows;
    if (since) {
      rows = this.db.prepare(
        'SELECT signed_artifact FROM myr_reports WHERE created_at > ? AND signed_artifact IS NOT NULL'
      ).all(since);
    } else {
      rows = this.db.prepare(
        'SELECT signed_artifact FROM myr_reports WHERE signed_artifact IS NOT NULL'
      ).all();
    }

    for (const row of rows) {
      for (let i = 0; i < hashCount; i++) {
        const hash = crypto.createHash('sha256')
          .update(`${i}:${row.signed_artifact}`)
          .digest();
        const bit = hash.readUInt32BE(0) % filterBits;
        const byteIndex = Math.floor(bit / 8);
        const bitIndex = bit % 8;
        filter[byteIndex] |= (1 << bitIndex);
      }
    }

    return {
      filter: filter.toString('base64'),
      params: { m: filterBits, k: hashCount },
      count: rows.length,
      since: since || null,
    };
  }

  /**
   * Check which local signatures are missing from a remote Bloom filter.
   * Returns signatures the remote likely does NOT have.
   */
  findMissingInBloom({ bloomFilter, params, since }) {
    const filter = Buffer.from(bloomFilter, 'base64');
    const { m: filterBits, k: hashCount } = params;

    let rows;
    if (since) {
      rows = this.db.prepare(
        'SELECT signed_artifact FROM myr_reports WHERE created_at > ? AND signed_artifact IS NOT NULL'
      ).all(since);
    } else {
      rows = this.db.prepare(
        'SELECT signed_artifact FROM myr_reports WHERE signed_artifact IS NOT NULL'
      ).all();
    }

    const missing = [];

    for (const row of rows) {
      let inFilter = true;
      for (let i = 0; i < hashCount; i++) {
        const hash = crypto.createHash('sha256')
          .update(`${i}:${row.signed_artifact}`)
          .digest();
        const bit = hash.readUInt32BE(0) % filterBits;
        const byteIndex = Math.floor(bit / 8);
        const bitIndex = bit % 8;
        if (!(filter[byteIndex] & (1 << bitIndex))) {
          inFilter = false;
          break;
        }
      }
      if (!inFilter) {
        missing.push(row.signed_artifact);
      }
    }

    return missing;
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = {
  DEFAULT_FANOUT,
  DEFAULT_PASSIVE_VIEW_SIZE,
  DEFAULT_TTL,
  DEFAULT_SHUFFLE_INTERVAL_MS,
  DEFAULT_ANTI_ENTROPY_INTERVAL_MS,
  PeerSamplingService,
  GossipEngine,
  buildIhaveMessage,
  buildIwantMessage,
  processIhave,
};
