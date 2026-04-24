#!/usr/bin/env node
'use strict';

/**
 * bin/myr.js — MYR CLI v1.0
 *
 * Commands:
 *   myr setup [options]           — Generate keypair, provision tunnel, start server
 *   myr peer add --url <url>      — Add a peer via introduce protocol
 *   myr peer approve <fp>         — Approve a pending peer
 *   myr peer list                 — List all known peers
 *   myr sync [--peer <fp>]        — Sync reports from trusted peers
 *   myr recall ...                — Surface prior relevant yield before work
 *   myr capture [options]         — Interactive capture or auto-capture from logs
 *   myr subscribe --tags "..."    — Publish demand signal for tagged yield
 *   myr unsubscribe --tags "..."  — Withdraw demand signal
 *   myr governance ...            — Audit/revoke/quarantine governance operations
 *   myr start                     — Start server in foreground
 *   myr status                    — Show node identity and peer status
 */

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const nodeCrypto = require('crypto');
const chalk = require('chalk');
const { sign, verify, fingerprint: computeFingerprint } = require('../lib/crypto');
const { syncPeer: syncPeerCore, makeSignedHeaders, httpFetch, cleanupNonces } = require('../lib/sync');
const { TOPIC_NAME, discoverPeers, startBackgroundAnnounce } = require('../lib/dht');
const { verifyNode } = require('../lib/liveness');
const { verifyPeerFingerprint } = require('../lib/verify');
const {
  computeDomainTrust,
  getPeerDomainTrust,
  getStage,
  hasCapability,
  gatherPeerStats,
  getStageProgress,
} = require('../lib/participation');
const {
  resolveReachability,
  probeRelay,
  manualFallbackInstructions,
} = require('../lib/reachability');
const { writeTrace } = require('../lib/trace');
const { detectContradictions } = require('../lib/contradictions');
const {
  DEFAULT_PROPAGATION_HOPS,
  ensureSubscriptionsSchema,
  normalizeTags,
  computeSignalId,
  createSignedSignal,
  upsertSubscriptionSignal,
  listSubscriptions,
} = require('../lib/subscriptions');
const INVITE_SCHEMA = 'myr://invite/';
const DEFAULT_AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MIN_SYNC_INTERVAL_MS = 15 * 60 * 1000;

function toBase64Url(input) {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function getNodeIdentifier(nodeConfig, keys) {
  return nodeConfig.node_uuid || computeFingerprint(keys.publicKey);
}

function parseDurationMs(value, fallbackMs) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return fallbackMs;
  const raw = value.trim().toLowerCase();
  if (!raw) return fallbackMs;
  const m = raw.match(/^(\d+)\s*(ms|s|m|h|d)?$/);
  if (!m) return fallbackMs;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  const unit = m[2] || 'ms';
  const unitMap = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return n * (unitMap[unit] || 1);
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'disabled';
  if (ms % (24 * 60 * 60 * 1000) === 0) return `${ms / (24 * 60 * 60 * 1000)}d`;
  if (ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)}h`;
  if (ms % (60 * 1000) === 0) return `${ms / (60 * 1000)}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function getAutoSyncSettings(nodeConfig = {}) {
  const enabled = nodeConfig.auto_sync !== false;
  const minIntervalMs = parseDurationMs(nodeConfig.min_sync_interval, DEFAULT_MIN_SYNC_INTERVAL_MS);
  const configuredIntervalMs = parseDurationMs(nodeConfig.auto_sync_interval, DEFAULT_AUTO_SYNC_INTERVAL_MS);
  const intervalMs = Math.max(configuredIntervalMs, minIntervalMs);
  return {
    enabled,
    intervalMs,
    minIntervalMs,
    intervalLabel: formatDurationMs(intervalMs),
    minIntervalLabel: formatDurationMs(minIntervalMs),
  };
}

function inviteSigningMessage(payload) {
  return [
    'myr-invite-v1',
    payload.node_url,
    payload.operator_name,
    payload.public_key,
    payload.fingerprint,
    payload.exp,
    payload.token,
  ].join('\n');
}

function makeInviteUrl({ nodeConfig, keys, expiresAt, token }) {
  const fingerprint = computeFingerprint(keys.publicKey);
  const payload = {
    v: 1,
    node_url: nodeConfig.node_url,
    operator_name: nodeConfig.operator_name || nodeConfig.node_name || 'unknown',
    public_key: keys.publicKey,
    fingerprint,
    exp: expiresAt,
    token,
  };
  payload.sig = sign(inviteSigningMessage(payload), keys.privateKey);
  return INVITE_SCHEMA + toBase64Url(JSON.stringify(payload));
}

function parseInviteUrl(inviteUrl) {
  let token = inviteUrl.trim();
  if (token.startsWith(INVITE_SCHEMA)) {
    token = token.slice(INVITE_SCHEMA.length);
  } else {
    throw new Error('Invalid invite URL. Expected format: myr://invite/<token>');
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(token));
  } catch {
    throw new Error('Invalid invite token: could not decode payload');
  }

  if (!payload || payload.v !== 1 || !payload.node_url || !payload.operator_name || !payload.fingerprint || !payload.public_key || !payload.exp || !payload.token || !payload.sig) {
    throw new Error('Invalid invite token: missing required fields');
  }

  const expectedFingerprint = computeFingerprint(payload.public_key);
  if (payload.fingerprint !== expectedFingerprint) {
    throw new Error('Invalid invite token: fingerprint does not match public key');
  }

  const expMillis = Date.parse(payload.exp);
  if (!Number.isFinite(expMillis)) {
    throw new Error('Invalid invite token: exp must be a valid timestamp');
  }

  if (!verify(inviteSigningMessage(payload), payload.sig, payload.public_key)) {
    throw new Error('Invalid invite token: signature verification failed');
  }

  if (Date.now() > expMillis) {
    throw new Error(`Invite expired at ${payload.exp}`);
  }

  return payload;
}

// --- Key loading helpers ---

function loadPublicKeyHex(keysPath, nodeId) {
  const pem = fs.readFileSync(path.join(keysPath, `${nodeId}.public.pem`), 'utf8');
  const der = nodeCrypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return der.slice(-32).toString('hex');
}

function loadPrivateKeyHex(keysPath, nodeId) {
  const pem = fs.readFileSync(path.join(keysPath, `${nodeId}.private.pem`), 'utf8');
  const der = nodeCrypto.createPrivateKey(pem).export({ type: 'pkcs8', format: 'der' });
  return der.slice(-32).toString('hex');
}

/**
 * Load keypair from either new ~/.myr/keys/node.key JSON format
 * or legacy PEM format (config.keys_path + config.node_id).
 */
function loadKeypair(config) {
  if (config.keypair_path) {
    const keyPath = config.keypair_path.startsWith('~')
      ? path.join(os.homedir(), config.keypair_path.slice(1))
      : config.keypair_path;
    if (fs.existsSync(keyPath)) {
      const data = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      if (data.publicKey && data.privateKey) {
        return { publicKey: data.publicKey, privateKey: data.privateKey };
      }
    }
  }
  return {
    publicKey: loadPublicKeyHex(config.keys_path, config.node_id),
    privateKey: loadPrivateKeyHex(config.keys_path, config.node_id),
  };
}

function signGovernanceAction({ keys, action, payload }) {
  const timestamp = new Date().toISOString();
  const message = `${action}\n${timestamp}\n${JSON.stringify(payload || {})}`;
  return {
    timestamp,
    signature: sign(message, keys.privateKey),
  };
}

// --- Peer lookup (by operator_name or public_key prefix) ---

function findPeer(db, identifier) {
  const peer = db.prepare('SELECT * FROM myr_peers WHERE operator_name = ?').get(identifier);
  if (peer) return peer;

  const matches = db.prepare('SELECT * FROM myr_peers WHERE public_key LIKE ?').all(identifier + '%');
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Ambiguous: ${matches.length} peers match prefix "${identifier}". Use a longer prefix.`);
  }
  return null;
}

// --- Business logic (exported for testing) ---

/**
 * Add a peer: fetch discovery, store locally, send introduce to remote.
 */
async function addPeer({ db, config, url, keys, fetch: fetchFn }) {
  fetchFn = fetchFn || httpFetch;
  const baseUrl = url.replace(/\/$/, '');

  const discovery = await fetchFn(baseUrl + '/.well-known/myr-node');
  if (discovery.status !== 200) {
    throw new Error(`Failed to fetch node info from ${url}: HTTP ${discovery.status}`);
  }

  const { public_key, operator_name, node_url } = discovery.body;
  if (!public_key || !operator_name) {
    throw new Error('Invalid discovery response: missing public_key or operator_name');
  }

  const existing = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(public_key);
  if (existing) {
    throw new Error(`Peer already exists: ${existing.operator_name} (${existing.peer_url})`);
  }

  const peerUrl = node_url || baseUrl;
  db.prepare(
    'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
  ).run(peerUrl, operator_name, public_key, 'pending', new Date().toISOString());

  // Build our identity document and send introduce to remote
  const ourOperatorName = config.operator_name || config.node_name;
  const ourNodeUrl = config.node_url || `http://localhost:${config.port || 3719}`;
  const introduceBody = {
    identity_document: {
      protocol_version: '1.0.0',
      public_key: keys.publicKey,
      fingerprint: computeFingerprint(keys.publicKey),
      operator_name: ourOperatorName,
      node_url: ourNodeUrl,
      capabilities: ['report-sync', 'peer-discovery', 'incremental-sync'],
      created_at: new Date().toISOString(),
    },
    introduction_message: `Hello from ${ourOperatorName}`,
  };

  const signedHeaders = makeSignedHeaders({
    method: 'POST',
    urlPath: '/myr/peer/introduce',
    body: introduceBody,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });

  let introduceStatus;
  try {
    const introduceRes = await fetchFn(baseUrl + '/myr/peer/introduce', {
      method: 'POST',
      headers: { ...signedHeaders, 'content-type': 'application/json' },
      body: introduceBody,
    });
    introduceStatus = introduceRes.status;
  } catch {
    introduceStatus = 0;
  }

  return {
    message: `Peer added (pending approval): ${operator_name} at ${peerUrl}`,
    peer: { operator_name, public_key, peer_url: peerUrl },
    introduceStatus,
  };
}

