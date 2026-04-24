'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { errorResponse } = require('./lib/errors');
const { createAuthMiddleware } = require('./middleware/auth');
const { createRateLimiter, createIpRateLimiter } = require('./middleware/rate-limit');
const { canonicalize } = require('../lib/canonicalize');
const { sign: signMessage, verify: verifySignature, fingerprint: computeFingerprint } = require('../lib/crypto');
const { httpFetch, makeSignedHeaders } = require('../lib/sync');
const { verifyLivenessProof, verifyNode } = require('../lib/liveness');
const { writeTrace } = require('../lib/trace');
const { recall, explainYield } = require('../lib/recall');
const { scoreReport, rankReports, explainYield: explainYieldDirect } = require('../lib/yield-scoring');
const { synthesize, validateSynthesisRequest } = require('../lib/synthesis');
const {
  detectContradictions,
  ensureContradictionsSchema,
  normalizeDomain,
  resolveContradiction,
  listContradictionResolutions,
} = require('../lib/contradictions');
const {
  ensureGovernanceGossipSchema,
  createGovernanceSignal,
  ingestGovernanceSignal,
  listGovernanceSignals,
} = require('../lib/governance-gossip');
const { rotateNodeKeypair } = require('../lib/key-rotation');
const { enforceStage, computeStage, getPeerDomainTrust, STAGES } = require('../lib/participation');
const {
  DEFAULT_PROPAGATION_HOPS,
  ensureSubscriptionsSchema,
  normalizeTags,
  computeSignalId,
  createSignedSignal,
  verifySignalSignature,
  upsertSubscriptionSignal,
  listSubscriptions,
  getActiveSubscriptionsForOwner,
  reportMatchesSubscriptions,
} = require('../lib/subscriptions');
const { createLogger } = require('../lib/logging');
const { processIhave, buildIwantMessage, GossipEngine } = require('../lib/gossip');
const { DomainCoordinator } = require('../lib/coordinator');

function loadPublicKeyHex(keysPath, nodeId) {
  const publicKeyPath = path.join(keysPath, `${nodeId}.public.pem`);
  const pem = fs.readFileSync(publicKeyPath, 'utf8');
  const keyObj = crypto.createPublicKey(pem);
  const der = keyObj.export({ type: 'spki', format: 'der' });
  return der.slice(-32).toString('hex');
}

function loadPrivateKeyHex(keysPath, nodeId) {
  const privateKeyPath = path.join(keysPath, `${nodeId}.private.pem`);
  const pem = fs.readFileSync(privateKeyPath, 'utf8');
  const keyObj = crypto.createPrivateKey(pem);
  const der = keyObj.export({ type: 'pkcs8', format: 'der' });
  return der.slice(-32).toString('hex');
}

function getKeyCreatedAt(keysPath, nodeId) {
  const publicKeyPath = path.join(keysPath, `${nodeId}.public.pem`);
  const stats = fs.statSync(publicKeyPath);
  return (stats.birthtime || stats.ctime).toISOString();
}

function safeCount(db, sql) {
  try {
    const row = db.prepare(sql).get();
    return row ? Object.values(row)[0] : 0;
  } catch {
    return 0;
  }
}

function safeGet(db, sql, ...params) {
  try {
    return db.prepare(sql).get(...params);
  } catch {
    return null;
  }
}

function computeHealthStatus(value, thresholds) {
  if (value <= thresholds.greenMax) return 'green';
  if (value <= thresholds.yellowMax) return 'yellow';
  return 'red';
}

function hashRawBody(rawBody) {
  return crypto.createHash('sha256').update(rawBody || '').digest('hex');
}

function parseDomainTags(domainTags) {
  if (!domainTags) return [];
  if (Array.isArray(domainTags)) return domainTags.map((tag) => String(tag).trim()).filter(Boolean);
  if (typeof domainTags === 'string') {
    const trimmed = domainTags.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((tag) => String(tag).trim()).filter(Boolean);
        }
      } catch {
        // Fallback to CSV parser below.
      }
    }
    return trimmed.split(',').map((tag) => tag.trim()).filter(Boolean);
  }
  return [];
}

function verifyOptionalSignedRequest(req) {
  const timestamp = req.headers['x-myr-timestamp'];
  const nonce = req.headers['x-myr-nonce'];
  const signature = req.headers['x-myr-signature'];
  const publicKey = req.headers['x-myr-public-key'];

  if (!timestamp && !nonce && !signature && !publicKey) {
    return { mode: 'none' };
  }

  if (!timestamp || !nonce || !signature || !publicKey) {
    return {
      mode: 'invalid',
      code: 'auth_required',
      message: 'Incomplete signed introduction headers',
    };
  }

  const requestTime = new Date(timestamp).getTime();
  if (isNaN(requestTime) || Date.now() - requestTime > 5 * 60 * 1000) {
    return {
      mode: 'invalid',
      code: 'auth_required',
      message: 'Signed introduction timestamp expired or invalid',
    };
  }

  const bodyHash = hashRawBody(req.rawBody);
  const canonical = `${req.method}\n${req.path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  if (!verifySignature(canonical, signature, publicKey)) {
    return {
      mode: 'invalid',
      code: 'invalid_signature',
      message: 'Signed introduction verification failed',
    };
  }

  return { mode: 'valid', publicKey, timestamp, nonce };
}

/**
 * Convert a PEM public key to the 32-byte Ed25519 raw key as hex.
 * Matches the format used by all MYR clients.
 */
function pemToHex(pem) {
  const keyObj = crypto.createPublicKey(pem);
  const der = keyObj.export({ type: 'spki', format: 'der' });
  return der.slice(-32).toString('hex');
}

/**
 * Load network/nodes.json and return a Map of hex public key → node entry.
 * Returns an empty Map if the registry cannot be read.
 */
function loadRegistry(config) {
  try {
    const registryPath = path.join(
      path.dirname(require.resolve('../scripts/config')),
      '..',
      'network',
      'nodes.json'
    );
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const map = new Map();
    for (const node of (registry.nodes || [])) {
      if (node.public_key) {
        try {
          map.set(pemToHex(node.public_key), node);
        } catch { /* skip malformed entries */ }
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function ensureGovernanceSchema(db) {
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
}

function ensureApplicationsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS myr_applications (
      id TEXT PRIMARY KEY,
      source_yield_id TEXT NOT NULL,
      applied_by_node_id TEXT NOT NULL,
      downstream_use TEXT NOT NULL,
      outcome TEXT,
      applied_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      signed_by TEXT NOT NULL,
      signature TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_applications_source ON myr_applications(source_yield_id);
    CREATE INDEX IF NOT EXISTS idx_applications_created ON myr_applications(created_at DESC);
  `);
}

function ensureRoutingEconomicsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS myr_routing_cycles (
      cycle_id TEXT PRIMARY KEY,
      peer_public_key TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      bytes_sent INTEGER NOT NULL DEFAULT 0,
      bytes_received INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_routing_cycles_peer ON myr_routing_cycles(peer_public_key, ended_at DESC);
    CREATE TABLE IF NOT EXISTS myr_routing_relay_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      peer_public_key TEXT NOT NULL,
      relay_bytes INTEGER NOT NULL DEFAULT 0,
      relay_requests INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL,
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_routing_relay_peer ON myr_routing_relay_costs(peer_public_key, recorded_at DESC);
  `);
}

/**
 * Create the Express app. Accepts explicit publicKeyHex/createdAt for testing,
 * otherwise loads from the filesystem using config.keys_path and config.node_id.
 */
function createApp({ config, db, publicKeyHex, createdAt, privateKeyHex }) {
  const app = express();
  const logger = createLogger({ base: { component: 'myr-server' } });
  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }));
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const candidatePublicKey = req.auth?.publicKey || req.headers['x-myr-public-key'] || null;
      let peerFingerprint = null;
      if (candidatePublicKey) {
        try {
          peerFingerprint = computeFingerprint(String(candidatePublicKey));
        } catch {
          peerFingerprint = null;
        }
      }
      logger.info('http_access', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Math.round(durationMs),
        peer_fingerprint: peerFingerprint,
      });
    });
    next();
  });

  const port = config.port || 3719;
  const nodeUrl = config.node_url || `http://localhost:${port}`;
  const operatorName = config.operator_name || config.node_name || null;

  if (!publicKeyHex && config.keys_path && config.node_id) {
    try {
      publicKeyHex = loadPublicKeyHex(config.keys_path, config.node_id);
    } catch { /* will return error on discovery endpoint */ }
  }

  if (!privateKeyHex && config.keys_path && config.node_id) {
    try {
      privateKeyHex = loadPrivateKeyHex(config.keys_path, config.node_id);
    } catch { /* response signing won't be available */ }
  }

  if (!createdAt && config.keys_path && config.node_id) {
    try {
      createdAt = getKeyCreatedAt(config.keys_path, config.node_id);
    } catch {
      createdAt = new Date().toISOString();
    }
  }

  const startedAt = Date.now();
  ensureGovernanceSchema(db);
  ensureContradictionsSchema(db);
  ensureApplicationsSchema(db);
  ensureSubscriptionsSchema(db);
  ensureGovernanceGossipSchema(db);
  ensureRoutingEconomicsSchema(db);

  // Domain coordinator for routing-aware gossip (Phase 4)
  const coordinator = new DomainCoordinator();
  coordinator.syncFromDatabase(db);

  app.use(createIpRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: config.rate_limit?.unauthenticated_requests_per_minute || 30,
    paths: ['/.well-known/myr-node', '/myr/health', '/myr/discover', '/myr/introduce', '/myr/peer/introduce'],
  }));

  // --- Discovery endpoint (no auth) ---
  app.get('/.well-known/myr-node', (req, res) => {
    if (!publicKeyHex) {
      return errorResponse(res, 'internal_error',
        'Node configuration invalid', 'Unable to load node public key');
    }
    if (!operatorName) {
      return errorResponse(res, 'internal_error',
        'Node configuration invalid', 'Missing operator_name in config');
    }

    // Build network_eligibility block
    const myrCount = safeCount(db, 'SELECT COUNT(*) FROM myr_reports WHERE share_network=1');
    let avgRating = null;
    try {
      const row = db.prepare('SELECT AVG(operator_rating) as avg FROM myr_reports WHERE operator_rating IS NOT NULL').get();
      if (row && row.avg !== null) avgRating = Math.round(row.avg * 100) / 100;
    } catch {
      // column may not exist — leave null
    }

    res.json({
      protocol_version: '1.2.0',
      node_url: nodeUrl,
      operator_name: operatorName,
      node_uuid: config.node_uuid || null,
      public_key: publicKeyHex,
      fingerprint: computeFingerprint(publicKeyHex),
      capabilities: [
        'report-sync',
        'peer-discovery',
        'incremental-sync',
        'gossip-ihave-iwant',
        'gossip-bloom-anti-entropy',
      ],
      gossip_protocol_version: '1.0.0',
      created_at: createdAt,
      rate_limits: {
        requests_per_minute: 60,
        min_sync_interval_minutes: 15,
      },
      network_eligibility: {
        eligible: true,
        myr_count: myrCount,
        avg_rating: avgRating,
        reviewed_count: 0,
        computed_at: new Date().toISOString(),
      },
    });
  });

  // --- Health endpoint (no auth) ---
  app.get('/myr/health', (req, res) => {
    try {
      const peersTotal = safeCount(db, 'SELECT COUNT(*) FROM myr_peers');
      const peersActive = safeCount(db,
        "SELECT COUNT(*) FROM myr_peers WHERE trust_level='trusted'");
      const reportsTotal = safeCount(db, 'SELECT COUNT(*) FROM myr_reports');
      const reportsShared = safeCount(db,
        "SELECT COUNT(*) FROM myr_reports WHERE share_network=1");

      let lastSyncAt = null;
      try {
        const row = db.prepare(
          "SELECT MAX(last_sync_at) as val FROM myr_peers WHERE last_sync_at IS NOT NULL"
        ).get();
        if (row && row.val) lastSyncAt = row.val;
      } catch {
        try {
          const row = db.prepare(
            "SELECT MAX(last_import_at) as val FROM myr_peers WHERE last_import_at IS NOT NULL"
          ).get();
          if (row && row.val) lastSyncAt = row.val;
        } catch { /* no sync data available */ }
      }

      const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

      // Signed liveness proof: sign timestamp+nonce with our private key
      const livenessTimestamp = new Date().toISOString();
      const livenessNonce = crypto.randomBytes(32).toString('hex');
      let livenessSignature = null;
      if (privateKeyHex) {
        livenessSignature = signMessage(livenessTimestamp + livenessNonce, privateKeyHex);
      }

      const response = {
        status: 'ok',
        node_url: nodeUrl,
        operator_name: operatorName,
        public_key: publicKeyHex,
        timestamp: livenessTimestamp,
        nonce: livenessNonce,
        last_sync_at: lastSyncAt,
        peers_active: peersActive,
        peers_total: peersTotal,
        reports_total: reportsTotal,
        reports_shared: safeCount(db, 'SELECT COUNT(*) FROM myr_reports WHERE share_network=1'),
        uptime_seconds: uptimeSeconds,
      };
      if (livenessSignature) response.liveness_signature = livenessSignature;

      // MYR 1.5: structured liveness_proof block
      if (livenessSignature) {
        response.liveness_proof = {
          timestamp: livenessTimestamp,
          nonce: livenessNonce,
          signature: livenessSignature,
        };
      }

      res.json(response);
    } catch (err) {
      return errorResponse(res, 'internal_error',
        'Failed to query node status', err.message);
    }
  });

  // --- Node health aggregate endpoint (no auth) ---
  app.get('/myr/health/node', (req, res) => {
    try {
      const now = Date.now();
      const uptimeSeconds = Math.floor((now - startedAt) / 1000);
      const syncCount = safeCount(db,
        "SELECT COUNT(*) FROM myr_traces WHERE event_type IN ('sync_pull', 'sync_push', 'relay_sync')");
      const yieldCount = safeCount(db, 'SELECT COUNT(*) FROM myr_reports');
      const peerCount = safeCount(db, 'SELECT COUNT(*) FROM myr_peers');
      const trustedPeerCount = safeCount(db,
        "SELECT COUNT(*) FROM myr_peers WHERE trust_level = 'trusted'");

      const lastSync = safeGet(db,
        "SELECT MAX(last_sync_at) AS val FROM myr_peers WHERE last_sync_at IS NOT NULL");
      const queueAgeSeconds = lastSync && lastSync.val
        ? Math.max(0, Math.floor((now - new Date(lastSync.val).getTime()) / 1000))
        : null;

      const thresholds = (config.health_thresholds && config.health_thresholds.node) || {
        greenMax: 300,
        yellowMax: 1800,
      };

      res.json({
        status: queueAgeSeconds === null ? 'yellow' : computeHealthStatus(queueAgeSeconds, thresholds),
        metrics: {
          uptime_seconds: uptimeSeconds,
          sync_count: syncCount,
          yield_count: yieldCount,
          peer_count: peerCount,
          peer_count_trusted: trustedPeerCount,
          queue_age_seconds: queueAgeSeconds,
        },
        thresholds: {
          queue_age_seconds: thresholds,
        },
        computed_at: new Date(now).toISOString(),
      });
    } catch (err) {
      return errorResponse(res, 'internal_error',
        'Failed to compute node health', err.message);
    }
  });

  // --- Network health aggregate endpoint (no auth) ---
  app.get('/myr/health/network', (req, res) => {
    try {
      const now = Date.now();
      const freshnessSeconds = (config.health_thresholds &&
        config.health_thresholds.network &&
        config.health_thresholds.network.syncFreshnessSeconds) || 900;

      const peers = (() => {
        try {
          return db.prepare(
            "SELECT trust_level, last_sync_at FROM myr_peers WHERE trust_level IN ('trusted', 'pending', 'introduced')"
          ).all();
        } catch {
          return [];
        }
      })();

      const knownPeers = peers.length;
      let reachablePeers = 0;
      let stalePeers = 0;
      let totalAge = 0;
      let ageCount = 0;

      for (const peer of peers) {
        if (!peer.last_sync_at) {
          stalePeers++;
          continue;
        }
        const age = Math.max(0, Math.floor((now - new Date(peer.last_sync_at).getTime()) / 1000));
        totalAge += age;
        ageCount++;
        if (age <= freshnessSeconds) {
          reachablePeers++;
        } else {
          stalePeers++;
        }
      }

      const reachabilityRatio = knownPeers > 0 ? reachablePeers / knownPeers : 0;
      const avgSyncAgeSeconds = ageCount > 0 ? Math.round(totalAge / ageCount) : null;
      const status = reachabilityRatio >= 0.8 ? 'green' : (reachabilityRatio >= 0.5 ? 'yellow' : 'red');

      res.json({
        status,
        metrics: {
          known_peers: knownPeers,
          reachable_peers: reachablePeers,
          stale_peers: stalePeers,
          reachability_ratio: Number(reachabilityRatio.toFixed(3)),
          sync_freshness_seconds: avgSyncAgeSeconds,
        },
        thresholds: {
          min_reachability_ratio_green: 0.8,
          min_reachability_ratio_yellow: 0.5,
          freshness_window_seconds: freshnessSeconds,
        },
        computed_at: new Date(now).toISOString(),
      });
    } catch (err) {
      return errorResponse(res, 'internal_error',
        'Failed to compute network health', err.message);
    }
  });

  // --- Flow health aggregate endpoint (no auth) ---
  app.get('/myr/health/flow', (req, res) => {
    try {
      const now = Date.now();
      const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();

      const ingestionRow = safeGet(db,
        'SELECT COUNT(*) AS cnt FROM myr_reports WHERE created_at >= ?',
        oneHourAgo);
      const ingestionRatePerHour = ingestionRow ? ingestionRow.cnt : 0;

      const latencyRow = safeGet(db, `
        SELECT AVG(
          (julianday(created_at) - julianday(timestamp)) * 86400.0
        ) AS avg_seconds
        FROM myr_reports
        WHERE imported_from IS NOT NULL
          AND timestamp IS NOT NULL
          AND created_at IS NOT NULL
      `);
      const syncLatencySeconds = latencyRow && latencyRow.avg_seconds !== null
        ? Math.max(0, Math.round(latencyRow.avg_seconds))
        : null;

      const flowStats = safeGet(db, `
        SELECT
          SUM(CASE WHEN event_type IN ('sync_pull', 'sync_push') AND outcome IN ('success', 'ok') THEN 1 ELSE 0 END) AS ok_count,
          SUM(CASE WHEN event_type IN ('sync_pull', 'sync_push') AND outcome IN ('rejected', 'failure', 'error') THEN 1 ELSE 0 END) AS fail_count
        FROM myr_traces
      `) || { ok_count: 0, fail_count: 0 };
      const okCount = flowStats.ok_count || 0;
      const failCount = flowStats.fail_count || 0;
      const totalFlowEvents = okCount + failCount;
      const retrievalEffectiveness = totalFlowEvents > 0 ? okCount / totalFlowEvents : 1;

      const status = retrievalEffectiveness >= 0.9
        ? 'green'
        : (retrievalEffectiveness >= 0.75 ? 'yellow' : 'red');

      res.json({
        status,
        metrics: {
          ingestion_rate_per_hour: ingestionRatePerHour,
          sync_latency_seconds: syncLatencySeconds,
          retrieval_effectiveness: Number(retrievalEffectiveness.toFixed(3)),
          successful_sync_events: okCount,
          failed_sync_events: failCount,
        },
        thresholds: {
          retrieval_effectiveness_green: 0.9,
          retrieval_effectiveness_yellow: 0.75,
        },
        computed_at: new Date(now).toISOString(),
      });
    } catch (err) {
      return errorResponse(res, 'internal_error',
        'Failed to compute flow health', err.message);
    }
  });

  // --- Recall endpoint (no auth — local use only) ---
  // GET /myr/recall?intent=...&tags=...&query=...&limit=10&verified_only=true
  app.get('/myr/recall', (req, res) => {
    const intent = req.query.intent || null;
    const query = req.query.query || null;
    const tags = req.query.tags ? req.query.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);
    const verifiedOnly = req.query.verified_only === 'true';

    if (!intent && !query && tags.length === 0) {
      return res.json({ results: [], falsifications: [], meta: { error: 'Provide intent, query, or tags' } });
    }

    const explain = req.query.explain === 'true';
    const minScore = parseFloat(req.query.min_score) || 0;
    const result = recall(db, { intent, query, tags, limit, verifiedOnly, explain, minScore });
    res.json(result);
  });

  // --- Contradiction detector endpoint (no auth — local use only) ---
  // GET /myr/contradictions?domain=...
  app.get('/myr/contradictions', (req, res) => {
    try {
      const domain = normalizeDomain(req.query.domain || null);
      const result = detectContradictions(db, { domain });
      return res.json({
        domain,
        scanned_reports: result.scannedReports,
        detected_count: result.detectedCount,
        contradictions: result.contradictions,
      });
    } catch (err) {
      return errorResponse(res, 'internal_error',
        'Failed to detect contradictions', err.message);
    }
  });

  // --- Synthesis endpoint (no auth — local use only) ---
  // POST /myr/synthesis { tags: string|string[], minNodes?: number, store?: boolean }
  app.post('/myr/synthesis', (req, res) => {
    const validation = validateSynthesisRequest(req.body);
    if (!validation.valid) {
      return errorResponse(res, 'invalid_request', validation.error);
    }

    const minNodes = req.body && req.body.minNodes !== undefined
      ? Number(req.body.minNodes)
      : 2;
    const store = req.body && req.body.store !== undefined
      ? Boolean(req.body.store)
      : true;

    try {
      const result = synthesize(db, {
        tags: validation.tags,
        minNodes,
        store,
      });

      return res.json({
        synthesis_id: result.synthId,
        source_count: result.sourceCount,
        cluster_count: result.clusters.length,
        stored: !!result.synthId,
        markdown: result.markdown,
      });
    } catch (err) {
      return errorResponse(res, 'internal_error',
        'Failed to synthesize MYR data', err.message);
    }
  });

  // --- Participation stages endpoint (no auth — local use only) ---
  // GET /myr/participation — list all stage definitions
  app.get('/myr/participation/stages', (req, res) => {
    res.json({ stages: STAGES });
  });

  // GET /myr/participation/evaluate — evaluate current node's stage
  app.get('/myr/participation/evaluate', (req, res) => {
    // Evaluate our own participation stage
    const currentStage = config.participation_stage || 'local-only';
    const evaluation = computeStage(db, publicKeyHex, currentStage);
    const domainTrust = getPeerDomainTrust(db, config.node_id);

    res.json({
      currentStage,
      evaluation,
      domainTrust,
    });
  });

  // GET /myr/participation/peer/:publicKey — evaluate a specific peer's stage and domain trust
  app.get('/myr/participation/peer/:publicKey', (req, res) => {
    const peer = db.prepare(
      'SELECT * FROM myr_peers WHERE public_key = ? OR public_key LIKE ?'
    ).get(req.params.publicKey, `${req.params.publicKey}%`);

    if (!peer) {
      return errorResponse(res, 'peer_not_found', 'Peer not found');
    }

    const currentStage = peer.participation_stage || 'local-only';
    const evaluation = computeStage(db, peer.public_key, currentStage);
    const domainTrust = getPeerDomainTrust(db, peer.node_id || peer.operator_name);

    res.json({
      peer: {
        publicKey: peer.public_key,
        operatorName: peer.operator_name,
        trustLevel: peer.trust_level,
      },
      currentStage,
      evaluation,
      domainTrust,
    });
  });

  // --- Peer introduce endpoint (PUBLIC — no auth required) ---
  // MYR v1.0 protocol: POST /myr/peer/introduce
  // Receives an identity document, creates a pending peer record, returns our identity.
  app.post('/myr/peer/introduce', (req, res) => {
    const body = req.body || {};
    const { identity_document } = body;

    if (!identity_document) {
      return errorResponse(res, 'invalid_request', 'Missing identity_document in request body');
    }

    const {
      public_key,
      operator_name,
      node_url,
      fingerprint: claimedFingerprint,
      protocol_version: protocolVersion = '1.0.0',
    } = identity_document;

    if (!public_key || !operator_name) {
      return errorResponse(res, 'invalid_request',
        'identity_document must include public_key and operator_name');
    }

    const signedIntro = verifyOptionalSignedRequest(req);
    if (signedIntro.mode === 'invalid') {
      return errorResponse(res, signedIntro.code, signedIntro.message);
    }

    let vouch = { status: 'none' };
    if (signedIntro.mode === 'valid' && signedIntro.publicKey !== public_key) {
      const voucher = db.prepare(
        'SELECT public_key, operator_name, trust_level FROM myr_peers WHERE public_key = ?'
      ).get(signedIntro.publicKey);
      if (voucher && voucher.trust_level === 'trusted') {
        vouch = {
          status: 'accepted',
          voucher_public_key: voucher.public_key,
          voucher_operator_name: voucher.operator_name || null,
          voucher_fingerprint: computeFingerprint(voucher.public_key),
          voucher_timestamp: signedIntro.timestamp,
        };
      } else {
        vouch = {
          status: 'ignored',
          reason: 'voucher_not_trusted',
          voucher_public_key: signedIntro.publicKey,
        };
      }
    }

    const now = new Date().toISOString();
    const existing = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(public_key);

    const computedFingerprint = computeFingerprint(public_key);
    const fingerprintMatches = !!claimedFingerprint && claimedFingerprint === computedFingerprint;
    const autoApproveIntroductionsEnabled = config.auto_approve_introductions !== false;
    const minAutoApproveIntroVersion = config.auto_approve_intro_min_protocol_version || '1.0.0';
    const autoApproved = autoApproveIntroductionsEnabled
      && fingerprintMatches
      && protocolVersion >= minAutoApproveIntroVersion;
    const trustLevel = autoApproved ? 'trusted' : 'introduced';

    if (!existing) {
      try {
        const notes = vouch.status === 'accepted'
          ? JSON.stringify({
            introduced_by: vouch.voucher_public_key,
            introduced_by_fingerprint: vouch.voucher_fingerprint,
            introduced_at: vouch.voucher_timestamp,
          })
          : null;
        db.prepare(
          'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(node_url || '', operator_name, public_key, trustLevel, now, autoApproved ? now : null, notes);
      } catch (err) {
        return errorResponse(res, 'internal_error', 'Failed to store peer', err.message);
      }
    } else if (existing.trust_level !== 'trusted') {
      try {
        db.prepare(
          'UPDATE myr_peers SET peer_url = ?, operator_name = ?, trust_level = ?, approved_at = ? WHERE public_key = ?'
        ).run(
          node_url || existing.peer_url,
          operator_name,
          trustLevel,
          autoApproved ? now : existing.approved_at,
          public_key
        );
      } catch (err) {
        return errorResponse(res, 'internal_error', 'Failed to update peer', err.message);
      }
    }

    const ourIdentity = publicKeyHex ? {
      protocol_version: '1.0.0',
      public_key: publicKeyHex,
      fingerprint: computeFingerprint(publicKeyHex),
      operator_name: operatorName,
      node_url: nodeUrl,
      capabilities: ['report-sync', 'peer-discovery', 'incremental-sync'],
      created_at: createdAt,
    } : null;

    if (publicKeyHex) {
      const traceMetadata = {
        operator_name,
        node_url: node_url || '',
        existing: !!existing,
        fingerprint_matches: fingerprintMatches,
        auto_approved: autoApproved,
      };
      if (vouch.status === 'accepted') {
        traceMetadata.vouched_by = vouch.voucher_fingerprint;
        traceMetadata.vouched_by_public_key = vouch.voucher_public_key;
      }
      writeTrace(db, {
        eventType: 'introduce',
        actorFingerprint: computeFingerprint(public_key),
        targetFingerprint: computeFingerprint(publicKeyHex),
        outcome: 'success',
        metadata: traceMetadata,
      });
    }

    return res.json({
      status: autoApproved ? 'connected' : 'introduced',
      our_identity: ourIdentity,
      trust_level: trustLevel,
      vouch,
      message: autoApproved
        ? 'Introduction received. Fingerprint verified. Connection confirmed.'
        : 'Introduction received. Mutual approval required before sync is enabled.',
    });
  });

  // --- Relay endpoint (public, uses body-level sig verification, rate-limited by fingerprint) ---
  // POST /myr/relay — forwards signed MYR payloads to known peers (fire-and-proxy)
  {
    const relayRateCounts = new Map();
    const relayRateCleanup = setInterval(() => {
      const cutoff = Date.now() - 60000;
      for (const [key, entry] of relayRateCounts) {
        if (entry.windowStart < cutoff) relayRateCounts.delete(key);
      }
    }, 5 * 60 * 1000);
    if (relayRateCleanup.unref) relayRateCleanup.unref();

    function relayRateLimit(fingerprint) {
      const now = Date.now();
      let entry = relayRateCounts.get(fingerprint);
      if (!entry || now - entry.windowStart > 60000) {
        relayRateCounts.set(fingerprint, { count: 1, windowStart: now });
        return true;
      }
      if (entry.count >= 60) return false;
      entry.count++;
      return true;
    }

    app.post('/myr/relay', async (req, res) => {
      const { from_fingerprint, to_fingerprint, payload_b64, signature } = req.body || {};

      if (!from_fingerprint || !to_fingerprint || !payload_b64 || !signature) {
        return errorResponse(res, 'invalid_request',
          'Missing required relay fields: from_fingerprint, to_fingerprint, payload_b64, signature');
      }

      // Rate limit by sender fingerprint
      if (!relayRateLimit(from_fingerprint)) {
        return res.status(429)
          .set('Retry-After', '60')
          .json({ error: { code: 'rate_limit_exceeded', message: 'Rate limit exceeded' } });
      }

      // Verify sender is a known peer
      const allPeers = db.prepare('SELECT * FROM myr_peers').all();
      const senderPeer = allPeers.find(p =>
        computeFingerprint(p.public_key) === from_fingerprint
      );

      if (!senderPeer) {
        return errorResponse(res, 'forbidden',
          'Sender fingerprint not in peer list. Relay denied.');
      }

      // Verify Ed25519 signature over payload_b64 using sender's public key
      if (!verifySignature(payload_b64, signature, senderPeer.public_key)) {
        return errorResponse(res, 'invalid_signature',
          'Payload signature verification failed');
      }

      // Find recipient peer by fingerprint
      const recipientPeer = allPeers.find(p =>
        computeFingerprint(p.public_key) === to_fingerprint
      );

      if (!recipientPeer || !recipientPeer.peer_url) {
        return errorResponse(res, 'peer_not_found',
          'Recipient fingerprint not found or has no URL');
      }

      // Decode the inner request payload
      let innerRequest;
      try {
        innerRequest = JSON.parse(Buffer.from(payload_b64, 'base64').toString('utf8'));
      } catch {
        return errorResponse(res, 'invalid_request', 'Invalid payload_b64 encoding');
      }

      const { method, path: urlPath, headers: innerHeaders, body: innerBody } = innerRequest;
      if (!method || !urlPath) {
        return errorResponse(res, 'invalid_request', 'Relay payload missing method or path');
      }

      // Forward to recipient — proxy the inner MYR request
      const targetUrl = recipientPeer.peer_url.replace(/\/$/, '') + urlPath;
      const forwardOptions = { method, headers: innerHeaders || {} };
      if (innerBody) forwardOptions.body = innerBody;

      try {
        const proxyRes = await httpFetch(targetUrl, forwardOptions);
        const relayBytes = Buffer.byteLength(payload_b64 || '', 'utf8');
        db.prepare(`
          INSERT INTO myr_routing_relay_costs (
            peer_public_key, relay_bytes, relay_requests, recorded_at, metadata
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          senderPeer.public_key,
          relayBytes,
          1,
          new Date().toISOString(),
          JSON.stringify({ method, path: urlPath, target_fingerprint: to_fingerprint })
        );

        if (publicKeyHex) {
          writeTrace(db, {
            eventType: 'relay_sync',
            actorFingerprint: from_fingerprint,
            targetFingerprint: to_fingerprint,
            outcome: 'success',
            metadata: { method, path: urlPath, proxy_status: proxyRes.status },
          });
        }

        return res.json({
          status: proxyRes.status,
          body: proxyRes.body,
          headers: proxyRes.headers,
        });
      } catch (err) {
        if (publicKeyHex) {
          writeTrace(db, {
            eventType: 'relay_sync',
            actorFingerprint: from_fingerprint,
            targetFingerprint: to_fingerprint,
            outcome: 'failure',
            metadata: { method, path: urlPath, error: err.message },
          });
        }
        return errorResponse(res, 'relay_error',
          'Failed to forward request to recipient', err.message);
      }
    });
  }

  // Auth middleware for all subsequent (protected) routes
  app.use(createAuthMiddleware(db));

  // Rate limiter: 60 req/min per peer (by public key)
  app.use(createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: config.rate_limit?.requests_per_minute || 60,
  }));

  function requireLocalOperator(req, res) {
    if (publicKeyHex && req.auth.publicKey !== publicKeyHex) {
      errorResponse(res, 'forbidden', 'Only the local node operator may perform this action');
      return false;
    }
    return true;
  }

  function getOperatorTraceMetadata(req) {
    return {
      operator_public_key: req.auth.publicKey,
      operator_signature: req.headers['x-myr-signature'] || null,
      request_timestamp: req.headers['x-myr-timestamp'] || null,
      request_nonce: req.headers['x-myr-nonce'] || null,
    };
  }

  function isReceivedYield(row) {
    return !!(row && row.imported_from && String(row.imported_from).trim() !== '');
  }

  function applicationCanonicalPayload(row) {
    return {
      id: row.id,
      source_yield_id: row.source_yield_id,
      applied_by_node_id: row.applied_by_node_id,
      downstream_use: row.downstream_use,
      ...(row.outcome ? { outcome: row.outcome } : {}),
      applied_at: row.applied_at,
      created_at: row.created_at,
      signed_by: row.signed_by,
    };
  }

  function verifyApplicationSignature(row) {
    const canonical = canonicalize(applicationCanonicalPayload(row));
    return verifySignature(canonical, row.signature, row.signed_by);
  }

  function computeCompoundingMetrics(sourceYieldId) {
    if (sourceYieldId) {
      const sourceRow = db.prepare(
        'SELECT id, imported_from FROM myr_reports WHERE id = ?'
      ).get(sourceYieldId);
      const totalReceivedYield = isReceivedYield(sourceRow) ? 1 : 0;
      const appliedReceivedYield = totalReceivedYield
        ? db.prepare(
          'SELECT COUNT(DISTINCT source_yield_id) as cnt FROM myr_applications WHERE source_yield_id = ?'
        ).get(sourceYieldId).cnt
        : 0;
      const applicationEvents = db.prepare(
        'SELECT COUNT(*) as cnt FROM myr_applications WHERE source_yield_id = ?'
      ).get(sourceYieldId).cnt;

      return {
        total_received_yield: totalReceivedYield,
        applied_received_yield: appliedReceivedYield,
        application_events: applicationEvents,
        applied_ratio: totalReceivedYield > 0 ? appliedReceivedYield / totalReceivedYield : 0,
      };
    }

    const totals = db.prepare(`
      SELECT COUNT(*) as total_received_yield
      FROM myr_reports
      WHERE imported_from IS NOT NULL AND imported_from != ''
    `).get();
    const applied = db.prepare(`
      SELECT COUNT(DISTINCT a.source_yield_id) as applied_received_yield
      FROM myr_applications a
      INNER JOIN myr_reports r ON r.id = a.source_yield_id
      WHERE r.imported_from IS NOT NULL AND r.imported_from != ''
    `).get();
    const eventCount = db.prepare('SELECT COUNT(*) as cnt FROM myr_applications').get();

    return {
      total_received_yield: totals.total_received_yield || 0,
      applied_received_yield: applied.applied_received_yield || 0,
      application_events: eventCount.cnt || 0,
      applied_ratio: (totals.total_received_yield || 0) > 0
        ? (applied.applied_received_yield || 0) / totals.total_received_yield
        : 0,
    };
  }

  // --- Network metrics endpoint (auth required; local operator or trusted peer) ---
  app.get('/myr/metrics', (req, res) => {
    const isLocalOperator = publicKeyHex && req.auth.publicKey === publicKeyHex;
    if (!isLocalOperator && !requireTrustedPeer(req, res, 'canSync')) return;

    const now = Date.now();
    const uptimeSeconds = Math.floor((now - startedAt) / 1000);
    const nodeFingerprint = publicKeyHex ? computeFingerprint(publicKeyHex) : null;

    const peersTotal = safeCount(db, 'SELECT COUNT(*) FROM myr_peers');
    const peersTrusted = safeCount(db, "SELECT COUNT(*) FROM myr_peers WHERE trust_level = 'trusted'");
    const fanout = Number.isFinite(Number(config.gossip?.fanout))
      ? Number(config.gossip.fanout)
      : 5;
    const passiveSize = Number.isFinite(Number(config.gossip?.passiveSize))
      ? Number(config.gossip.passiveSize)
      : 20;
    const activeViewSize = Math.min(peersTrusted, fanout);
    const passiveViewSize = Math.min(Math.max(peersTrusted - activeViewSize, 0), passiveSize);

    const reportsLocal = safeCount(
      db,
      "SELECT COUNT(*) FROM myr_reports WHERE imported_from IS NULL OR imported_from = ''"
    );
    const reportsImported = safeCount(
      db,
      "SELECT COUNT(*) FROM myr_reports WHERE imported_from IS NOT NULL AND imported_from != ''"
    );
    let byDomain = {};
    try {
      const rows = db.prepare('SELECT domain_tags FROM myr_reports').all();
      const counts = new Map();
      for (const row of rows) {
        for (const tag of parseDomainTags(row.domain_tags)) {
          counts.set(tag, (counts.get(tag) || 0) + 1);
        }
      }
      byDomain = Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
    } catch {
      byDomain = {};
    }

    const lastSyncRow = safeGet(
      db,
      'SELECT MAX(last_sync_at) AS val FROM myr_peers WHERE last_sync_at IS NOT NULL'
    );
    const lastSyncAt = lastSyncRow && lastSyncRow.val ? lastSyncRow.val : null;
    const syncLagSeconds = lastSyncAt
      ? Math.max(0, Math.floor((now - new Date(lastSyncAt).getTime()) / 1000))
      : null;

    const syncMessages = safeCount(
      db,
      "SELECT COUNT(*) FROM myr_traces WHERE event_type IN ('sync_pull', 'sync_push', 'relay_sync')"
    );
    const cycleCount = safeCount(db, 'SELECT COUNT(*) FROM myr_routing_cycles');
    const messagesPerCycle = cycleCount > 0 ? Number((syncMessages / cycleCount).toFixed(3)) : null;

    const ihaveSent = safeCount(
      db,
      "SELECT COUNT(*) FROM myr_traces WHERE event_type = 'gossip_ihave' AND outcome IN ('sent', 'success')"
    );
    const ihaveReceived = safeCount(
      db,
      "SELECT COUNT(*) FROM myr_traces WHERE event_type IN ('gossip_ihave_received', 'gossip_ihave_in')"
    );
    const iwantSent = safeCount(
      db,
      "SELECT COUNT(*) FROM myr_traces WHERE event_type IN ('gossip_iwant', 'gossip_iwant_sent') AND outcome IN ('sent', 'success')"
    );
    const iwantReceived = safeCount(
      db,
      "SELECT COUNT(*) FROM myr_traces WHERE event_type IN ('gossip_iwant_received', 'gossip_iwant_in')"
    );

    return res.json({
      node: {
        fingerprint: nodeFingerprint,
        uptime_seconds: uptimeSeconds,
      },
      peers: {
        total: peersTotal,
        trusted: peersTrusted,
        active_gossip_view: activeViewSize,
      },
      reports: {
        local: reportsLocal,
        imported: reportsImported,
        by_domain: byDomain,
      },
      sync: {
        last_sync_at: lastSyncAt,
        sync_lag_seconds: syncLagSeconds,
        messages_per_cycle: messagesPerCycle,
      },
      gossip: {
        active_view_size: activeViewSize,
        passive_view_size: passiveViewSize,
        ihave_sent: ihaveSent,
        ihave_received: ihaveReceived,
        iwant_sent: iwantSent,
        iwant_received: iwantReceived,
      },
    });
  });

  // --- Peer approve endpoint (auth required — local operator key only) ---
  app.post('/myr/peer/approve', (req, res) => {
    // Only the local operator (holding the private key) may approve peers
    if (!requireLocalOperator(req, res)) return;

    const { peer_fingerprint, trust_level = 'trusted' } = req.body || {};
    if (!peer_fingerprint) {
      return errorResponse(res, 'invalid_request', 'Missing peer_fingerprint');
    }

    // Find peer by fingerprint or public_key prefix
    const rows = db.prepare('SELECT * FROM myr_peers').all();
    let found = null;
    for (const row of rows) {
      if (computeFingerprint(row.public_key) === peer_fingerprint ||
          row.public_key.startsWith(peer_fingerprint)) {
        found = row;
        break;
      }
    }

    if (!found) {
      return errorResponse(res, 'peer_not_found',
        `No peer found with fingerprint ${peer_fingerprint}`);
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE myr_peers SET trust_level = ?, approved_at = ? WHERE public_key = ?')
      .run(trust_level, now, found.public_key);

    writeTrace(db, {
      eventType: 'approve',
      actorFingerprint: computeFingerprint(req.auth.publicKey),
      targetFingerprint: computeFingerprint(found.public_key),
      outcome: 'success',
      metadata: {
        ...getOperatorTraceMetadata(req),
        trust_level,
      },
    });

    const updated = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(found.public_key);
    return res.json({ status: 'approved', peer: updated });
  });

  // --- Application events endpoints (auth required) ---
  // POST /myr/applications — local operator records downstream usage of received yield.
  app.post('/myr/applications', (req, res) => {
    if (!requireLocalOperator(req, res)) return;

    if (!privateKeyHex || !publicKeyHex) {
      return errorResponse(res, 'internal_error',
        'Node signing keys are not available for application event signing');
    }

    const {
      source_id: sourceIdFromSnake,
      sourceId: sourceIdFromCamel,
      downstream_use: downstreamUseFromSnake,
      downstreamUse: downstreamUseFromCamel,
      outcome = null,
      applied_at: appliedAtFromSnake,
      appliedAt: appliedAtFromCamel,
    } = req.body || {};

    const sourceYieldId = sourceIdFromSnake || sourceIdFromCamel;
    const downstreamUse = downstreamUseFromSnake || downstreamUseFromCamel;
    const appliedAt = appliedAtFromSnake || appliedAtFromCamel || new Date().toISOString();

    if (!sourceYieldId || !downstreamUse) {
      return errorResponse(res, 'invalid_request',
        'Missing required fields: sourceId and downstreamUse');
    }

    if (typeof sourceYieldId !== 'string' || !sourceYieldId.trim()) {
      return errorResponse(res, 'invalid_request', 'sourceId must be a non-empty string');
    }

    if (typeof downstreamUse !== 'string' || !downstreamUse.trim()) {
      return errorResponse(res, 'invalid_request', 'downstreamUse must be a non-empty string');
    }

    if (outcome !== null && typeof outcome !== 'string') {
      return errorResponse(res, 'invalid_request', 'outcome must be a string when provided');
    }

    if (isNaN(new Date(appliedAt).getTime())) {
      return errorResponse(res, 'invalid_request',
        'Invalid appliedAt parameter: must be ISO8601 timestamp');
    }

    const sourceReport = db.prepare(
      'SELECT id, imported_from FROM myr_reports WHERE id = ?'
    ).get(sourceYieldId);
    if (!sourceReport) {
      return errorResponse(res, 'report_not_found',
        `No report with id ${sourceYieldId}`);
    }
    if (!isReceivedYield(sourceReport)) {
      return errorResponse(res, 'invalid_request',
        'sourceId must reference received yield (an imported report)');
    }

    const now = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      source_yield_id: sourceYieldId.trim(),
      applied_by_node_id: config.node_id || 'unknown-node',
      downstream_use: downstreamUse.trim(),
      outcome: outcome ? outcome.trim() : null,
      applied_at: new Date(appliedAt).toISOString(),
      created_at: now,
      signed_by: publicKeyHex,
    };

    const canonical = canonicalize(applicationCanonicalPayload(row));
    row.signature = signMessage(canonical, privateKeyHex);

    db.prepare(`
      INSERT INTO myr_applications (
        id, source_yield_id, applied_by_node_id, downstream_use, outcome,
        applied_at, created_at, signed_by, signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.source_yield_id,
      row.applied_by_node_id,
      row.downstream_use,
      row.outcome,
      row.applied_at,
      row.created_at,
      row.signed_by,
      row.signature
    );

    return res.status(201).json({
      application: row,
      compounding_metrics: computeCompoundingMetrics(),
    });
  });

  // GET /myr/applications — list application events, optionally filtered by source report.
  app.get('/myr/applications', (req, res) => {
    const isLocalOperator = publicKeyHex && req.auth.publicKey === publicKeyHex;
    if (!isLocalOperator) {
      if (!requireTrustedPeer(req, res, 'canReceiveYield')) return;
    }

    const sourceYieldId = req.query.sourceId || req.query.source_id || null;
    if (sourceYieldId && typeof sourceYieldId !== 'string') {
      return errorResponse(res, 'invalid_request', 'sourceId must be a string');
    }

    if (!isLocalOperator && !sourceYieldId) {
      return errorResponse(res, 'invalid_request',
        'sourceId is required when fetching applications as a peer');
    }

    if (!isLocalOperator && sourceYieldId) {
      const requester = db.prepare(
        'SELECT operator_name FROM myr_peers WHERE public_key = ?'
      ).get(req.auth.publicKey);
      const sourceReport = db.prepare(
        'SELECT imported_from FROM myr_reports WHERE id = ?'
      ).get(sourceYieldId);

      if (!sourceReport) {
        return errorResponse(res, 'report_not_found',
          `No report with id ${sourceYieldId}`);
      }

      if (!requester || !sourceReport.imported_from || sourceReport.imported_from !== requester.operator_name) {
        return errorResponse(res, 'forbidden',
          'Peers may only fetch application events for yields they originated');
      }
    }

    let rows;
    if (sourceYieldId) {
      rows = db.prepare(`
        SELECT *
        FROM myr_applications
        WHERE source_yield_id = ?
        ORDER BY created_at DESC
      `).all(sourceYieldId);
    } else {
      rows = db.prepare(`
        SELECT *
        FROM myr_applications
        ORDER BY created_at DESC
      `).all();
    }

    const applications = [];
    for (const row of rows) {
      if (verifyApplicationSignature(row)) {
        applications.push(row);
      }
    }

    return res.json({
      applications,
      compounding_metrics: computeCompoundingMetrics(sourceYieldId || null),
    });
  });

  // --- Governance audit endpoint (auth required — local operator key only) ---
  app.get('/myr/governance/audit', (req, res) => {
    if (!requireLocalOperator(req, res)) return;

    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 200, 2000));
    const traces = db.prepare(`
      SELECT *
      FROM myr_traces
      WHERE event_type IN ('approve', 'stage_change', 'revoke', 'sync_pull', 'sync_push', 'relay_sync', 'quarantine')
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit);

    const approvals = traces.filter((row) => row.event_type === 'approve');
    const revocations = traces.filter((row) => row.event_type === 'revoke');
    const syncEvents = traces.filter((row) => ['sync_pull', 'sync_push', 'relay_sync'].includes(row.event_type));
    const stageChanges = traces.filter((row) => row.event_type === 'stage_change');
    const quarantines = traces.filter((row) => row.event_type === 'quarantine');

    let peerStageChanges = [];
    try {
      peerStageChanges = db.prepare(`
        SELECT operator_name, public_key, participation_stage, stage_changed_at, stage_evidence
        FROM myr_peers
        WHERE stage_changed_at IS NOT NULL
        ORDER BY stage_changed_at DESC
        LIMIT ?
      `).all(limit).map((row) => ({
        event_type: 'stage_change',
        timestamp: row.stage_changed_at,
        actor_fingerprint: computeFingerprint(req.auth.publicKey),
        target_fingerprint: computeFingerprint(row.public_key),
        outcome: 'success',
        metadata: JSON.stringify({
          source: 'peer_stage_column',
          operator_name: row.operator_name || null,
          participation_stage: row.participation_stage || null,
          stage_evidence: row.stage_evidence || null,
        }),
      }));
    } catch (_) {
      peerStageChanges = [];
    }

    const quarantinedYields = db.prepare(`
      SELECT yield_id, quarantined_at, quarantined_by, operator_signature, reason, status, metadata
      FROM myr_quarantined_yields
      ORDER BY quarantined_at DESC
      LIMIT ?
    `).all(limit);
    const contradictionResolutions = listContradictionResolutions(db, { limit });
    const governanceSignals = listGovernanceSignals(db, { limit });

    return res.json({
      limit,
      audit: {
        approvals,
        stage_changes: [...stageChanges, ...peerStageChanges]
          .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || ''))),
        revocations,
        sync_events: syncEvents,
        quarantines,
        quarantined_yields: quarantinedYields,
        contradiction_resolutions: contradictionResolutions,
        governance_signals: governanceSignals,
      },
    });
  });

  // --- Governance revoke endpoint (auth required — local operator key only) ---
  app.post('/myr/governance/revoke', (req, res) => {
    if (!requireLocalOperator(req, res)) return;

    const { peer_fingerprint } = req.body || {};
    if (!peer_fingerprint) {
      return errorResponse(res, 'invalid_request', 'Missing peer_fingerprint');
    }

    const rows = db.prepare('SELECT * FROM myr_peers').all();
    let found = null;
    for (const row of rows) {
      if (computeFingerprint(row.public_key) === peer_fingerprint || row.public_key.startsWith(peer_fingerprint)) {
        found = row;
        break;
      }
    }
    if (!found) {
      return errorResponse(res, 'peer_not_found', `No peer found with fingerprint ${peer_fingerprint}`);
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE myr_peers SET trust_level = ? WHERE public_key = ?')
      .run('revoked', found.public_key);

    writeTrace(db, {
      eventType: 'revoke',
      actorFingerprint: computeFingerprint(req.auth.publicKey),
      targetFingerprint: computeFingerprint(found.public_key),
      outcome: 'success',
      metadata: {
        ...getOperatorTraceMetadata(req),
        revoked_at: now,
        previous_trust_level: found.trust_level,
      },
    });

    if (privateKeyHex && publicKeyHex) {
      const signal = createGovernanceSignal({
        actionType: 'revoke',
        targetId: found.public_key,
        payload: {
          previous_trust_level: found.trust_level,
          revoked_at: now,
          actor_fingerprint: computeFingerprint(req.auth.publicKey),
        },
        signerPublicKey: publicKeyHex,
        signerPrivateKey: privateKeyHex,
      });
      ingestGovernanceSignal(db, signal, { applySignal: false });
    }

    const updated = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(found.public_key);
    return res.json({ status: 'revoked', peer: updated });
  });

  // --- Governance quarantine endpoint (auth required — local operator key only) ---
  app.post('/myr/governance/quarantine', (req, res) => {
    if (!requireLocalOperator(req, res)) return;

    const { yield_id, reason = null } = req.body || {};
    if (!yield_id) {
      return errorResponse(res, 'invalid_request', 'Missing yield_id');
    }

    const report = db.prepare('SELECT id FROM myr_reports WHERE id = ?').get(yield_id);
    if (!report) {
      return errorResponse(res, 'report_not_found', `No report with id ${yield_id}`);
    }

    const now = new Date().toISOString();
    const actorFingerprint = computeFingerprint(req.auth.publicKey);
    const operatorSignature = req.headers['x-myr-signature'] || '';
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
      yield_id,
      now,
      actorFingerprint,
      operatorSignature,
      reason,
      JSON.stringify({
        source: 'governance_quarantine_endpoint',
      })
    );

    writeTrace(db, {
      eventType: 'quarantine',
      actorFingerprint,
      outcome: 'success',
      metadata: {
        ...getOperatorTraceMetadata(req),
        yield_id,
        reason,
      },
    });

    if (privateKeyHex && publicKeyHex) {
      const signal = createGovernanceSignal({
        actionType: 'quarantine',
        targetId: yield_id,
        payload: {
          quarantined_by: actorFingerprint,
          reason,
          quarantined_at: now,
        },
        signerPublicKey: publicKeyHex,
        signerPrivateKey: privateKeyHex,
      });
      ingestGovernanceSignal(db, signal, { applySignal: false });
    }

    const row = db.prepare('SELECT * FROM myr_quarantined_yields WHERE yield_id = ?').get(yield_id);
    return res.json({ status: 'quarantined', quarantine: row });
  });

  app.post('/myr/contradictions/:id/resolve', (req, res) => {
    if (!requireLocalOperator(req, res)) return;
    const contradictionId = Number(req.params.id);
    if (!Number.isInteger(contradictionId) || contradictionId <= 0) {
      return errorResponse(res, 'invalid_request', 'Invalid contradiction id');
    }
    const resolutionNote = req.body?.resolution_note || null;
    const resolvedBy = computeFingerprint(req.auth.publicKey);
    const resolutionRecord = JSON.stringify({
      contradiction_id: contradictionId,
      resolved_by: resolvedBy,
      resolution_note: resolutionNote,
      resolved_at: new Date().toISOString(),
    });
    const resolutionSignature = privateKeyHex ? signMessage(resolutionRecord, privateKeyHex) : null;

    const updated = resolveContradiction(db, {
      contradictionId,
      resolvedBy,
      resolutionNote,
      resolutionSignature,
    });
    if (!updated) {
      return errorResponse(res, 'not_found', `No contradiction with id ${contradictionId}`);
    }
    return res.json({ status: 'resolved', contradiction: updated });
  });

  app.post('/myr/governance/key-rotate', (req, res) => {
    if (!requireLocalOperator(req, res)) return;
    if (!publicKeyHex || !privateKeyHex) {
      return errorResponse(res, 'internal_error', 'Cannot rotate keys without local keypair');
    }
    const nodeId = req.body?.node_id || config.node_id || computeFingerprint(publicKeyHex);
    const { newKeypair, announcement } = rotateNodeKeypair({
      nodeId,
      oldPublicKey: publicKeyHex,
      oldPrivateKey: privateKeyHex,
    });

    const signal = createGovernanceSignal({
      actionType: 'key_rotation',
      targetId: nodeId,
      payload: announcement,
      signerPublicKey: publicKeyHex,
      signerPrivateKey: privateKeyHex,
    });
    ingestGovernanceSignal(db, signal, { applySignal: false });

    return res.json({
      status: 'rotation_announced',
      announcement,
      new_keypair: newKeypair,
    });
  });

  // --- Peer list endpoint (auth required) ---
  app.get('/myr/peer/list', (req, res) => {
    const peers = db.prepare('SELECT * FROM myr_peers ORDER BY added_at DESC').all();
    return res.json({ peers });
  });

  // --- Health verify endpoint (auth required) ---
  // MYR 1.5: verify liveness proof of self or a target peer
  app.get('/myr/health/verify', async (req, res) => {
    try {
      const targetFingerprint = req.query.fingerprint || null;

      if (!targetFingerprint) {
        // Verify self: check our own liveness_proof inline (no network call)
        if (!privateKeyHex || !publicKeyHex) {
          return errorResponse(res, 'internal_error',
            'Cannot verify self — missing keypair');
        }
        const timestamp = new Date().toISOString();
        const nonce = crypto.randomBytes(32).toString('hex');
        const signature = signMessage(timestamp + nonce, privateKeyHex);

        const result = verifyLivenessProof(
          { timestamp, nonce, signature },
          publicKeyHex,
        );

        writeTrace(db, {
          eventType: 'verify',
          actorFingerprint: computeFingerprint(publicKeyHex),
          outcome: result.verified ? 'success' : 'failure',
          metadata: { self: true, reason: result.reason || null },
        });

        return res.json({
          verified: result.verified,
          fingerprint: computeFingerprint(publicKeyHex),
          operator_name: operatorName,
          latency_ms: 0,
          timestamp,
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }

      // Verify a peer: look up by fingerprint in myr_peers
      const peers = db.prepare('SELECT * FROM myr_peers').all();
      let targetPeer = null;
      for (const peer of peers) {
        const peerFp = computeFingerprint(peer.public_key);
        if (peerFp === targetFingerprint || peer.public_key.startsWith(targetFingerprint)) {
          targetPeer = peer;
          break;
        }
      }

      if (!targetPeer) {
        return errorResponse(res, 'peer_not_found',
          `No peer found with fingerprint ${targetFingerprint}`);
      }

      if (!targetPeer.peer_url) {
        return errorResponse(res, 'invalid_request',
          'Peer has no node_url configured — cannot verify remotely');
      }

      const result = await verifyNode(targetPeer.peer_url);

      if (publicKeyHex) {
        writeTrace(db, {
          eventType: 'verify',
          actorFingerprint: computeFingerprint(publicKeyHex),
          targetFingerprint: targetFingerprint,
          outcome: result.verified ? 'success' : 'failure',
          metadata: { operator_name: result.operator_name || targetPeer.operator_name, reason: result.reason || null },
        });
      }

      return res.json({
        verified: result.verified,
        fingerprint: result.fingerprint || targetFingerprint,
        operator_name: result.operator_name || targetPeer.operator_name,
        ...(result.latency_ms != null ? { latency_ms: result.latency_ms } : {}),
        ...(result.timestamp ? { timestamp: result.timestamp } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      });
    } catch (err) {
      return errorResponse(res, 'internal_error',
        'Failed to verify liveness', err.message);
    }
  });

  async function propagateSubscriptionSignal({ signal, hopsRemaining, excludePublicKeys = [] }) {
    const hops = Math.max(0, parseInt(hopsRemaining, 10) || 0);
    if (hops <= 0 || !privateKeyHex || !publicKeyHex) {
      return { attempted: 0, delivered: 0, failed: 0 };
    }

    const excluded = new Set((excludePublicKeys || []).filter(Boolean));
    const peers = db.prepare(`
      SELECT public_key, operator_name, peer_url
      FROM myr_peers
      WHERE trust_level = 'trusted'
        AND peer_url IS NOT NULL
        AND peer_url != ''
    `).all().filter((peer) => !excluded.has(peer.public_key));

    let delivered = 0;
    let failed = 0;
    for (const peer of peers) {
      const body = {
        ...signal,
        hops_remaining: hops,
        propagated_by: computeFingerprint(publicKeyHex),
      };

      const headers = makeSignedHeaders({
        method: 'POST',
        urlPath: '/myr/subscriptions',
        body,
        privateKey: privateKeyHex,
        publicKey: publicKeyHex,
      });

      try {
        const response = await httpFetch(peer.peer_url.replace(/\/+$/, '') + '/myr/subscriptions', {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/json',
          },
          body,
        });
        if (response.status >= 200 && response.status < 300) {
          delivered++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    return { attempted: peers.length, delivered, failed };
  }

  // --- Demand signal subscription endpoints (auth required) ---
  app.post('/myr/subscriptions', async (req, res) => {
    const body = req.body || {};
    const isLocalOperator = publicKeyHex && req.auth.publicKey === publicKeyHex;

    if (!isLocalOperator && !requireTrustedPeer(req, res, 'canSync')) return;

    try {
      if (isLocalOperator) {
        if (!privateKeyHex || !publicKeyHex) {
          return errorResponse(res, 'internal_error',
            'Node signing keys are not available for subscription signing');
        }

        const tags = normalizeTags(body.tags);
        if (tags.length === 0) {
          return errorResponse(res, 'invalid_request', 'tags must contain at least one domain tag');
        }

        const status = body.action === 'unsubscribe' || body.status === 'inactive'
          ? 'inactive'
          : 'active';
        const parsedHops = Number.isFinite(Number(body.hops))
          ? Number(body.hops)
          : (Number.isFinite(Number(config.subscription_propagation_hops))
            ? Number(config.subscription_propagation_hops)
            : DEFAULT_PROPAGATION_HOPS);
        const hops = Math.max(0, Math.min(parsedHops, 5));
        const signalId = body.signal_id || computeSignalId(publicKeyHex, tags);
        const existing = db.prepare(
          'SELECT created_at FROM myr_subscriptions WHERE signal_id = ?'
        ).get(signalId);

        const signal = createSignedSignal({
          ownerPublicKey: publicKeyHex,
          ownerOperatorName: operatorName,
          tags,
          intentDescription: body.intent_description || body.intent || null,
          status,
          privateKey: privateKeyHex,
          createdAt: existing ? existing.created_at : undefined,
          signalId,
        });

        const stored = upsertSubscriptionSignal(db, signal, {
          source: 'local',
          receivedFrom: publicKeyHex,
          hopsRemaining: hops,
        });
        const propagation = await propagateSubscriptionSignal({
          signal,
          hopsRemaining: hops,
          excludePublicKeys: [publicKeyHex],
        });

        return res.status(201).json({
          status: 'ok',
          subscription: stored,
          propagation,
        });
      }

      const tags = normalizeTags(body.tags);
      if (tags.length === 0) {
        return errorResponse(res, 'invalid_request', 'tags must contain at least one domain tag');
      }
      const signal = {
        signal_id: body.signal_id,
        owner_public_key: body.owner_public_key,
        owner_fingerprint: body.owner_fingerprint,
        owner_operator_name: body.owner_operator_name || null,
        tags,
        intent_description: body.intent_description || null,
        status: body.status === 'inactive' ? 'inactive' : 'active',
        created_at: body.created_at,
        updated_at: body.updated_at,
        signal_signature: body.signal_signature,
      };

      if (!signal.signal_id || !signal.owner_public_key || !signal.created_at || !signal.updated_at) {
        return errorResponse(res, 'invalid_request',
          'Missing required fields: signal_id, owner_public_key, created_at, updated_at');
      }

      if (!verifySignalSignature(signal)) {
        return errorResponse(res, 'invalid_signature', 'Subscription signal signature verification failed');
      }

      const hopsRemaining = Math.max(0, Math.min(parseInt(body.hops_remaining, 10) || 0, 5));
      const stored = upsertSubscriptionSignal(db, signal, {
        source: 'remote',
        receivedFrom: req.auth.publicKey,
        hopsRemaining,
      });

      const propagation = await propagateSubscriptionSignal({
        signal,
        hopsRemaining: hopsRemaining - 1,
        excludePublicKeys: [req.auth.publicKey],
      });

      return res.json({
        status: 'accepted',
        subscription: stored,
        propagation,
      });
    } catch (err) {
      return errorResponse(res, 'internal_error',
        'Failed to process subscription signal', err.message);
    }
  });

  app.get('/myr/subscriptions', (req, res) => {
    const isLocalOperator = publicKeyHex && req.auth.publicKey === publicKeyHex;
    if (!isLocalOperator && !requireTrustedPeer(req, res, 'canSync')) return;

    const includeInactive = req.query.include_inactive === 'true';
    const owner = isLocalOperator && req.query.owner_public_key
      ? req.query.owner_public_key
      : req.auth.publicKey;

    const subscriptions = listSubscriptions(db, {
      ownerPublicKey: owner,
      includeInactive,
    });

    return res.json({
      subscriptions,
      owner_public_key: owner,
      include_inactive: includeInactive,
    });
  });

  // --- Reports listing endpoint (auth required, trusted peers with canReceiveYield) ---
  app.get('/myr/reports', (req, res) => {
    if (!requireTrustedPeer(req, res, 'canReceiveYield')) return;

    const from = req.query.from || req.query.since || null;
    const until = req.query.until || null;
    let limit = 100;

    if (req.query.limit !== undefined) {
      limit = parseInt(req.query.limit, 10);
      if (isNaN(limit) || limit < 1) {
        return errorResponse(res, 'invalid_request',
          'Invalid limit parameter: must be a positive integer');
      }
      limit = Math.min(limit, 500);
    }

    if (from && isNaN(new Date(from).getTime())) {
      return errorResponse(res, 'invalid_request',
        'Invalid from/since parameter: must be ISO8601 timestamp');
    }
    if (until && isNaN(new Date(until).getTime())) {
      return errorResponse(res, 'invalid_request',
        'Invalid until parameter: must be ISO8601 timestamp');
    }
    if (from && until && new Date(until).getTime() <= new Date(from).getTime()) {
      return errorResponse(res, 'invalid_request',
        'Invalid range: until must be greater than from/since');
    }

    let candidateRows;
    if (from && until) {
      candidateRows = db.prepare(`
        SELECT *
        FROM myr_reports
        WHERE share_network = 1 AND created_at > ? AND created_at <= ?
        ORDER BY created_at ASC
      `).all(from, until);
    } else if (from) {
      candidateRows = db.prepare(
        'SELECT * FROM myr_reports WHERE share_network = 1 AND created_at > ? ORDER BY created_at ASC'
      ).all(from);
    } else {
      candidateRows = db.prepare(
        'SELECT * FROM myr_reports WHERE share_network = 1 ORDER BY created_at ASC'
      ).all();
    }

    const peerSubscriptions = getActiveSubscriptionsForOwner(db, req.auth.publicKey);
    const filteredRows = peerSubscriptions.length > 0
      ? candidateRows.filter((row) => reportMatchesSubscriptions(row.domain_tags, peerSubscriptions))
      : candidateRows;

    // Trust-weighted ranking: score and sort by composite yield score
    const scored = filteredRows.map((row) => {
      const { score } = scoreReport(db, row);
      return { row, score };
    }).sort((a, b) => b.score - a.score);

    const total = scored.length;
    const topScored = scored.slice(0, limit);

    const reports = topScored.map(({ row, score }) => {
      const reportObj = { ...row };
      delete reportObj.signature;
      delete reportObj.operator_signature;
      const canonical = canonicalize(reportObj);
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const sig = 'sha256:' + hash;

      return {
        signature: sig,
        operator_name: operatorName,
        created_at: row.created_at,
        method_name: row.cycle_intent,
        operator_rating: row.operator_rating,
        yield_score: score,
        size_bytes: Buffer.byteLength(canonical, 'utf8'),
        url: '/myr/reports/' + sig,
      };
    });

    // sync_cursor: the created_at of the last returned report (use as 'since' for next call)
    const rows = topScored.map(s => s.row);
    const syncCursor = rows.length > 0 ? rows[rows.length - 1].created_at : (from || null);

    res.json({
      reports,
      total,
      since: from,
      from,
      until,
      sync_cursor: syncCursor,
      filtered_by_subscriptions: peerSubscriptions.length > 0,
      trust_weighted: true,
    });
  });

  // --- Peer announce endpoint (auth required, unknown peers allowed) ---
  app.post('/myr/peers/announce', async (req, res) => {
    const body = req.body || {};
    const requiredFields = ['peer_url', 'public_key', 'operator_name', 'timestamp', 'nonce'];
    for (const field of requiredFields) {
      if (!body[field]) {
        return errorResponse(res, 'invalid_request',
          `Missing required field: ${field}`);
      }
    }

    if (body.public_key !== req.auth.publicKey) {
      return errorResponse(res, 'key_mismatch',
        'public_key in body does not match X-MYR-Public-Key header');
    }

    const peerKey = body.public_key; // hex
    const hasFingerprint = !!body.fingerprint;

    // Check the signed registry — registry membership IS approval (v1.1.0 path).
    const registry = loadRegistry(config);
    const registryNode = registry.get(peerKey);

    // v1.1.0 path: no fingerprint in payload → require registry, auto-trust
    if (!hasFingerprint) {
      if (!registryNode) {
        return errorResponse(res, 'forbidden',
          'Public key not found in signed node registry. Contact the operator to be added.');
      }

      const now = new Date().toISOString();
      const existing = db.prepare(
        'SELECT trust_level FROM myr_peers WHERE public_key = ?'
      ).get(peerKey);

      if (existing) {
        db.prepare(
          'UPDATE myr_peers SET peer_url = ?, operator_name = ?, trust_level = ?, approved_at = ? WHERE public_key = ?'
        ).run(body.peer_url, body.operator_name, 'trusted', now, peerKey);
      } else {
        db.prepare(
          'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(body.peer_url, body.operator_name, peerKey, 'trusted', now, now);
      }

      if (publicKeyHex) {
        writeTrace(db, {
          eventType: 'introduce',
          actorFingerprint: computeFingerprint(peerKey),
          targetFingerprint: computeFingerprint(publicKeyHex),
          outcome: 'success',
          metadata: { operator_name: body.operator_name, via: 'announce', existing: !!existing },
        });
      }

      return res.json({
        status: 'connected',
        our_public_key: publicKeyHex,
        message: 'Registry member recognized. Connection confirmed.',
        approval_required: false,
        trust_level: 'trusted',
        verification_status: 'unverified',
        auto_approved: false,
      });
    }

    // --- v1.2.0 path: fingerprint present → in-band verification ---
    const now = new Date().toISOString();
    const announcedFingerprint = body.fingerprint;
    const computedFromAnnounced = computeFingerprint(peerKey);

    // Step 1: announced fingerprint must match computed from announced public key
    if (announcedFingerprint !== computedFromAnnounced) {
      const evidence = {
        announced_fingerprint: announcedFingerprint,
        computed_from_announced_key: computedFromAnnounced,
        check_failed: 'announced_fingerprint_mismatch',
      };

      const existing = db.prepare(
        'SELECT trust_level FROM myr_peers WHERE public_key = ?'
      ).get(peerKey);

      if (existing) {
        db.prepare(
          'UPDATE myr_peers SET peer_url = ?, operator_name = ?, trust_level = ?, verification_evidence = ?, node_uuid = ? WHERE public_key = ?'
        ).run(body.peer_url, body.operator_name, 'rejected', JSON.stringify(evidence), body.node_uuid || null, peerKey);
      } else {
        db.prepare(
          'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, verification_evidence, node_uuid) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(body.peer_url, body.operator_name, peerKey, 'rejected', now, JSON.stringify(evidence), body.node_uuid || null);
      }

      if (publicKeyHex) {
        writeTrace(db, {
          eventType: 'verify',
          actorFingerprint: computedFromAnnounced,
          targetFingerprint: computeFingerprint(publicKeyHex),
          outcome: 'rejected',
          rejectionReason: 'announced_fingerprint_mismatch',
          metadata: evidence,
        });
      }

      return res.json({
        status: 'rejected',
        message: 'Fingerprint verification failed: announced fingerprint does not match public key.',
        trust_level: 'rejected',
        verification_status: 'failed',
        auto_approved: false,
      });
    }

    // Step 2: Fetch discovery document from the announcing peer
    let discoveryDoc = null;
    let discoveryError = null;
    try {
      const discoveryUrl = body.peer_url.replace(/\/+$/, '') + '/.well-known/myr-node';
      const fetchPromise = httpFetch(discoveryUrl);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Discovery fetch timeout (5s)')), 5000)
      );
      const discoveryRes = await Promise.race([fetchPromise, timeoutPromise]);
      if (discoveryRes.status === 200 && discoveryRes.body && typeof discoveryRes.body === 'object') {
        discoveryDoc = discoveryRes.body;
      } else {
        discoveryError = `Discovery doc returned status ${discoveryRes.status}`;
      }
    } catch (err) {
      discoveryError = err.message;
    }

    // Discovery doc fetch failed → set trust to pending (not rejected)
    if (!discoveryDoc) {
      const evidence = {
        announced_fingerprint: announcedFingerprint,
        computed_from_announced_key: computedFromAnnounced,
        discovery_error: discoveryError,
        check_failed: 'discovery_fetch_failed',
      };

      const existing = db.prepare(
        'SELECT trust_level FROM myr_peers WHERE public_key = ?'
      ).get(peerKey);

      if (existing) {
        db.prepare(
          'UPDATE myr_peers SET peer_url = ?, operator_name = ?, trust_level = ?, verification_evidence = ?, node_uuid = ? WHERE public_key = ?'
        ).run(body.peer_url, body.operator_name, 'pending', JSON.stringify(evidence), body.node_uuid || null, peerKey);
      } else {
        db.prepare(
          'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, verification_evidence, node_uuid) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(body.peer_url, body.operator_name, peerKey, 'pending', now, JSON.stringify(evidence), body.node_uuid || null);
      }

      return res.json({
        status: 'pending',
        message: 'Discovery document could not be fetched. Peer saved as pending.',
        trust_level: 'pending',
        verification_status: 'unverified',
        auto_approved: false,
      });
    }

    // Validate discovery doc has required fields
    if (!discoveryDoc.public_key || !discoveryDoc.fingerprint) {
      const evidence = {
        announced_fingerprint: announcedFingerprint,
        computed_from_announced_key: computedFromAnnounced,
        discovery_doc_keys: Object.keys(discoveryDoc),
        check_failed: 'discovery_doc_malformed',
      };

      const existing = db.prepare(
        'SELECT trust_level FROM myr_peers WHERE public_key = ?'
      ).get(peerKey);

      if (existing) {
        db.prepare(
          'UPDATE myr_peers SET peer_url = ?, operator_name = ?, trust_level = ?, verification_evidence = ?, node_uuid = ? WHERE public_key = ?'
        ).run(body.peer_url, body.operator_name, 'rejected', JSON.stringify(evidence), body.node_uuid || null, peerKey);
      } else {
        db.prepare(
          'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, verification_evidence, node_uuid) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(body.peer_url, body.operator_name, peerKey, 'rejected', now, JSON.stringify(evidence), body.node_uuid || null);
      }

      return res.json({
        status: 'rejected',
        message: 'Discovery document is malformed (missing public_key or fingerprint).',
        trust_level: 'rejected',
        verification_status: 'failed',
        auto_approved: false,
      });
    }

    // Step 3: 3-way verification
    const discoveryFingerprint = discoveryDoc.fingerprint;
    const discoveryKey = discoveryDoc.public_key;
    const computedFromDiscovery = computeFingerprint(discoveryKey);

    const checks = {
      announced_fp_matches_key: announcedFingerprint === computedFromAnnounced,
      discovery_fp_matches_key: discoveryFingerprint === computedFromDiscovery,
      announced_key_matches_discovery: peerKey === discoveryKey,
    };
    const allPass = checks.announced_fp_matches_key && checks.discovery_fp_matches_key && checks.announced_key_matches_discovery;

    const evidence = {
      announced_fingerprint: announcedFingerprint,
      computed_from_announced_key: computedFromAnnounced,
      discovery_fingerprint: discoveryFingerprint,
      computed_from_discovery_key: computedFromDiscovery,
      announced_public_key: peerKey,
      discovery_public_key: discoveryKey,
      checks,
      all_passed: allPass,
    };

    if (!allPass) {
      // Determine which check failed for logging
      let failReason = 'unknown';
      if (!checks.discovery_fp_matches_key) failReason = 'discovery_fingerprint_mismatch';
      else if (!checks.announced_key_matches_discovery) failReason = 'public_key_mismatch';

      const existing = db.prepare(
        'SELECT trust_level FROM myr_peers WHERE public_key = ?'
      ).get(peerKey);

      if (existing) {
        db.prepare(
          'UPDATE myr_peers SET peer_url = ?, operator_name = ?, trust_level = ?, verification_evidence = ?, node_uuid = ? WHERE public_key = ?'
        ).run(body.peer_url, body.operator_name, 'rejected', JSON.stringify(evidence), body.node_uuid || null, peerKey);
      } else {
        db.prepare(
          'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, verification_evidence, node_uuid) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(body.peer_url, body.operator_name, peerKey, 'rejected', now, JSON.stringify(evidence), body.node_uuid || null);
      }

      if (publicKeyHex) {
        writeTrace(db, {
          eventType: 'verify',
          actorFingerprint: computedFromAnnounced,
          targetFingerprint: computeFingerprint(publicKeyHex),
          outcome: 'rejected',
          rejectionReason: failReason,
          metadata: evidence,
        });
      }

      return res.json({
        status: 'rejected',
        message: `Fingerprint verification failed: ${failReason}.`,
        trust_level: 'rejected',
        verification_status: 'failed',
        auto_approved: false,
      });
    }

    // All 3 checks pass — determine trust level
    let trustLevel = 'verified-pending-approval';
    let autoApproved = false;
    const autoApproveEnabled = config.auto_approve_verified_peers === true;
    const minVersion = config.auto_approve_min_protocol_version || '1.2.0';
    const peerProtocolVersion = body.protocol_version || '0.0.0';

    if (autoApproveEnabled && peerProtocolVersion >= minVersion) {
      trustLevel = 'trusted';
      autoApproved = true;
    }

    const existing = db.prepare(
      'SELECT trust_level FROM myr_peers WHERE public_key = ?'
    ).get(peerKey);

    if (existing) {
      db.prepare(
        'UPDATE myr_peers SET peer_url = ?, operator_name = ?, trust_level = ?, approved_at = ?, verification_evidence = ?, auto_approved = ?, node_uuid = ? WHERE public_key = ?'
      ).run(body.peer_url, body.operator_name, trustLevel, autoApproved ? now : null, JSON.stringify(evidence), autoApproved ? 1 : 0, body.node_uuid || null, peerKey);
    } else {
      db.prepare(
        'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at, verification_evidence, auto_approved, node_uuid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(body.peer_url, body.operator_name, peerKey, trustLevel, now, autoApproved ? now : null, JSON.stringify(evidence), autoApproved ? 1 : 0, body.node_uuid || null);
    }

    if (publicKeyHex) {
      writeTrace(db, {
        eventType: 'verify',
        actorFingerprint: computedFromAnnounced,
        targetFingerprint: computeFingerprint(publicKeyHex),
        outcome: 'success',
        metadata: { ...evidence, auto_approved: autoApproved },
      });
    }

    // Reciprocal announce: after auto-approve, announce ourselves to the peer
    if (autoApproved && privateKeyHex) {
      const reciprocalBody = {
        peer_url: nodeUrl,
        public_key: publicKeyHex,
        operator_name: operatorName,
        fingerprint: computeFingerprint(publicKeyHex),
        node_uuid: config.node_uuid || null,
        protocol_version: '1.2.0',
        timestamp: new Date().toISOString(),
        nonce: crypto.randomBytes(32).toString('hex'),
      };
      const reciprocalHeaders = makeSignedHeaders({
        method: 'POST',
        urlPath: '/myr/peers/announce',
        body: reciprocalBody,
        privateKey: privateKeyHex,
        publicKey: publicKeyHex,
      });

      const reciprocalUrl = body.peer_url.replace(/\/+$/, '') + '/myr/peers/announce';
      // Fire-and-forget with 5s timeout — do not block the response
      const fetchPromise = httpFetch(reciprocalUrl, {
        method: 'POST',
        headers: reciprocalHeaders,
        body: reciprocalBody,
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Reciprocal announce timeout (5s)')), 5000)
      );
      Promise.race([fetchPromise, timeoutPromise]).catch((err) => {
        logger.warn('reciprocal_announce_failed', {
          peer_url: body.peer_url,
          error: err.message,
        });
      });
    }

    return res.json({
      status: autoApproved ? 'connected' : 'verified',
      our_public_key: publicKeyHex,
      message: autoApproved
        ? 'Fingerprint verified. Auto-approved. Connection confirmed.'
        : 'Fingerprint verified. Pending manual approval.',
      trust_level: trustLevel,
      verification_status: 'verified',
      auto_approved: autoApproved,
    });
  });

  // --- Helper: check peer is trusted (stage-aware) ---
  function requireTrustedPeer(req, res, requiredCapability) {
    const publicKey = req.auth.publicKey;
    let peer;
    try {
      peer = db.prepare(
        'SELECT trust_level, participation_stage FROM myr_peers WHERE public_key = ?'
      ).get(publicKey);
    } catch (_) {
      // Fallback for DBs without participation_stage column
      peer = db.prepare(
        'SELECT trust_level FROM myr_peers WHERE public_key = ?'
      ).get(publicKey);
    }

    if (!peer) {
      errorResponse(res, 'unknown_peer', 'Your public key is not in our peer list');
      return null;
    }
    if (peer.trust_level === 'revoked') {
      errorResponse(res, 'forbidden', 'Peer relationship has been revoked');
      return null;
    }
    if (peer.trust_level !== 'trusted') {
      errorResponse(res, 'peer_not_trusted',
        "Peer relationship exists but trust_level != 'trusted'");
      return null;
    }

    // Stage-based enforcement when a capability is specified
    if (requiredCapability) {
      const stageCheck = enforceStage(db, publicKey, requiredCapability);
      if (stageCheck && !stageCheck.allowed) {
        errorResponse(res, 'stage_insufficient',
          `Participation stage '${stageCheck.stage}' lacks capability '${requiredCapability}'`);
        return null;
      }
    }

    return peer;
  }

  app.post('/myr/governance/gossip', (req, res) => {
    if (!requireTrustedPeer(req, res, 'canSync')) return;
    const signal = req.body?.signal;
    if (!signal || typeof signal !== 'object') {
      return errorResponse(res, 'invalid_request', 'Missing governance signal payload');
    }
    const result = ingestGovernanceSignal(db, signal, { applySignal: true });
    if (!result.accepted) {
      return res.json({ status: 'ignored', reason: result.reason });
    }
    return res.json({ status: 'accepted', forward: result.forward });
  });

  // --- Report fetch endpoint (auth required, trusted peers with canReceiveYield) ---
  app.get('/myr/reports/:signature', (req, res) => {
    if (!requireTrustedPeer(req, res, 'canReceiveYield')) return;

    const requestedSig = req.params.signature;
    const rows = db.prepare('SELECT * FROM myr_reports').all();

    let matchedRow = null;
    let computedSig = null;

    for (const row of rows) {
      const reportObj = { ...row };
      delete reportObj.signature;
      delete reportObj.operator_signature;
      const canonical = canonicalize(reportObj);
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const sig = 'sha256:' + hash;

      if (sig === requestedSig) {
        matchedRow = row;
        computedSig = sig;
        break;
      }
    }

    if (!matchedRow) {
      return errorResponse(res, 'report_not_found',
        `No report with signature ${requestedSig}`);
    }

    if (matchedRow.share_network !== 1) {
      return errorResponse(res, 'report_not_shared',
        'Report exists but share_network=false');
    }

    // Verify the report's embedded Ed25519 signature before serving (if present).
    // Per spec: "Never serve a report that fails its own signature verification."
    if (matchedRow.signed_by && matchedRow.signed_artifact) {
      const { verify: verifyEd25519 } = require('../lib/crypto');
      const reportCopy = { ...matchedRow };
      delete reportCopy.signature;
      delete reportCopy.operator_signature;
      const canonical = canonicalize(reportCopy);
      // signed_artifact may be an Ed25519 sig or a sha256 hash; verify if it's an Ed25519 sig
      if (matchedRow.signed_by.length === 64 && matchedRow.signed_artifact.length === 128) {
        if (!verifyEd25519(canonical, matchedRow.signed_artifact, matchedRow.signed_by)) {
          return errorResponse(res, 'internal_error',
            'Report failed internal signature verification');
        }
      }
    }

    const report = { ...matchedRow, signature: computedSig };
    const responseBody = JSON.stringify(report);

    if (privateKeyHex) {
      const responseSig = signMessage(responseBody, privateKeyHex);
      res.set('X-MYR-Signature', responseSig);
    }

    res.set('Content-Type', 'application/json');
    res.send(responseBody);
  });

  // --- Gossip protocol endpoints (auth required, trusted peers with canSync) ---
  app.post('/myr/gossip/ihave', (req, res) => {
    if (!requireTrustedPeer(req, res, 'canSync')) return;

    const ihaveMsg = req.body || {};
    if (ihaveMsg.type && ihaveMsg.type !== 'ihave') {
      return errorResponse(res, 'invalid_request', "gossip/ihave payload type must be 'ihave'");
    }
    if (!Array.isArray(ihaveMsg.reports)) {
      return errorResponse(res, 'invalid_request', 'gossip/ihave payload must include reports[]');
    }

    const receiverSubscriptions = publicKeyHex
      ? getActiveSubscriptionsForOwner(db, publicKeyHex)
      : [];
    const { wanted, ignored } = processIhave({
      db,
      ihaveMsg: { ...ihaveMsg, type: 'ihave' },
      receiverSubscriptions,
    });

    writeTrace(db, {
      eventType: 'sync_pull',
      actorFingerprint: computeFingerprint(req.auth.publicKey),
      targetFingerprint: publicKeyHex ? computeFingerprint(publicKeyHex) : null,
      outcome: 'success',
      metadata: {
        transport: 'gossip_ihave',
        offered_reports: ihaveMsg.reports.length,
        wanted_reports: wanted.length,
        ignored_reports: ignored,
      },
    });

    let iwant = null;
    if (wanted.length > 0 && publicKeyHex && privateKeyHex) {
      iwant = buildIwantMessage({
        signatures: wanted,
        senderPublicKey: publicKeyHex,
        senderPrivateKey: privateKeyHex,
      });
      writeTrace(db, {
        eventType: 'sync_push',
        actorFingerprint: publicKeyHex ? computeFingerprint(publicKeyHex) : null,
        targetFingerprint: computeFingerprint(req.auth.publicKey),
        outcome: 'sent',
        metadata: { transport: 'gossip_iwant', requested_reports: wanted.length },
      });
    }

    return res.json({
      status: 'ok',
      wanted_signatures: wanted,
      ignored_reports: ignored,
      iwant,
    });
  });

  app.post('/myr/gossip/iwant', (req, res) => {
    if (!requireTrustedPeer(req, res, 'canSync')) return;

    const signatures = Array.isArray(req.body?.signatures) ? req.body.signatures : null;
    if (!signatures) {
      return errorResponse(res, 'invalid_request', 'gossip/iwant payload must include signatures[]');
    }

    const uniqueSignatures = [...new Set(signatures.filter((sig) => typeof sig === 'string' && sig.trim()))];
    if (uniqueSignatures.length === 0) {
      return res.json({ status: 'ok', reports: [], missing_signatures: [] });
    }

    const placeholders = uniqueSignatures.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT *
      FROM myr_reports
      WHERE share_network = 1
        AND signed_artifact IN (${placeholders})
    `).all(...uniqueSignatures);

    const reports = rows.map((row) => ({
      ...row,
      signature: row.signed_artifact || row.signature,
      url: `/myr/reports/${encodeURIComponent(row.signed_artifact || row.signature)}`,
    }));
    const found = new Set(reports.map((r) => r.signature));
    const missingSignatures = uniqueSignatures.filter((sig) => !found.has(sig));

    writeTrace(db, {
      eventType: 'sync_pull',
      actorFingerprint: computeFingerprint(req.auth.publicKey),
      targetFingerprint: publicKeyHex ? computeFingerprint(publicKeyHex) : null,
      outcome: 'success',
      metadata: {
        transport: 'gossip_iwant',
        requested_reports: uniqueSignatures.length,
        returned_reports: reports.length,
      },
    });

    return res.json({
      status: 'ok',
      reports,
      missing_signatures: missingSignatures,
    });
  });

  app.post('/myr/sync/bloom', (req, res) => {
    if (!requireTrustedPeer(req, res, 'canSync')) return;

    const remoteBloom = req.body?.filter;
    const remoteParams = req.body?.params;
    const since = req.body?.since || null;

    const engine = new GossipEngine({
      db,
      keys: { publicKey: publicKeyHex || '', privateKey: privateKeyHex || '' },
      pss: { getActivePeers: () => [], handlePeerFailure: () => {} },
      fetchFn: null,
    });

    const localBloom = engine.buildBloomFilter({ since });
    let missingSignatures = [];

    if (remoteBloom && remoteParams && Number.isFinite(Number(remoteParams.m)) && Number.isFinite(Number(remoteParams.k))) {
      try {
        missingSignatures = engine.findMissingInBloom({
          bloomFilter: remoteBloom,
          params: remoteParams,
          since,
        });
      } catch {
        return errorResponse(res, 'invalid_request', 'Invalid bloom filter payload');
      }
    }

    let fetchableMissingSignatures = missingSignatures;
    if (missingSignatures.length > 0) {
      const placeholders = missingSignatures.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT *
        FROM myr_reports
        WHERE share_network = 1
          AND signed_artifact IN (${placeholders})
      `).all(...missingSignatures);
      fetchableMissingSignatures = rows.map((row) => {
        const reportObj = { ...row };
        delete reportObj.signature;
        delete reportObj.operator_signature;
        const canonical = canonicalize(reportObj);
        const hash = crypto.createHash('sha256').update(canonical).digest('hex');
        return `sha256:${hash}`;
      });
    }

    writeTrace(db, {
      eventType: 'sync_pull',
      actorFingerprint: computeFingerprint(req.auth.publicKey),
      targetFingerprint: publicKeyHex ? computeFingerprint(publicKeyHex) : null,
      outcome: 'success',
      metadata: {
        transport: 'gossip_bloom',
        local_count: localBloom.count,
        remote_missing_count: fetchableMissingSignatures.length,
      },
    });

    return res.json({
      status: 'ok',
      local_bloom: localBloom,
      missing_signatures: [...new Set(fetchableMissingSignatures)],
    });
  });

  // --- Yield explainability endpoint ---
  // GET /myr/reports/:reportId/explain — explain why a specific report would be surfaced or withheld
  app.get('/myr/reports/:reportId/explain', (req, res) => {
    const reportId = req.params.reportId;
    const report = db.prepare('SELECT * FROM myr_reports WHERE id = ?').get(reportId);
    if (!report) {
      return errorResponse(res, 'report_not_found', `No report with id ${reportId}`);
    }
    const explanation = explainYieldDirect(db, report);
    res.json(explanation);
  });

  // --- Sync pull endpoint (auth required, trusted peers with canSync) ---
  // POST /myr/sync/pull — Trigger async pull from requesting peer
  app.post('/myr/sync/pull', (req, res) => {
    if (!requireTrustedPeer(req, res, 'canSync')) return;

    const { since } = req.body || {};
    if (since && isNaN(new Date(since).getTime())) {
      return errorResponse(res, 'invalid_request',
        'Invalid since parameter: must be ISO8601 timestamp');
    }

    // Count estimated reports available from the requesting peer
    const peerPublicKey = req.auth.publicKey;
    const peerRow = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(peerPublicKey);

    // Generate a sync ID for tracking
    const syncId = crypto.randomUUID();

    // Estimate reports count from our shared reports (the peer will pull these)
    let estimatedReports = 0;
    if (since) {
      estimatedReports = db.prepare(
        'SELECT COUNT(*) as cnt FROM myr_reports WHERE share_network = 1 AND created_at > ?'
      ).get(since).cnt;
    } else {
      estimatedReports = db.prepare(
        'SELECT COUNT(*) as cnt FROM myr_reports WHERE share_network = 1'
      ).get().cnt;
    }

    // Update peer's last_sync_at to track this pull request
    db.prepare('UPDATE myr_peers SET last_sync_at = ? WHERE public_key = ?')
      .run(new Date().toISOString(), peerPublicKey);

    const responseBody = {
      sync_id: syncId,
      status: 'started',
      estimated_reports: estimatedReports,
    };
    const now = new Date().toISOString();
    const requestBytes = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');
    const responseBytes = Buffer.byteLength(JSON.stringify(responseBody), 'utf8');
    db.prepare(`
      INSERT INTO myr_routing_cycles (
        cycle_id, peer_public_key, started_at, ended_at, bytes_sent, bytes_received
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(syncId, peerPublicKey, now, now, responseBytes, requestBytes);

    res.json(responseBody);
  });

  // --- Coordinator endpoints (domain-aware routing, Phase 4) ---

  app.post('/myr/coordinator/register', (req, res) => {
    if (!requireTrustedPeer(req, res, 'canSync')) return;

    const { domains, peer_url } = req.body || {};
    if (!domains || (Array.isArray(domains) && domains.length === 0)) {
      return errorResponse(res, 'invalid_request',
        'coordinator/register requires domains[] with at least one domain tag');
    }

    const peerPublicKey = req.auth.publicKey;
    const peerRow = safeGet(db, 'SELECT operator_name FROM myr_peers WHERE public_key = ?', peerPublicKey);

    try {
      const result = coordinator.register(peerPublicKey, domains, {
        operatorName: peerRow?.operator_name || null,
        peerUrl: peer_url || null,
      });

      writeTrace(db, {
        eventType: 'coordinator_register',
        actorFingerprint: computeFingerprint(peerPublicKey),
        targetFingerprint: publicKeyHex ? computeFingerprint(publicKeyHex) : null,
        outcome: 'success',
        metadata: { domains: result.domains, peerCount: coordinator.getStats().peerCount },
      });

      return res.json({ status: 'ok', ...result });
    } catch (err) {
      return errorResponse(res, 'invalid_request', err.message);
    }
  });

  app.get('/myr/coordinator/route', (req, res) => {
    if (!requireTrustedPeer(req, res, 'canSync')) return;

    const domain = req.query.domain;
    if (!domain || typeof domain !== 'string' || !domain.trim()) {
      return errorResponse(res, 'invalid_request',
        'coordinator/route requires ?domain=<tag> query parameter');
    }

    const peers = coordinator.route(domain.trim());
    return res.json({
      status: 'ok',
      domain: normalizeTags([domain.trim()])[0],
      peers,
      peerCount: peers.length,
    });
  });

  app.get('/myr/coordinator/domains', (req, res) => {
    if (!requireTrustedPeer(req, res, 'canSync')) return;

    const domains = coordinator.listDomains();
    const stats = coordinator.getStats();
    return res.json({
      status: 'ok',
      domains,
      stats,
    });
  });

  // Expose coordinator on the app for gossip integration
  app.coordinator = coordinator;

  return app;
}

function startServer() {
  const config = require('../scripts/config');
  const { getDb } = require('../scripts/db');
  const db = getDb();

  const port = config.port || parseInt(process.env.MYR_PORT, 10) || 3719;
  const app = createApp({ config, db });

  const server = app.listen(port, () => {
    const nodeUrl = config.node_url || `http://localhost:${port}`;
    console.log(`MYR node server listening on port ${port}`);
    console.log(`  Discovery: ${nodeUrl}/.well-known/myr-node`);
    console.log(`  Health:    ${nodeUrl}/myr/health`);
  });

  function shutdown(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    server.close(() => {
      db.close();
      console.log('Server closed.');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Forced shutdown after timeout.');
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { server, db };
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer };
