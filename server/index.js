'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { errorResponse } = require('./lib/errors');
const { createAuthMiddleware } = require('./middleware/auth');
const { createRateLimiter } = require('./middleware/rate-limit');
const { canonicalize } = require('../lib/canonicalize');
const { sign: signMessage, verify: verifySignature, fingerprint: computeFingerprint } = require('../lib/crypto');
const { httpFetch, makeSignedHeaders } = require('../lib/sync');
const { verifyLivenessProof, verifyNode } = require('../lib/liveness');
const { writeTrace } = require('../lib/trace');

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

/**
 * Create the Express app. Accepts explicit publicKeyHex/createdAt for testing,
 * otherwise loads from the filesystem using config.keys_path and config.node_id.
 */
function createApp({ config, db, publicKeyHex, createdAt, privateKeyHex }) {
  const app = express();
  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }));

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
      capabilities: ['report-sync', 'peer-discovery', 'incremental-sync'],
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

  // --- Peer introduce endpoint (PUBLIC — no auth required) ---
  // MYR v1.0 protocol: POST /myr/peer/introduce
  // Receives an identity document, creates a pending peer record, returns our identity.
  app.post('/myr/peer/introduce', (req, res) => {
    const body = req.body || {};
    const { identity_document } = body;

    if (!identity_document) {
      return errorResponse(res, 'invalid_request', 'Missing identity_document in request body');
    }

    const { public_key, operator_name, node_url } = identity_document;

    if (!public_key || !operator_name) {
      return errorResponse(res, 'invalid_request',
        'identity_document must include public_key and operator_name');
    }

    const now = new Date().toISOString();
    const existing = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(public_key);

    if (!existing) {
      try {
        db.prepare(
          'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
        ).run(node_url || '', operator_name, public_key, 'introduced', now);
      } catch (err) {
        return errorResponse(res, 'internal_error', 'Failed to store peer', err.message);
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
      writeTrace(db, {
        eventType: 'introduce',
        actorFingerprint: computeFingerprint(public_key),
        targetFingerprint: computeFingerprint(publicKeyHex),
        outcome: 'success',
        metadata: { operator_name, node_url: node_url || '', existing: !!existing },
      });
    }

    return res.json({
      status: 'introduced',
      our_identity: ourIdentity,
      trust_level: 'introduced',
      message: 'Introduction received. Mutual approval required before sync is enabled.',
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

  // --- Peer approve endpoint (auth required — local operator key only) ---
  app.post('/myr/peer/approve', (req, res) => {
    // Only the local operator (holding the private key) may approve peers
    if (publicKeyHex && req.auth.publicKey !== publicKeyHex) {
      return errorResponse(res, 'forbidden',
        'Only the local node operator may approve peers');
    }

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

    db.prepare('UPDATE myr_peers SET trust_level = ?, approved_at = ? WHERE public_key = ?')
      .run(trust_level, new Date().toISOString(), found.public_key);

    const updated = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(found.public_key);
    return res.json({ status: 'approved', peer: updated });
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

  // --- Reports listing endpoint (auth required, trusted peers only) ---
  app.get('/myr/reports', (req, res) => {
    if (!requireTrustedPeer(req, res)) return;

    const since = req.query.since || null;
    let limit = 100;

    if (req.query.limit !== undefined) {
      limit = parseInt(req.query.limit, 10);
      if (isNaN(limit) || limit < 1) {
        return errorResponse(res, 'invalid_request',
          'Invalid limit parameter: must be a positive integer');
      }
      limit = Math.min(limit, 500);
    }

    if (since && isNaN(new Date(since).getTime())) {
      return errorResponse(res, 'invalid_request',
        'Invalid since parameter: must be ISO8601 timestamp');
    }

    let rows, total;
    if (since) {
      rows = db.prepare(
        'SELECT * FROM myr_reports WHERE share_network = 1 AND created_at > ? ORDER BY created_at ASC LIMIT ?'
      ).all(since, limit);
      total = db.prepare(
        'SELECT COUNT(*) as cnt FROM myr_reports WHERE share_network = 1 AND created_at > ?'
      ).get(since).cnt;
    } else {
      rows = db.prepare(
        'SELECT * FROM myr_reports WHERE share_network = 1 ORDER BY created_at ASC LIMIT ?'
      ).all(limit);
      total = db.prepare(
        'SELECT COUNT(*) as cnt FROM myr_reports WHERE share_network = 1'
      ).get().cnt;
    }

    const reports = rows.map((row) => {
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
        size_bytes: Buffer.byteLength(canonical, 'utf8'),
        url: '/myr/reports/' + sig,
      };
    });

    // sync_cursor: the created_at of the last returned report (use as 'since' for next call)
    const syncCursor = rows.length > 0 ? rows[rows.length - 1].created_at : (since || null);

    res.json({
      reports,
      total,
      since,
      sync_cursor: syncCursor,
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
        console.error(`Reciprocal announce to ${body.peer_url} failed: ${err.message}`);
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

  // --- Helper: check peer is trusted ---
  function requireTrustedPeer(req, res) {
    const publicKey = req.auth.publicKey;
    const peer = db.prepare(
      'SELECT trust_level FROM myr_peers WHERE public_key = ?'
    ).get(publicKey);

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
    return peer;
  }

  // --- Report fetch endpoint (auth required, trusted peers only) ---
  app.get('/myr/reports/:signature', (req, res) => {
    if (!requireTrustedPeer(req, res)) return;

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

  // --- Sync pull endpoint (auth required, trusted peers only) ---
  // POST /myr/sync/pull — Trigger async pull from requesting peer
  app.post('/myr/sync/pull', (req, res) => {
    if (!requireTrustedPeer(req, res)) return;

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

    res.json({
      sync_id: syncId,
      status: 'started',
      estimated_reports: estimatedReports,
    });
  });

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