/**
 * Approve a peer by updating trust_level to 'trusted'.
 */
function approvePeer({ db, identifier }) {
  const peer = findPeer(db, identifier);
  if (!peer) throw new Error(`No peer found matching "${identifier}"`);

  db.prepare('UPDATE myr_peers SET trust_level = ?, approved_at = ? WHERE public_key = ?')
    .run('trusted', new Date().toISOString(), peer.public_key);

  return { message: `Peer approved: ${peer.operator_name}`, peer };
}

/**
 * Reject a peer.
 */
function rejectPeer({ db, identifier }) {
  const peer = findPeer(db, identifier);
  if (!peer) throw new Error(`No peer found matching "${identifier}"`);

  db.prepare('UPDATE myr_peers SET trust_level = ? WHERE public_key = ?')
    .run('rejected', peer.public_key);

  return { message: `Peer rejected: ${peer.operator_name}`, peer };
}

function revokePeerGovernance({ db, identifier, keys }) {
  const peer = findPeer(db, identifier);
  if (!peer) throw new Error(`No peer found matching "${identifier}"`);

  db.prepare('UPDATE myr_peers SET trust_level = ? WHERE public_key = ?')
    .run('revoked', peer.public_key);

  const actorFingerprint = computeFingerprint(keys.publicKey);
  const targetFingerprint = computeFingerprint(peer.public_key);
  const governanceSig = signGovernanceAction({
    keys,
    action: 'governance.revoke',
    payload: {
      target_fingerprint: targetFingerprint,
      operator_name: peer.operator_name || null,
    },
  });

  writeTrace(db, {
    eventType: 'revoke',
    actorFingerprint,
    targetFingerprint,
    outcome: 'success',
    metadata: {
      previous_trust_level: peer.trust_level,
      governance_signature: governanceSig.signature,
      governance_timestamp: governanceSig.timestamp,
    },
  });

  const updated = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(peer.public_key);
  return {
    message: `Peer revoked: ${peer.operator_name}`,
    peer: updated,
  };
}

function quarantineYield({ db, yieldId, reason = null, keys }) {
  const report = db.prepare('SELECT id FROM myr_reports WHERE id = ?').get(yieldId);
  if (!report) throw new Error(`No report found with id "${yieldId}"`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS myr_quarantined_yields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      yield_id TEXT NOT NULL UNIQUE,
      quarantined_at TEXT NOT NULL,
      quarantined_by TEXT NOT NULL,
      operator_signature TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','released')),
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_quarantine_status ON myr_quarantined_yields(status);
  `);

  const actorFingerprint = computeFingerprint(keys.publicKey);
  const governanceSig = signGovernanceAction({
    keys,
    action: 'governance.quarantine',
    payload: { yield_id: yieldId, reason },
  });
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO myr_quarantined_yields (
      yield_id, quarantined_at, quarantined_by, operator_signature, reason, status, metadata
    ) VALUES (?, ?, ?, ?, ?, 'active', ?)
    ON CONFLICT(yield_id) DO UPDATE SET
      quarantined_at = excluded.quarantined_at,
      quarantined_by = excluded.quarantined_by,
      operator_signature = excluded.operator_signature,
      reason = excluded.reason,
      status = 'active',
      metadata = excluded.metadata
  `).run(
    yieldId,
    now,
    actorFingerprint,
    governanceSig.signature,
    reason,
    JSON.stringify({ governance_timestamp: governanceSig.timestamp })
  );

  writeTrace(db, {
    eventType: 'quarantine',
    actorFingerprint,
    outcome: 'success',
    metadata: {
      yield_id: yieldId,
      reason,
      governance_signature: governanceSig.signature,
      governance_timestamp: governanceSig.timestamp,
    },
  });

  const quarantine = db.prepare('SELECT * FROM myr_quarantined_yields WHERE yield_id = ?').get(yieldId);
  return {
    message: `Yield quarantined: ${yieldId}`,
    quarantine,
  };
}

function governanceAudit({ db, limit = 200 }) {
  const clamped = Math.max(1, Math.min(limit, 2000));
  const traces = db.prepare(`
    SELECT *
    FROM myr_traces
    WHERE event_type IN ('approve', 'stage_change', 'revoke', 'sync_pull', 'sync_push', 'relay_sync', 'quarantine')
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(clamped);

  let stageRows = [];
  try {
    stageRows = db.prepare(`
      SELECT operator_name, public_key, participation_stage, stage_changed_at, stage_evidence
      FROM myr_peers
      WHERE stage_changed_at IS NOT NULL
      ORDER BY stage_changed_at DESC
      LIMIT ?
    `).all(clamped);
  } catch (_) {
    stageRows = [];
  }

  let quarantinedYields = [];
  try {
    quarantinedYields = db.prepare(`
      SELECT yield_id, quarantined_at, quarantined_by, operator_signature, reason, status, metadata
      FROM myr_quarantined_yields
      ORDER BY quarantined_at DESC
      LIMIT ?
    `).all(clamped);
  } catch (_) {
    quarantinedYields = [];
  }

  return {
    limit: clamped,
    approvals: traces.filter((t) => t.event_type === 'approve'),
    stageChanges: [
      ...traces.filter((t) => t.event_type === 'stage_change'),
      ...stageRows.map((row) => ({
        event_type: 'stage_change',
        timestamp: row.stage_changed_at,
        actor_fingerprint: null,
        target_fingerprint: computeFingerprint(row.public_key),
        outcome: 'success',
        metadata: JSON.stringify({
          source: 'peer_stage_column',
          operator_name: row.operator_name || null,
          participation_stage: row.participation_stage || null,
          stage_evidence: row.stage_evidence || null,
        }),
      })),
    ].sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || ''))),
    revocations: traces.filter((t) => t.event_type === 'revoke'),
    syncEvents: traces.filter((t) => ['sync_pull', 'sync_push', 'relay_sync'].includes(t.event_type)),
    quarantines: traces.filter((t) => t.event_type === 'quarantine'),
    quarantinedYields,
  };
}

/**
 * List all known peers.
 */
function listPeers({ db }) {
  return db.prepare('SELECT * FROM myr_peers ORDER BY added_at DESC').all();
}

/**
 * Get our own fingerprint from a public key hex string.
 */
function getFingerprint({ publicKeyHex }) {
  return computeFingerprint(publicKeyHex);
}

/**
 * Get a peer's fingerprint from the DB.
 */
function getPeerFingerprint({ db, name }) {
  const peer = findPeer(db, name);
  if (!peer) throw new Error(`No peer found matching "${name}"`);
  return { name: peer.operator_name, fingerprint: computeFingerprint(peer.public_key) };
}

async function propagateSubscriptionSignal({ db, keys, signal, hops, fetch: fetchFn }) {
  fetchFn = fetchFn || httpFetch;
  const hopsRemaining = Math.max(0, parseInt(hops, 10) || 0);
  if (hopsRemaining <= 0) {
    return { attempted: 0, delivered: 0, failed: 0 };
  }

  const peers = db.prepare(`
    SELECT public_key, operator_name, peer_url
    FROM myr_peers
    WHERE trust_level = 'trusted'
      AND peer_url IS NOT NULL
      AND peer_url != ''
  `).all();

  let delivered = 0;
  let failed = 0;
  for (const peer of peers) {
    const payload = {
      ...signal,
      hops_remaining: hopsRemaining,
      propagated_by: computeFingerprint(keys.publicKey),
    };
    const headers = makeSignedHeaders({
      method: 'POST',
      urlPath: '/myr/subscriptions',
      body: payload,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });

    try {
      const res = await fetchFn(peer.peer_url.replace(/\/+$/, '') + '/myr/subscriptions', {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: payload,
      });
      if (res.status >= 200 && res.status < 300) delivered++;
      else failed++;
    } catch {
      failed++;
    }
  }

  return { attempted: peers.length, delivered, failed };
}

async function publishSubscription({ db, keys, operatorName, tags, intentDescription, status = 'active', hops, fetch: fetchFn }) {
  ensureSubscriptionsSchema(db);
  const normalizedTags = normalizeTags(tags);
  if (normalizedTags.length === 0) {
    throw new Error('At least one tag is required');
  }

  const signalId = computeSignalId(keys.publicKey, normalizedTags);
  const existing = db.prepare(
    'SELECT created_at FROM myr_subscriptions WHERE signal_id = ?'
  ).get(signalId);

  const signal = createSignedSignal({
    ownerPublicKey: keys.publicKey,
    ownerOperatorName: operatorName || null,
    tags: normalizedTags,
    intentDescription: intentDescription || null,
    status,
    privateKey: keys.privateKey,
    createdAt: existing ? existing.created_at : undefined,
    signalId,
  });

  const parsedHops = Number.isFinite(Number(hops))
    ? Number(hops)
    : DEFAULT_PROPAGATION_HOPS;
  const maxHops = Math.max(0, Math.min(parsedHops, 5));
  const stored = upsertSubscriptionSignal(db, signal, {
    source: 'local',
    receivedFrom: keys.publicKey,
    hopsRemaining: maxHops,
  });
  const propagation = await propagateSubscriptionSignal({
    db,
    keys,
    signal,
    hops: maxHops,
    fetch: fetchFn,
  });

  return { subscription: stored, propagation };
}

function parseDomainTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {
      return raw.split(',').map((t) => t.trim()).filter(Boolean);
    }
  }
  return [];
}

function inferTargetDomains(db) {
  const rows = db.prepare(`
    SELECT domain_tags
    FROM myr_reports
    WHERE share_network = 1
    ORDER BY created_at DESC
    LIMIT 200
  `).all();

  const counts = new Map();
  for (const row of rows) {
    const tags = parseDomainTags(row.domain_tags).map((t) => String(t).toLowerCase());
    for (const tag of tags) {
      if (!tag) continue;
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([domain]) => domain);
}

function listContradictions({ db, domain = null }) {
  return detectContradictions(db, { domain });
}

function routePeersForSync({ db, peers, participationStage = 'provisional', targetDomains = [] }) {
  const stageName = getStage(participationStage) ? participationStage : 'provisional';
  const stageDef = getStage(stageName);
  const maxSyncPeers = stageDef.capabilities.maxSyncPeers;
  const domains = targetDomains.length > 0 ? targetDomains : inferTargetDomains(db);

  const ranked = peers.map((peer) => {
    const domainTrustScore = domains.length > 0
      ? domains.reduce((best, domain) => {
        const trust = computeDomainTrust(db, peer.operator_name, domain);
        return Math.max(best, trust.score || 0);
      }, 0)
      : (() => {
        const trustMap = getPeerDomainTrust(db, peer.operator_name);
        const scores = Object.values(trustMap).map((v) => v.score || 0);
        if (scores.length === 0) return 0;
        return Math.max(...scores);
      })();

    const ratingRow = db.prepare(`
      SELECT AVG(operator_rating) AS avg
      FROM myr_reports
      WHERE imported_from = ?
        AND operator_rating IS NOT NULL
    `).get(peer.operator_name);
    const verificationRating = ratingRow && ratingRow.avg !== null ? Number(ratingRow.avg) : 0;

    const falsRow = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM myr_reports
      WHERE imported_from = ?
        AND yield_type = 'falsification'
    `).get(peer.operator_name);
    const falsifications = falsRow ? falsRow.cnt : 0;

    const recencyIso = peer.last_sync_at || peer.added_at || null;
    const recencyMs = recencyIso ? new Date(recencyIso).getTime() : 0;

    return {
      peer,
      domainTrustScore,
      verificationRating,
      recencyIso,
      recencyMs,
      falsifications,
      hasFalsification: falsifications > 0,
    };
  }).sort((a, b) =>
    ((b.hasFalsification ? 1 : 0) - (a.hasFalsification ? 1 : 0)) ||
    (b.domainTrustScore - a.domainTrustScore) ||
    (b.verificationRating - a.verificationRating) ||
    (b.recencyMs - a.recencyMs)
  );

  const selected = Number.isFinite(maxSyncPeers) ? ranked.slice(0, maxSyncPeers) : ranked;
  const skipped = Number.isFinite(maxSyncPeers) ? ranked.slice(maxSyncPeers) : [];

  return {
    stage: stageName,
    maxSyncPeers,
    targetDomains: domains,
    ranked,
    selected,
    skipped,
  };
}

/**
 * Sync reports from a specific trusted peer.
 */
async function syncPeer({ db, peerName, keys, fetch: fetchFn, nodeConfig }) {
  const peer = findPeer(db, peerName);
  if (!peer) throw new Error(`No peer found matching "${peerName}"`);
  if (peer.trust_level !== 'trusted') {
    throw new Error(`Peer "${peer.operator_name}" is not trusted (status: ${peer.trust_level})`);
  }

  const syncOpts = { db, peer, keys };
  if (fetchFn) syncOpts.fetch = fetchFn;

  // Wire relay fallback from node config into the core sync function
  const relay = nodeConfig && nodeConfig.relay;
  if (relay && relay.enabled && relay.url) {
    syncOpts.relayConfig = { url: relay.url, fallbackOnly: relay.fallback_only !== false };
  }

  const result = await syncPeerCore(syncOpts);

  if (result.peerNotTrusted) {
    throw new Error(`Peer "${peer.operator_name}" has not approved us yet.`);
  }

  const relayNote = result.relayUsed ? ' (via relay)' : '';
  return {
    message: `Synced ${result.imported} new report${result.imported !== 1 ? 's' : ''} from ${peer.operator_name}${relayNote}`,
    imported: result.imported,
    peerName: peer.operator_name,
    relayUsed: !!result.relayUsed,
  };
}

async function syncTrustedPeers({
  db,
  keys,
  nodeConfig,
  onMessage = () => {},
  onError = () => {},
  trigger = 'manual',
}) {
  const peers = db.prepare("SELECT * FROM myr_peers WHERE trust_level = 'trusted' AND auto_sync = 1").all();
  if (peers.length === 0) {
    return { status: 'no_peers', totalImported: 0, selectedCount: 0, skippedCount: 0 };
  }

  const participationStage = nodeConfig.participation_stage || 'provisional';
  if (!hasCapability(participationStage, 'canSync')) {
    throw new Error(`Current participation stage "${participationStage}" cannot sync.`);
  }

  const route = routePeersForSync({ db, peers, participationStage });
  if (route.selected.length === 0) {
    return { status: 'no_selected', totalImported: 0, selectedCount: 0, skippedCount: route.skipped.length };
  }

  let totalImported = 0;
  for (let i = 0; i < route.selected.length; i++) {
    const ranked = route.selected[i];
    const peer = ranked.peer;
    try {
      writeTrace(db, {
        eventType: 'sync_pull',
        actorFingerprint: computeFingerprint(keys.publicKey),
        targetFingerprint: computeFingerprint(peer.public_key),
        outcome: 'success',
        metadata: {
          trigger,
          routing: {
            rank: i + 1,
            selected: true,
            stage: route.stage,
            max_sync_peers: route.maxSyncPeers,
            target_domains: route.targetDomains,
            domain_trust_score: ranked.domainTrustScore,
            verification_rating: ranked.verificationRating,
            recency: ranked.recencyIso,
            falsifications: ranked.falsifications,
          },
        },
      });
      const result = await syncPeer({ db, peerName: peer.operator_name, keys, nodeConfig });
      onMessage(result.message);
      totalImported += result.imported;
    } catch (err) {
      onError(`  Failed to sync ${peer.operator_name}: ${err.message}`);
    }
  }

  if (route.skipped.length > 0) {
    for (const skipped of route.skipped) {
      writeTrace(db, {
        eventType: 'sync_pull',
        actorFingerprint: computeFingerprint(keys.publicKey),
        targetFingerprint: computeFingerprint(skipped.peer.public_key),
        outcome: 'failure',
        metadata: {
          trigger,
          routing: {
            selected: false,
            reason: 'participation_stage_limit',
            stage: route.stage,
            max_sync_peers: route.maxSyncPeers,
            target_domains: route.targetDomains,
            domain_trust_score: skipped.domainTrustScore,
            verification_rating: skipped.verificationRating,
            recency: skipped.recencyIso,
            falsifications: skipped.falsifications,
          },
        },
      });
    }
  }

  return {
    status: 'ok',
    totalImported,
    selectedCount: route.selected.length,
    skippedCount: route.skipped.length,
  };
}

/**
 * Verify a remote MYR node's identity and liveness.
 * Library function — usable from CLI and from myr setup.
 *
 * @param {object} opts
 * @param {string} opts.url - Base URL of the target node
 * @param {Function} [opts.fetchFn] - Override fetch (for testing)
 * @param {number} [opts.timeoutMs] - HTTP timeout
 * @returns {Promise<{ verified: boolean, operator_name?: string, fingerprint?: string, latency_ms?: number, reason?: string }>}
 */
async function nodeVerify({ url, fetchFn, timeoutMs }) {
  const baseUrl = url.replace(/\/$/, '');
  return verifyNode(baseUrl, { fetchFn, timeoutMs });
}

/**
 * Announce ourselves to a remote peer via POST /myr/peers/announce.
 *
 * @param {object} opts
 * @param {object} opts.db - Database instance
 * @param {object} opts.config - Node config
 * @param {string} opts.target - node_id (looked up in myr_peers) or a URL
 * @param {object} opts.keys - { publicKey, privateKey } hex strings
 * @param {Function} [opts.fetch] - Override fetch (for testing)
 * @returns {Promise<{ status: string, message: string, trust_level?: string }>}
 */
async function announceTo({ db, config, target, keys, fetch: fetchFn }) {
  fetchFn = fetchFn || httpFetch;

  // Resolve target to a URL
  let peerUrl;
  if (target.startsWith('http://') || target.startsWith('https://')) {
    peerUrl = target;
  } else {
    const peer = findPeer(db, target);
    if (!peer) throw new Error(`No peer found matching "${target}"`);
    if (!peer.peer_url) throw new Error(`Peer "${peer.operator_name}" has no peer_url configured`);
    peerUrl = peer.peer_url;
  }

  const baseUrl = peerUrl.replace(/\/+$/, '');
  const ourOperatorName = config.operator_name || config.node_name;
  const ourNodeUrl = config.node_url || `http://localhost:${config.port || 3719}`;
  const fp = computeFingerprint(keys.publicKey);
  const timestamp = new Date().toISOString();
  const nonce = nodeCrypto.randomBytes(32).toString('hex');

  const announceBody = {
    peer_url: ourNodeUrl,
    public_key: keys.publicKey,
    operator_name: ourOperatorName,
    fingerprint: fp,
    node_uuid: config.node_uuid || null,
    protocol_version: '1.2.0',
    timestamp,
    nonce,
  };

  const signedHeaders = makeSignedHeaders({
    method: 'POST',
    urlPath: '/myr/peers/announce',
    body: announceBody,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });

  const res = await fetchFn(baseUrl + '/myr/peers/announce', {
    method: 'POST',
    headers: { ...signedHeaders, 'content-type': 'application/json' },
    body: announceBody,
  });

  if (res.status !== 200) {
    const msg = res.body && res.body.message ? res.body.message : `HTTP ${res.status}`;
    throw new Error(`Announce failed: ${msg}`);
  }

  return {
    status: res.body.status,
    message: res.body.message || res.body.status,
    trust_level: res.body.trust_level,
  };
}

/**
 * Verify a known peer's identity via 3-way fingerprint check.
 * Read-only diagnostic — does NOT change trust_level.
 *
 * @param {object} opts
 * @param {object} opts.db - Database instance
 * @param {string} opts.target - node_id, operator_name, or public_key prefix
 * @param {Function} [opts.fetchFn] - Override fetch (for testing)
 * @returns {Promise<{ verified: boolean, operator_name: string, fingerprint: string, reason?: string }>}
 */
async function verifyPeer({ db, target, fetchFn }) {
  const peer = findPeer(db, target);
  if (!peer) throw new Error(`No peer found matching "${target}"`);
  if (!peer.peer_url) throw new Error(`Peer "${peer.operator_name}" has no peer_url configured`);

  const fp = computeFingerprint(peer.public_key);
  const result = await verifyPeerFingerprint({
    publicKey: peer.public_key,
    fingerprint: fp,
    peerUrl: peer.peer_url,
    fetchFn,
  });

  return {
    verified: result.verified,
    operator_name: peer.operator_name,
    fingerprint: fp,
    reason: result.reason,
    evidence: result.evidence,
  };
}

// --- DB helper for new ~/.myr config format ---

function getDbFromNodeConfig(nodeConfig) {
  const Database = require('better-sqlite3');

  if (nodeConfig && nodeConfig.db_path) {
    const dbPath = nodeConfig.db_path.startsWith('~')
      ? path.join(os.homedir(), nodeConfig.db_path.slice(1))
      : nodeConfig.db_path;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS myr_reports (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        session_ref TEXT,
        cycle_intent TEXT NOT NULL,
        domain_tags TEXT NOT NULL,
        yield_type TEXT NOT NULL,
        question_answered TEXT NOT NULL,
        evidence TEXT NOT NULL,
        what_changes_next TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.7,
        operator_rating INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        share_network INTEGER DEFAULT 0,
        imported_from TEXT,
        import_verified INTEGER DEFAULT 0,
        signed_artifact TEXT
      );
      CREATE TABLE IF NOT EXISTS myr_peers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        peer_url TEXT,
        operator_name TEXT,
        public_key TEXT UNIQUE NOT NULL,
        trust_level TEXT DEFAULT 'pending',
        added_at TEXT NOT NULL,
        approved_at TEXT,
        last_sync_at TEXT,
        auto_sync INTEGER DEFAULT 1,
        notes TEXT
      );
      CREATE TABLE IF NOT EXISTS myr_nonces (
        nonce TEXT PRIMARY KEY,
        seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nonces_expires ON myr_nonces(expires_at);
      CREATE TABLE IF NOT EXISTS myr_traces (
        trace_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('introduce','approve','share','sync_pull','sync_push','verify','reject','discover','relay_sync','revoke','quarantine','stage_change')),
        actor_fingerprint TEXT NOT NULL,
        target_fingerprint TEXT,
        artifact_signature TEXT,
        outcome TEXT NOT NULL,
        rejection_reason TEXT,
        metadata TEXT DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON myr_traces(timestamp);
      CREATE TABLE IF NOT EXISTS myr_quarantined_yields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        yield_id TEXT NOT NULL UNIQUE,
        quarantined_at TEXT NOT NULL,
        quarantined_by TEXT NOT NULL,
        operator_signature TEXT NOT NULL,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','released')),
        metadata TEXT DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_quarantine_status ON myr_quarantined_yields(status);
      CREATE TABLE IF NOT EXISTS myr_contradictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        yield_a_id TEXT NOT NULL,
        yield_b_id TEXT NOT NULL,
        domain_tag TEXT,
        contradiction_type TEXT NOT NULL CHECK(contradiction_type IN ('observation_vs_falsification','opposing_confidence')),
        details TEXT DEFAULT '{}',
        detected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(yield_a_id, yield_b_id, contradiction_type, domain_tag)
      );
      CREATE INDEX IF NOT EXISTS idx_contradictions_domain ON myr_contradictions(domain_tag);
      CREATE INDEX IF NOT EXISTS idx_contradictions_updated ON myr_contradictions(updated_at DESC);
    `);
    return db;
  }

  // Fall back to legacy config-based DB
  const { getDb } = require('../scripts/db');
  return getDb();
}

// --- CLI entry point ---

if (require.main === module) {
  const { loadNodeConfig, saveNodeConfig } = require('../lib/node-config');

  const program = new Command();
  program
    .name('myr')
    .description('MYR network node management CLI')
    .version('1.0.0');

  async function runSetupCommand(opts = {}) {
    const { runSetup } = require('../lib/setup');
    const readline = require('readline');

    const port = opts.port || 3719;

    const prompt = opts.operatorName ? null : async (question) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
    };

    console.log('\nMYR Node Setup\n');

    try {
      const startServer = async ({ config, keypair }) => {
        const db = getDbFromNodeConfig(config);
        const app = createApp({
          config,
          db,
          publicKeyHex: keypair.publicKey,
          privateKeyHex: keypair.privateKey,
        });

        const server = await new Promise((resolve, reject) => {
          const s = app.listen(port, () => resolve(s));
          s.on('error', (err) => {
            db.close();
            reject(err);
          });
        });

        return { server, db };
      };

      const stopServer = async (handle) => {
        await new Promise((resolve) => handle.server.close(resolve));
        handle.db.close();
      };

      const result = await runSetup({
        operatorName: opts.operatorName,
        publicUrl: opts.publicUrl,
        tunnelProvider: opts.tunnelProvider,
        tunnelToken: opts.tunnelToken,
        port,
        log: console.log,
        prompt,
        startServer,
        stopServer,
      });

      console.log('\n✓ Node is live.\n');
      console.log('Your node identity:');
      console.log(`  Name:        ${result.config.operator_name}`);
      console.log(`  Fingerprint: ${computeFingerprint(result.keypair.publicKey)}`);
      console.log(`  URL:         ${result.nodeUrl}`);
      console.log('\nFast first-value path:');
      console.log('  1) Capture your first MYR:');
      console.log('     myr capture');
      console.log('  2) Create an invite link for a peer:');
      console.log('     myr invite create');
      console.log('  3) Peer joins from the invite URL:');
      console.log('     myr join "myr://invite/<token>"');
      console.log('');

      if (result.tunnelProcess) {
        result.tunnelProcess.kill();
      }
    } catch (err) {
      console.error('\nSetup failed:', err.message);
      process.exit(1);
    }
  }

  // ── myr setup ──────────────────────────────────────────────────────────────
  program
    .command('setup')
    .description('Set up this node with automatic onboarding defaults')
    .option('--operator-name <name>', 'Operator name (skips interactive prompt)')
    .action(runSetupCommand);

  // ── myr setup-advanced ─────────────────────────────────────────────────────
  program
    .command('setup-advanced')
    .description('Set up this node with manual reachability controls')
    .option('--operator-name <name>', 'Operator name (skips interactive prompt)')
    .option('--public-url <url>', 'Use this URL directly for reachability')
    .option('--tunnel-provider <provider>', 'Reachability provider: auto | cloudflare | tailscale | manual | relay')
    .option('--tunnel-token <token>', 'Cloudflare tunnel token for headless setup')
    .option('--port <port>', 'Server port (default: 3719)', parseInt)
    .action(runSetupCommand);

  // ── myr peer ────────────────────────────────────────────────────────────────
  const peerCmd = program
    .command('peer')
    .description('Manage MYR network peers');

  // myr peer add --url <url>
  peerCmd
    .command('add')
    .description('Add a peer by URL (fetches identity, sends introduce)')
    .requiredOption('--url <url>', 'Peer node URL')
    .action(async (opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const keys = loadKeypair(nodeConfig);
        const result = await addPeer({ db, config: nodeConfig, url: opts.url, keys });
        console.log(result.message);
        if (result.introduceStatus && result.introduceStatus !== 200) {
          console.log(`  Note: Introduction to remote returned HTTP ${result.introduceStatus}`);
        }
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  // myr peer approve <fingerprint>
  peerCmd
    .command('approve <fingerprint>')
    .description('Approve a pending peer (by fingerprint or name)')
    .action((fingerprint) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const result = approvePeer({ db, identifier: fingerprint });
        console.log(result.message);
        console.log(`  Fingerprint: ${computeFingerprint(result.peer.public_key)}`);
        console.log('  Sync enabled on next cycle.');
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  // myr peer list
  peerCmd
    .command('list')
    .description('List all known peers and their trust status')
    .action(() => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const peers = listPeers({ db });
        if (peers.length === 0) {
          console.log('No peers configured.');
          return;
        }

        const cols = { fp: 22, name: 16, url: 36, trust: 10, synced: 20 };
        console.log(
          'FINGERPRINT'.padEnd(cols.fp) +
          'OPERATOR'.padEnd(cols.name) +
          'URL'.padEnd(cols.url) +
          'TRUST'.padEnd(cols.trust) +
          'LAST SYNC'
        );
        console.log('-'.repeat(cols.fp + cols.name + cols.url + cols.trust + cols.synced));

        for (const p of peers) {
          const fp = p.public_key ? computeFingerprint(p.public_key).slice(0, 20) + '..' : '—';
          console.log(
            fp.padEnd(cols.fp) +
            (p.operator_name || '—').padEnd(cols.name) +
            (p.peer_url || '—').padEnd(cols.url) +
            (p.trust_level || 'pending').padEnd(cols.trust) +
            (p.last_sync_at ? p.last_sync_at.slice(0, 19) : 'never')
          );
        }
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  // myr peer discover [--timeout <ms>] [--auto-introduce]
  peerCmd
    .command('discover')
    .description('Discover peers on the decentralized network')
    .option('--timeout <ms>', 'Discovery timeout in milliseconds (default: 30000)', parseInt)
    .option('--auto-introduce', 'Automatically introduce to each discovered node not already a peer')
    .action(async (opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const keys = loadKeypair(nodeConfig);
        const timeoutMs = opts.timeout || 30000;

        console.log(`Scanning ${TOPIC_NAME}...`);
        const { writeTrace } = require('../lib/trace');

        const discovered = await discoverPeers({ timeoutMs });

        if (discovered.length === 0) {
          console.log('No nodes discovered on ' + TOPIC_NAME + '.');
          return;
        }

        console.log(`\nDiscovered ${discovered.length} node(s) on ${TOPIC_NAME}:`);

        for (const identity of discovered) {
          if (!identity.public_key) continue;
          const fp = computeFingerprint(identity.public_key);
          const fpShort = fp.slice(0, 8) + '...';
          const existing = db.prepare(
            'SELECT trust_level FROM myr_peers WHERE public_key = ?'
          ).get(identity.public_key);

          let status;
          if (existing) {
            status = '[already peer]';
          } else if (opts.autoIntroduce && identity.node_url) {
            try {
              await addPeer({ db, config: nodeConfig, url: identity.node_url, keys });
              status = '[introduced]';
            } catch (err) {
              status = `[introduce failed: ${err.message.slice(0, 40)}]`;
            }
          } else {
            status = '[new]';
          }

          // Log discovery trace
          writeTrace(db, {
            eventType: 'discover',
            actorFingerprint: computeFingerprint(keys.publicKey),
            targetFingerprint: fp,
            outcome: 'success',
            metadata: {
              operator_name: identity.operator_name || null,
              node_url: identity.node_url || null,
              via: 'dht',
              already_peer: !!existing,
            },
          });

          console.log(
            `  ${(identity.operator_name || '?').padEnd(16)}` +
            `  (${fpShort})` +
            `  ${(identity.node_url || '?').padEnd(38)}` +
            `  ${status}`
          );
        }
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  // myr peer reject <fingerprint>
  peerCmd
    .command('reject <fingerprint>')
    .description('Reject a peer (by fingerprint or name)')
    .action((fingerprint) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const result = rejectPeer({ db, identifier: fingerprint });
        console.log(result.message);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  // ── myr subscribe / unsubscribe ────────────────────────────────────────────
  program
    .command('subscribe')
    .description('Publish a demand signal for domain-tagged yield')
    .requiredOption('--tags <tags>', 'Comma-separated domain tags (for example: "cryptography,networking")')
    .option('--intent <text>', 'Optional intent description for these tags')
    .option('--hops <n>', 'Propagation depth in hops (default: 2)', parseInt)
    .action(async (opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const keys = loadKeypair(nodeConfig);
        const result = await publishSubscription({
          db,
          keys,
          operatorName: nodeConfig.operator_name || nodeConfig.node_name || null,
          tags: opts.tags,
          intentDescription: opts.intent || null,
          status: 'active',
          hops: opts.hops,
        });
        console.log(`Subscription active for tags: ${result.subscription.tags.join(', ')}`);
        console.log(
          `Propagation: attempted ${result.propagation.attempted}, delivered ${result.propagation.delivered}, failed ${result.propagation.failed}`
        );
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program
    .command('unsubscribe')
    .description('Withdraw a demand signal for domain-tagged yield')
    .requiredOption('--tags <tags>', 'Comma-separated domain tags')
    .option('--hops <n>', 'Propagation depth in hops (default: 2)', parseInt)
    .action(async (opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const keys = loadKeypair(nodeConfig);
        const result = await publishSubscription({
          db,
          keys,
          operatorName: nodeConfig.operator_name || nodeConfig.node_name || null,
          tags: opts.tags,
          intentDescription: null,
          status: 'inactive',
          hops: opts.hops,
        });
        console.log(`Subscription withdrawn for tags: ${result.subscription.tags.join(', ')}`);
        console.log(
          `Propagation: attempted ${result.propagation.attempted}, delivered ${result.propagation.delivered}, failed ${result.propagation.failed}`
        );
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program
    .command('subscriptions')
    .description('List local demand signals')
    .option('--all', 'Include inactive subscriptions')
    .action((opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const keys = loadKeypair(nodeConfig);
        const rows = listSubscriptions(db, {
          ownerPublicKey: keys.publicKey,
          includeInactive: !!opts.all,
        });
        if (rows.length === 0) {
          console.log('No subscriptions configured.');
          return;
        }

        for (const row of rows) {
          const intent = row.intent_description ? ` | intent: ${row.intent_description}` : '';
          console.log(`${row.status.padEnd(8)} ${row.tags.join(', ')}${intent}`);
        }
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  // ── myr governance ────────────────────────────────────────────────────────
  const governanceCmd = program
    .command('governance')
    .description('Governance audit and intervention tools');

  governanceCmd
    .command('audit')
    .description('Show governance audit trail (approvals, stage changes, revocations, sync events)')
    .option('--limit <n>', 'Max rows to include (default: 200)', parseInt, 200)
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const report = governanceAudit({ db, limit: opts.limit });
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(`Governance audit (limit=${report.limit})`);
        console.log(`  approvals: ${report.approvals.length}`);
        console.log(`  stage changes: ${report.stageChanges.length}`);
        console.log(`  revocations: ${report.revocations.length}`);
        console.log(`  sync events: ${report.syncEvents.length}`);
        console.log(`  quarantine actions: ${report.quarantines.length}`);
        console.log(`  active quarantined yields: ${report.quarantinedYields.filter((q) => q.status === 'active').length}`);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  governanceCmd
    .command('revoke <fingerprint>')
    .description('Revoke a peer by fingerprint/name and block future sync')
    .action((fingerprint) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const keys = loadKeypair(nodeConfig);
        const result = revokePeerGovernance({ db, identifier: fingerprint, keys });
        console.log(result.message);
        console.log(`  Fingerprint: ${computeFingerprint(result.peer.public_key)}`);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  governanceCmd
    .command('quarantine <yieldId>')
    .description('Quarantine a suspicious yield so recall excludes it')
    .option('--reason <text>', 'Optional reason for quarantine')
    .action((yieldId, opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const keys = loadKeypair(nodeConfig);
        const result = quarantineYield({ db, yieldId, reason: opts.reason || null, keys });
        console.log(result.message);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  // ── myr announce-to ────────────────────────────────────────────────────────
  program
    .command('announce-to <target>')
    .description('Announce ourselves to a peer (by node_id/name or URL)')
    .action(async (target) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const keys = loadKeypair(nodeConfig);
        const result = await announceTo({ db, config: nodeConfig, target, keys });

        if (result.status === 'connected') {
          console.log(`✓ Connected: ${result.message}`);
        } else if (result.status === 'verified') {
          console.log(`✓ Verified (pending approval): ${result.message}`);
        } else if (result.status === 'pending') {
          console.log(`⏳ Pending: ${result.message}`);
        } else if (result.status === 'rejected') {
          console.log(`✗ Rejected: ${result.message}`);
          process.exit(1);
        } else {
          console.log(`${result.status}: ${result.message}`);
        }
      } catch (err) {
        console.error(`✗ Announce failed: ${err.message}`);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  // ── myr verify-peer ────────────────────────────────────────────────────────
  program
    .command('verify-peer <target>')
    .description('Verify a known peer via 3-way fingerprint check (read-only)')
    .action(async (target) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const result = await verifyPeer({ db, target });

        if (result.verified) {
          console.log(`✓ Peer verified: ${result.operator_name} | fingerprint: ${result.fingerprint} | all 3 checks passed`);
        } else {
          console.log(`✗ Verification failed: ${result.reason}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`✗ Verification failed: ${err.message}`);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  // ── myr sync ────────────────────────────────────────────────────────────────
  program
    .command('sync')
    .description('Sync reports from trusted peers')
    .option('--peer <fingerprint>', 'Sync from a specific peer (by name or fingerprint prefix)')
    .action(async (opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const keys = loadKeypair(nodeConfig);

        if (opts.peer) {
          const result = await syncPeer({ db, peerName: opts.peer, keys, nodeConfig });
          console.log(result.message);
        } else {
          const summary = await syncTrustedPeers({
            db,
            keys,
            nodeConfig,
            onMessage: (msg) => console.log(msg),
            onError: (msg) => console.error(msg),
            trigger: 'manual',
          });
          if (summary.status === 'no_peers') {
            console.log('No trusted peers to sync from.');
            return;
          }
          if (summary.status === 'no_selected') {
            console.log('No peers selected for sync after stage/routing checks.');
            return;
          }
          console.log(`\nSync complete: ${summary.totalImported} new report(s) imported.`);
        }

        cleanupNonces(db);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  // ── myr node ───────────────────────────────────────────────────────────────
  const nodeCmd = program
    .command('node')
    .description('Node identity and verification commands');

  // myr node verify --url <url>  OR  myr node verify <url>
  nodeCmd
    .command('verify [url]')
    .description('Verify a remote node is reachable and identity-authentic')
    .option('--url <url>', 'Target node URL')
    .option('--timeout <ms>', 'HTTP request timeout in ms', parseInt)
    .action(async (positionalUrl, opts) => {
      const targetUrl = positionalUrl || opts.url;
      if (!targetUrl) {
        console.error('Usage: myr node verify --url <url>  or  myr node verify <url>');
        process.exit(1);
      }

      try {
        const result = await nodeVerify({
          url: targetUrl,
          timeoutMs: opts.timeout,
        });

        if (result.verified) {
          console.log(
            `✓ Node verified: ${result.operator_name} | fingerprint: ${result.fingerprint} | latency: ${result.latency_ms}ms`
          );
        } else {
          console.log(`✗ Verification failed: ${result.reason}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`✗ Verification failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── myr start ───────────────────────────────────────────────────────────────
  program
    .command('start')
    .description('Start the MYR server in the foreground (for VPS/systemd use)')
    .option('--port <port>', 'Override server port', parseInt)
    .option('--json', 'Output startup status as JSON')
    .addHelpText('after', '\nExamples:\n  myr start\n  myr start --port 3720\n  myr start --json')
    .action(async (opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error(chalk.red('Node not configured. Run: myr setup'));
        process.exit(1);
      }

      const { createApp } = require('../server');

      const port = opts.port || nodeConfig.port || 3719;
      const nodeUrl = nodeConfig.node_url || `http://localhost:${port}`;
      const reachability = resolveReachability({ nodeConfig: { ...nodeConfig, port } });
      const effectiveConfig = { ...nodeConfig, port };
      let relayProbe = null;

      if (reachability.relay) {
        effectiveConfig.relay = {
          enabled: true,
          url: reachability.relay.url,
          fallback_only: reachability.relay.fallback_only !== false,
        };
        const priorRelay = nodeConfig.relay || {};
        const shouldPersistRelay =
          priorRelay.enabled !== effectiveConfig.relay.enabled ||
          priorRelay.url !== effectiveConfig.relay.url ||
          (priorRelay.fallback_only !== false) !== effectiveConfig.relay.fallback_only;
        if (shouldPersistRelay) {
          saveNodeConfig({ ...nodeConfig, relay: effectiveConfig.relay });
        }
        relayProbe = await probeRelay({ relayUrl: effectiveConfig.relay.url });
      }

      const db = getDbFromNodeConfig(effectiveConfig);
      const keys = loadKeypair(effectiveConfig);
      const autoSync = getAutoSyncSettings(effectiveConfig);

      const app = createApp({
        config: effectiveConfig,
        db,
        publicKeyHex: keys.publicKey,
        privateKeyHex: keys.privateKey,
      });

      let dhtAnnouncer = null;
      let autoSyncTimer = null;
      let autoSyncRunning = false;

      async function runAutoSync(trigger) {
        if (!autoSync.enabled || autoSyncRunning) return;
        autoSyncRunning = true;
        try {
          const summary = await syncTrustedPeers({
            db,
            keys,
            nodeConfig: effectiveConfig,
            onMessage: (msg) => {
              if (!opts.json) console.log(`[auto-sync] ${msg}`);
            },
            onError: (msg) => console.error(`[auto-sync] ${msg}`),
            trigger,
          });
          if (!opts.json && summary.status === 'ok') {
            console.log(
              `[auto-sync] cycle complete: ${summary.totalImported} new report(s), ` +
              `${summary.selectedCount} peer(s) synced, ${summary.skippedCount} peer(s) deferred`
            );
          }
        } catch (err) {
          console.error(`[auto-sync] ${err.message}`);
        } finally {
          cleanupNonces(db);
          autoSyncRunning = false;
        }
      }

      const server = app.listen(port, () => {
        const peers = listPeers({ db });
        const trustedPeers = peers.filter((p) => p.trust_level === 'trusted');
        const reachabilityMethod = reachability.relay
          ? 'relay'
          : (reachability.method === 'direct-public' ? 'direct-public' : 'local-only');
        const startupStatus = {
          status: 'started',
          nodeId: getNodeIdentifier(nodeConfig, keys),
          operatorName: nodeConfig.operator_name || nodeConfig.node_name || null,
          fingerprint: computeFingerprint(keys.publicKey),
          nodeUrl,
          port,
          reachabilityMethod,
          indirectConnection: !!reachability.nat.behindNatLikely,
          indirectReason: reachability.nat.reason,
          fallbackChain: reachability.fallbackChain,
          peerCount: peers.length,
          trustedPeerCount: trustedPeers.length,
          dhtTopic: effectiveConfig.discovery && effectiveConfig.discovery.dht_enabled ? TOPIC_NAME : null,
          relay: effectiveConfig.relay && effectiveConfig.relay.enabled
            ? {
              url: effectiveConfig.relay.url,
              fallbackOnly: effectiveConfig.relay.fallback_only !== false,
              source: reachability.relay ? reachability.relay.source : 'configured',
              status: relayProbe ? (relayProbe.ok ? 'reachable' : 'unreachable') : 'unknown',
            }
            : null,
          autoSync: {
            enabled: autoSync.enabled,
            interval: autoSync.intervalLabel,
            minInterval: autoSync.minIntervalLabel,
          },
        };

        if (reachabilityMethod === 'relay' && relayProbe && !relayProbe.ok) {
          startupStatus.relayError = relayProbe.reason;
          startupStatus.manualFallback = manualFallbackInstructions({ port });
        }

        if (opts.json) {
          console.log(JSON.stringify(startupStatus, null, 2));
        } else {
          console.log(chalk.green('MYR node server started'));
          console.log(`  Node ID:      ${startupStatus.nodeId}`);
          console.log(`  Operator:     ${startupStatus.operatorName || 'unknown'}`);
          console.log(`  Fingerprint:  ${startupStatus.fingerprint}`);
          console.log(`  URL:          ${startupStatus.nodeUrl}`);
          console.log(`  Port:         ${startupStatus.port}`);
          console.log(`  Reachability: ${startupStatus.reachabilityMethod}`);
          console.log(`  Connectivity: ${startupStatus.indirectConnection ? `indirect (${startupStatus.indirectReason})` : 'direct'}`);
          console.log(`  Peers:        ${startupStatus.peerCount} (${startupStatus.trustedPeerCount} trusted)`);
          console.log(`  Auto-sync:    ${autoSync.enabled ? `enabled (${autoSync.intervalLabel})` : 'disabled'}`);
          console.log(`  Discovery:    ${nodeUrl}/.well-known/myr-node`);
        }

        // Start DHT background announce if enabled in config
        if (effectiveConfig.discovery && effectiveConfig.discovery.dht_enabled) {
          const identityDocument = {
            protocol_version: '1.0.0',
            node_url: nodeUrl,
            operator_name: effectiveConfig.operator_name,
            public_key: keys.publicKey,
            fingerprint: computeFingerprint(keys.publicKey),
            capabilities: ['report-sync', 'peer-discovery', 'incremental-sync'],
            created_at: new Date().toISOString(),
          };
          dhtAnnouncer = startBackgroundAnnounce({
            identityDocument,
            privateKey: keys.privateKey,
            onError: (err) => console.error('DHT announce error:', err.message),
          });
          if (!opts.json) {
            console.log(`  Discovery:    Announcing on ${TOPIC_NAME}`);
          }
        }

        // Show relay status
        const relayConfig = effectiveConfig.relay;
        if (relayConfig && relayConfig.enabled) {
          const fallbackStr = relayConfig.fallback_only !== false ? '(fallback)' : '(always)';
          if (!opts.json) {
            const probeStatus = relayProbe ? (relayProbe.ok ? 'reachable' : `unreachable: ${relayProbe.reason}`) : 'unknown';
            console.log(`  Relay:        ${relayConfig.url} ${fallbackStr} [${probeStatus}]`);
            if (relayProbe && !relayProbe.ok) {
              console.log(chalk.yellow('\nRelay fallback could not be reached. Manual fallback instructions:\n'));
              console.log(manualFallbackInstructions({ port }));
            }
          }
        }

        if (!opts.json) {
          console.log(chalk.gray('Press Ctrl+C to stop.'));
        }

        if (autoSync.enabled) {
          autoSyncTimer = setInterval(() => {
            void runAutoSync('scheduled');
          }, autoSync.intervalMs);
          if (typeof autoSyncTimer.unref === 'function') {
            autoSyncTimer.unref();
          }
          setTimeout(() => void runAutoSync('startup'), 1000);
        }
      });

      function shutdown(signal) {
        console.log(`\n${signal} received. Shutting down...`);
        if (dhtAnnouncer) dhtAnnouncer.stop().catch(() => {});
        if (autoSyncTimer) clearInterval(autoSyncTimer);
        server.close(() => { db.close(); process.exit(0); });
        setTimeout(() => process.exit(1), 5000).unref();
      }

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    });

  // ── myr invite ───────────────────────────────────────────────────────────────
  const inviteCmd = program
    .command('invite')
    .description('Create and manage MYR onboarding invite links');

  inviteCmd
    .command('create')
    .description('Generate a signed invite URL for myr join')
    .option('--expires-hours <hours>', 'Invite expiration in hours (default: 24)', parseInt, 24)
    .option('--json', 'Output as JSON')
    .addHelpText('after', '\nExamples:\n  myr invite create\n  myr invite create --expires-hours 72\n  myr invite create --json')
    .action((opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error(chalk.red('Node not configured. Run: myr setup'));
        process.exit(1);
      }

      try {
        const keys = loadKeypair(nodeConfig);
        const hours = Number.isFinite(opts.expiresHours) && opts.expiresHours > 0 ? opts.expiresHours : 24;
        const expiresAt = new Date(Date.now() + (hours * 60 * 60 * 1000)).toISOString();
        const inviteUrl = makeInviteUrl({
          nodeConfig,
          keys,
          expiresAt,
          token: nodeCrypto.randomBytes(16).toString('hex'),
        });
        const payload = {
          inviteUrl,
          expiresAt,
          operatorName: nodeConfig.operator_name || nodeConfig.node_name || null,
          fingerprint: computeFingerprint(keys.publicKey),
          usage: `myr join "${inviteUrl}"`,
        };

        if (opts.json) {
          console.log(JSON.stringify(payload, null, 2));
          return;
        }

        console.log(chalk.green('Invite created'));
        console.log(`  URL:         ${inviteUrl}`);
        console.log(`  Expires:     ${expiresAt}`);
        console.log(`  Operator:    ${payload.operatorName || 'unknown'}`);
        console.log(`  Fingerprint: ${payload.fingerprint}`);
        console.log('');
        console.log('Usage:');
        console.log(`  ${payload.usage}`);
      } catch (err) {
        console.error(chalk.red(`Invite creation failed: ${err.message}`));
        process.exit(1);
      }
    });

  // ── myr join ────────────────────────────────────────────────────────────────
  program
    .command('join <inviteUrl>')
    .description('Join a peer from an invite URL and establish trust')
    .option('--json', 'Output as JSON')
    .option('--no-auto-approve', 'Do not automatically approve joined peer locally')
    .addHelpText('after', '\nExamples:\n  myr join "myr://invite/<token>"\n  myr join "myr://invite/<token>" --json')
    .action(async (inviteUrl, opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error(chalk.red('Node not configured. Run: myr setup'));
        process.exit(1);
      }

      let db;
      try {
        const invite = parseInviteUrl(inviteUrl);
        const keys = loadKeypair(nodeConfig);
        db = getDbFromNodeConfig(nodeConfig);

        if (!opts.json) {
          console.log(chalk.yellow('Connecting to invited peer...'));
        }

        try {
          await addPeer({
            db,
            config: nodeConfig,
            url: invite.node_url,
            keys,
          });
        } catch (err) {
          if (!String(err.message).startsWith('Peer already exists:')) {
            throw err;
          }
        }

        const peer = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(invite.public_key);
        if (!peer) {
          throw new Error('Joined peer was not persisted in peer store');
        }

        const discoveredFingerprint = computeFingerprint(peer.public_key);
        if (invite.fingerprint !== discoveredFingerprint) {
          rejectPeer({ db, identifier: peer.public_key });
          throw new Error(`Fingerprint mismatch. Expected ${invite.fingerprint}, got ${discoveredFingerprint}`);
        }

        const verification = await verifyPeerFingerprint({
          publicKey: peer.public_key,
          fingerprint: discoveredFingerprint,
          peerUrl: peer.peer_url,
        });
        if (!verification.verified) {
          throw new Error(`Peer fingerprint could not be verified: ${verification.reason}`);
        }

        let stageGranted = peer.trust_level || 'pending';
        if (opts.autoApprove) {
          approvePeer({ db, identifier: peer.public_key });
          stageGranted = 'trusted';
        }

        const result = {
          peerName: peer.operator_name || invite.operator_name,
          peerUrl: peer.peer_url || invite.node_url,
          fingerprintVerified: true,
          fingerprint: discoveredFingerprint,
          trustStageGranted: stageGranted,
        };

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(chalk.green('Join complete'));
        console.log(`  Peer:               ${result.peerName}`);
        console.log(`  Fingerprint:        ${result.fingerprint}`);
        console.log(`  Fingerprint check:  verified`);
        console.log(`  Trust stage:        ${result.trustStageGranted}`);
      } catch (err) {
        console.error(chalk.red(`Join failed: ${err.message}`));
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  // ── myr capture ─────────────────────────────────────────────────────────────
  program
    .command('recall')
    .description('Surface relevant prior yield for a work context')
    .option('--intent <text>', 'Current work intent')
    .option('--query <text>', 'Explicit search query')
    .option('--tags <tags>', 'Comma-separated domain tags')
    .option('--limit <n>', 'Max results (default 10)', parseInt)
    .option('--verified-only', 'Only show verified MYRs')
    .option('--json', 'Output as JSON (for agent/tool consumption)')
    .addHelpText('after', '\nExamples:\n  myr recall --intent "debug sync timeouts"\n  myr recall --tags "networking" --json')
    .action((opts) => {
      const scriptPath = path.join(__dirname, '..', 'scripts', 'myr-recall.js');
      const args = [];
      if (opts.intent) args.push('--intent', opts.intent);
      if (opts.query) args.push('--query', opts.query);
      if (opts.tags) args.push('--tags', opts.tags);
      if (Number.isFinite(opts.limit)) args.push('--limit', String(opts.limit));
      if (opts.verifiedOnly) args.push('--verified-only');
      if (opts.json) args.push('--json');

      const res = spawnSync(process.execPath, [scriptPath, ...args], {
        stdio: 'inherit',
      });
      if (res.status !== 0) {
        process.exit(res.status || 1);
      }
    });

  // ── myr capture ─────────────────────────────────────────────────────────────
  program
    .command('capture')
    .description('Capture yield: interactive prompts (default) or auto-extract from work logs')
    .option('--from-log <path>', 'Auto-extract candidate yield from a session log file')
    .option('--session-intent <text>', 'Session intent hint for auto-extraction mode')
    .option('--tags <tags>', 'Comma-separated domain tags for auto-extraction mode')
    .option('--agent <id>', 'Agent identifier for auto-extraction mode')
    .option('--session-ref <ref>', 'Session reference identifier for auto-extraction mode')
    .option('--max-yields <n>', 'Max extracted candidates (default 5)', parseInt)
    .option('--dry-run', 'Auto mode only: show candidates without writing to DB')
    .option('--json', 'Output capture launcher metadata as JSON')
    .addHelpText('after', '\nExamples:\n  myr capture\n  myr capture --from-log ./session.log --tags "sync,networking"\n  cat session.log | myr capture --session-intent "debug sync" --json')
    .action((opts) => {
      const useAutoMode = !!opts.fromLog || !process.stdin.isTTY;
      if (!useAutoMode && opts.json) {
        console.log(JSON.stringify({
          command: 'capture',
          mode: 'interactive',
          delegatedTo: 'scripts/myr-store.js --interactive',
        }, null, 2));
        return;
      }

      const scriptPath = useAutoMode
        ? path.join(__dirname, '..', 'scripts', 'myr-capture.js')
        : path.join(__dirname, '..', 'scripts', 'myr-store.js');

      const args = [];
      if (useAutoMode) {
        if (opts.fromLog) args.push('--file', opts.fromLog);
        if (opts.sessionIntent) args.push('--session-intent', opts.sessionIntent);
        if (opts.tags) args.push('--tags', opts.tags);
        if (opts.agent) args.push('--agent', opts.agent);
        if (opts.sessionRef) args.push('--session-ref', opts.sessionRef);
        if (Number.isFinite(opts.maxYields)) args.push('--max-yields', String(opts.maxYields));
        if (opts.dryRun) args.push('--dry-run');
        if (opts.json) args.push('--json');
      } else {
        args.push('--interactive');
      }

      const res = spawnSync(process.execPath, [scriptPath, ...args], {
        stdio: 'inherit',
      });
      if (res.status !== 0) {
        process.exit(res.status || 1);
      }
    });

  // ── myr status ──────────────────────────────────────────────────────────────
  program
    .command('contradictions')
    .description('Detect and list contradictory yields')
    .option('--domain <tag>', 'Filter detection and output to a single domain tag')
    .option('--json', 'Output JSON')
    .action((opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      let db;
      try {
        db = getDbFromNodeConfig(nodeConfig);
        const result = listContradictions({ db, domain: opts.domain || null });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`Scanned reports: ${result.scannedReports}`);
        console.log(`Detected/updated contradiction records: ${result.detectedCount}`);
        if (result.contradictions.length === 0) {
          console.log('No contradictions found.');
          return;
        }

        for (const row of result.contradictions) {
          const domain = row.domain_tag || 'n/a';
          console.log(
            `${row.contradiction_type} | ${row.yield_a_id} <-> ${row.yield_b_id} | domain=${domain}`
          );
        }
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  // ── myr status ──────────────────────────────────────────────────────────────
  program
    .command('status')
    .description('Show node identity, participation progress, active peers, and last sync times')
    .option('--json', 'Output as JSON')
    .addHelpText('after', '\nExamples:\n  myr status\n  myr status --json')
    .action((opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error(chalk.red('Node not configured. Run: myr setup'));
        process.exit(1);
      }

      let db;
      try {
        const keys = loadKeypair(nodeConfig);
        db = getDbFromNodeConfig(nodeConfig);

        const fp = computeFingerprint(keys.publicKey);
        const peers = listPeers({ db });
        const trustedPeers = peers.filter(p => p.trust_level === 'trusted');
        const pendingPeers = peers.filter(p => p.trust_level === 'pending');
        const totalMyrs = db.prepare('SELECT COUNT(*) AS c FROM myr_reports').get().c;
        const syncSummary = db.prepare(`
          SELECT
            MAX(last_sync_at) AS last_sync_at,
            SUM(CASE WHEN trust_level = 'trusted' AND last_sync_at IS NOT NULL THEN 1 ELSE 0 END) AS synced_trusted_peers
          FROM myr_peers
        `).get();
        const participationStats = gatherPeerStats(db, keys.publicKey);
        const participation = getStageProgress(
          nodeConfig.participation_stage || 'provisional',
          participationStats
        );
        const autoSync = getAutoSyncSettings(nodeConfig);
        const statusPayload = {
          nodeId: getNodeIdentifier(nodeConfig, keys),
          operatorName: nodeConfig.operator_name || nodeConfig.node_name || null,
          fingerprint: fp,
          url: nodeConfig.node_url || null,
          port: nodeConfig.port || 3719,
          participationStage: participation.current.key,
          participation,
          peerCount: peers.length,
          trustedPeerCount: trustedPeers.length,
          pendingPeerCount: pendingPeers.length,
          syncStatus: trustedPeers.length > 0
            ? `${syncSummary.synced_trusted_peers || 0}/${trustedPeers.length} trusted peers synced`
            : 'no trusted peers',
          lastSyncTime: syncSummary.last_sync_at || null,
          myrCount: totalMyrs,
          reachabilityMethod: nodeConfig.relay && nodeConfig.relay.enabled
            ? 'relay'
            : (nodeConfig.node_url && !nodeConfig.node_url.includes('localhost') ? 'direct-public' : 'local-only'),
          relay: nodeConfig.relay && nodeConfig.relay.enabled
            ? { url: nodeConfig.relay.url, fallbackOnly: nodeConfig.relay.fallback_only !== false }
            : null,
          autoSync: {
            enabled: autoSync.enabled,
            interval: autoSync.intervalLabel,
            minInterval: autoSync.minIntervalLabel,
          },
        };

        if (opts.json) {
          console.log(JSON.stringify(statusPayload, null, 2));
          return;
        }

        console.log(chalk.bold('\nNode Identity:'));
        console.log(`  Node ID:      ${statusPayload.nodeId}`);
        console.log(`  Operator:     ${statusPayload.operatorName || 'unknown'}`);
        console.log(`  Fingerprint:  ${statusPayload.fingerprint}`);
        console.log(`  URL:          ${statusPayload.url || '(not set)'}`);
        console.log(`  Port:         ${statusPayload.port}`);
        console.log(`  Reachability: ${statusPayload.reachabilityMethod}`);
        console.log(`  Auto-sync:    ${statusPayload.autoSync.enabled ? `enabled (${statusPayload.autoSync.interval})` : 'disabled'}`);
        console.log(`  MYRs:         ${statusPayload.myrCount}`);
        console.log(`  Sync:         ${statusPayload.syncStatus}`);
        console.log(`  Last sync:    ${statusPayload.lastSyncTime || 'never'}`);

        const relayConfig = nodeConfig.relay;
        if (relayConfig && relayConfig.enabled) {
          const fallbackStr = relayConfig.fallback_only !== false ? 'fallback enabled' : 'always active';
          console.log(`  Relay:        ${relayConfig.url} (${fallbackStr})`);
        }

        console.log(chalk.bold('\nParticipation:'));
        console.log(`  Current:      ${statusPayload.participation.current.label} (${statusPayload.participation.current.key})`);
        console.log(`  Baseline:     ${statusPayload.participation.minimumViable.met ? 'met' : 'not yet'} — ${statusPayload.participation.minimumViable.description}`);
        if (statusPayload.participation.nextStage) {
          console.log(`  Next stage:   ${statusPayload.participation.nextStage.label} (${statusPayload.participation.nextStage.key})`);
          console.log(`  Progress:     ${statusPayload.participation.progress.metChecks}/${statusPayload.participation.progress.totalChecks} checks (${statusPayload.participation.progress.percent}%)`);
        } else {
          console.log('  Next stage:   none (already at maximum stage)');
        }
        if (statusPayload.participation.guidance.length > 0) {
          console.log('\nNext steps:');
          for (const line of statusPayload.participation.guidance) {
            console.log(`  - ${line}`);
          }
        }

        console.log(chalk.bold('\nPeers:'));
        console.log(`  Trusted: ${trustedPeers.length}`);
        console.log(`  Pending: ${pendingPeers.length}`);
        console.log(`  Total:   ${peers.length}`);

        if (trustedPeers.length > 0) {
          console.log('\nTrusted peers:');
          for (const p of trustedPeers) {
            const lastSync = p.last_sync_at ? p.last_sync_at.slice(0, 19) : 'never';
            console.log(`  ${(p.operator_name || '—').padEnd(16)} last sync: ${lastSync}`);
          }
        }

        if (pendingPeers.length > 0) {
          console.log('\nPending approval:');
          for (const p of pendingPeers) {
            const fp2 = computeFingerprint(p.public_key);
            console.log(`  ${p.operator_name || '—'} — run: myr peer approve ${fp2.slice(0, 20)}`);
          }
        }

        console.log('');
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program.parse(process.argv);
}

module.exports = {
  findPeer,
  addPeer,
  approvePeer,
  rejectPeer,
  revokePeerGovernance,
  quarantineYield,
  governanceAudit,
  listPeers,
  getFingerprint,
  getPeerFingerprint,
  syncPeer,
  nodeVerify,
  announceTo,
  verifyPeer,
  inferTargetDomains,
  routePeersForSync,
  syncTrustedPeers,
  listContradictions,
  publishSubscription,
  propagateSubscriptionSignal,
  makeSignedHeaders,
  makeInviteUrl,
  parseInviteUrl,
  inviteSigningMessage,
  httpFetch,
  loadKeypair,
  loadPublicKeyHex,
  loadPrivateKeyHex,
  parseDurationMs,
  getAutoSyncSettings,
};
