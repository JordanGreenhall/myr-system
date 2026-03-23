'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { errorResponse } = require('./lib/errors');
const { createAuthMiddleware } = require('./middleware/auth');
const { createRateLimiter } = require('./middleware/rate-limiter');
const { canonicalize } = require('../lib/canonicalize');
const { sign: signMessage, verify: verifySignature } = require('../lib/crypto');
const { identityFingerprint, buildIdentityDocument, verifyIdentityDocument } = require('../lib/identity');

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
 */
function pemToHex(pem) {
  const keyObj = crypto.createPublicKey(pem);
  const der = keyObj.export({ type: 'spki', format: 'der' });
  return der.slice(-32).toString('hex');
}

/**
 * Load network/nodes.json and return a Map of hex public key → node entry.
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
 * Helper: require trusted peer for auth-required + trusted-only endpoints.
 * Returns the peer row if trusted, or sends error response and returns null.
 */
function requireTrustedPeer(db, req, res) {
  const publicKey = req.auth.publicKey;
  const peer = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(publicKey);

  if (!peer) {
    errorResponse(res, 'unknown_peer', 'Your public key is not in our peer list');
    return null;
  }

  if (peer.trust_level !== 'trusted') {
    errorResponse(res, 'peer_not_trusted', "Peer relationship exists but trust_level != 'trusted'");
    return null;
  }

  return peer;
}

/**
 * Create the Express app.
 * Accepts explicit publicKeyHex/createdAt/privateKeyHex for testing,
 * otherwise loads from filesystem using config.keys_path and config.node_id.
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

  // Compute our fingerprint (for identity doc)
  const nodeFingerprint = publicKeyHex ? identityFingerprint(publicKeyHex) : null;

  // Build our identity document (for introduce responses)
  function getOurIdentityDocument() {
    if (!publicKeyHex || !privateKeyHex || !operatorName) return null;
    return buildIdentityDocument({
      publicKey: publicKeyHex,
      privateKey: privateKeyHex,
      operator_name: operatorName,
      node_url: nodeUrl,
      created_at: createdAt,
    });
  }

  // =====================================================================
  // PUBLIC ENDPOINTS (no auth required)
  // =====================================================================

  // --- Discovery endpoint (v1.0) ---
  app.get('/.well-known/myr-node', (req, res) => {
    if (!publicKeyHex) {
      return errorResponse(res, 'internal_error',
        'Node configuration invalid', 'Unable to load node public key');
    }
    if (!operatorName) {
      return errorResponse(res, 'internal_error',
        'Node configuration invalid', 'Missing operator_name in config');
    }

    res.json({
      protocol_version: '1.0.0',
      node_url: nodeUrl,
      operator_name: operatorName,
      public_key: publicKeyHex,
      fingerprint: nodeFingerprint,
      capabilities: ['report-sync', 'peer-discovery', 'incremental-sync'],
      created_at: createdAt,
      rate_limits: {
        requests_per_minute: 60,
        min_sync_interval_minutes: 15,
      },
    });
  });

  // --- Health endpoint with liveness signature (v1.0) ---
  app.get('/myr/health', (req, res) => {
    try {
      const peersTotal = safeCount(db, 'SELECT COUNT(*) FROM myr_peers');
      const peersActive = safeCount(db,
        "SELECT COUNT(*) FROM myr_peers WHERE trust_level='trusted'");
      const reportsTotal = safeCount(db, 'SELECT COUNT(*) FROM myr_reports');

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

      // Liveness proof: sign timestamp + nonce with our private key
      const timestamp = new Date().toISOString();
      const nonce = crypto.randomBytes(32).toString('hex');
      let livenessSignature = null;
      if (privateKeyHex) {
        livenessSignature = signMessage(timestamp + nonce, privateKeyHex);
      }

      res.json({
        status: 'ok',
        node_url: nodeUrl,
        operator_name: operatorName,
        public_key: publicKeyHex || null,
        timestamp,
        nonce,
        liveness_signature: livenessSignature,
        last_sync_at: lastSyncAt,
        peers_active: peersActive,
        peers_total: peersTotal,
        reports_total: reportsTotal,
        uptime_seconds: uptimeSeconds,
      });
    } catch (err) {
      return errorResponse(res, 'internal_error',
        'Failed to query node status', err.message);
    }
  });

  // --- Peer introduction (public — creates pending peer record) ---
  app.post('/myr/peer/introduce', (req, res) => {
    const body = req.body || {};
    if (!body.identity_document) {
      return errorResponse(res, 'invalid_request', 'Missing identity_document in request body');
    }

    const doc = body.identity_document;

    // Verify the identity document's signature
    if (!verifyIdentityDocument(doc)) {
      return errorResponse(res, 'invalid_request', 'Identity document signature verification failed');
    }

    if (!doc.public_key || !doc.fingerprint || !doc.operator_name) {
      return errorResponse(res, 'invalid_request', 'Identity document missing required fields');
    }

    const peerKey = doc.public_key;
    const peerFingerprint = doc.fingerprint;
    const peerUrl = doc.node_url || null;
    const now = new Date().toISOString();

    // Check if peer already exists
    const existing = db.prepare('SELECT trust_level FROM myr_peers WHERE public_key = ?').get(peerKey);

    if (existing) {
      // Update URL/name if changed, but don't downgrade trust
      db.prepare(
        'UPDATE myr_peers SET peer_url = COALESCE(?, peer_url), operator_name = ?, fingerprint = ? WHERE public_key = ?'
      ).run(peerUrl, doc.operator_name, peerFingerprint, peerKey);
    } else {
      // Create new peer record as 'introduced'
      db.prepare(
        'INSERT INTO myr_peers (peer_url, operator_name, public_key, fingerprint, trust_level, added_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(peerUrl || '', doc.operator_name, peerKey, peerFingerprint, 'introduced', now);
    }

    // Return our identity document
    const ourDoc = getOurIdentityDocument();

    res.json({
      status: 'introduced',
      our_identity: ourDoc,
      trust_level: existing ? existing.trust_level : 'introduced',
      message: 'Introduction received. Mutual approval required before sync is enabled.',
    });
  });

  // =====================================================================
  // AUTH + RATE-LIMITED ENDPOINTS
  // =====================================================================

  // Auth middleware for all subsequent (protected) routes
  const authMiddleware = createAuthMiddleware(db);
  const rateLimiter = createRateLimiter({
    windowMs: config.rateLimitWindowMs || 60000,
    maxRequests: config.rateLimitMax || 60,
  });

  app.use(authMiddleware);
  app.use(rateLimiter);

  // --- Peer approval (auth required, known peer) ---
  app.post('/myr/peer/approve', (req, res) => {
    const body = req.body || {};
    if (!body.peer_fingerprint) {
      return errorResponse(res, 'invalid_request', 'Missing peer_fingerprint');
    }

    const targetFingerprint = body.peer_fingerprint;
    const requestedLevel = body.trust_level || 'trusted';

    if (requestedLevel !== 'trusted') {
      return errorResponse(res, 'invalid_request', 'Only trust_level "trusted" is supported for approval');
    }

    // Find the peer by fingerprint
    const peer = db.prepare('SELECT * FROM myr_peers WHERE fingerprint = ?').get(targetFingerprint);
    if (!peer) {
      return errorResponse(res, 'not_found', 'No peer found with that fingerprint');
    }

    if (peer.trust_level === 'revoked') {
      return errorResponse(res, 'forbidden', 'Cannot approve a revoked peer');
    }

    const now = new Date().toISOString();
    db.prepare(
      'UPDATE myr_peers SET trust_level = ?, approved_at = ? WHERE fingerprint = ?'
    ).run('trusted', now, targetFingerprint);

    res.json({
      status: 'approved',
      peer_fingerprint: targetFingerprint,
      trust_level: 'trusted',
      approved_at: now,
    });
  });

  // --- Peer list (auth required) ---
  app.get('/myr/peer/list', (req, res) => {
    const peers = db.prepare('SELECT peer_url, operator_name, public_key, fingerprint, trust_level, added_at, approved_at, last_sync_at FROM myr_peers').all();
    res.json({ peers });
  });

  // --- Reports listing endpoint (auth required, trusted peers only) ---
  app.get('/myr/reports', (req, res) => {
    const peer = requireTrustedPeer(db, req, res);
    if (!peer) return;

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
        method_name: row.cycle_intent || null,
        operator_rating: row.operator_rating ?? null,
        size_bytes: Buffer.byteLength(canonical, 'utf8'),
        url: '/myr/reports/' + sig,
      };
    });

    // sync_cursor: use as 'since' in next incremental sync call
    const sync_cursor = rows.length > 0 ? rows[rows.length - 1].created_at : (since || null);

    res.json({
      reports,
      total,
      since,
      sync_cursor,
    });
  });

  // --- Peer announce endpoint (v0.3 compat — auth required) ---
  app.post('/myr/peers/announce', (req, res) => {
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

    const peerKey = body.public_key;
    const now = new Date().toISOString();

    const existing = db.prepare(
      'SELECT trust_level FROM myr_peers WHERE public_key = ?'
    ).get(peerKey);

    if (existing) {
      if (existing.trust_level === 'pending' || existing.trust_level === 'introduced') {
        // Re-announce from a pending peer — 409 conflict
        return res.status(409).json({
          error: { code: 'peer_exists', message: 'Peer request already pending approval.' },
        });
      }
      // Trusted peer re-announcing: update URL, keep trust_level
      db.prepare(
        'UPDATE myr_peers SET peer_url = ?, operator_name = ? WHERE public_key = ?'
      ).run(body.peer_url, body.operator_name, peerKey);
      return res.json({
        status: 'connected',
        our_public_key: publicKeyHex,
        message: 'Peer reconnected with updated address.',
        approval_required: false,
      });
    }

    // New peer — store as pending
    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
    ).run(body.peer_url, body.operator_name, peerKey, 'pending', now);

    return res.json({
      status: 'pending_approval',
      our_public_key: publicKeyHex,
      message: 'Peer request received. Awaiting operator approval.',
      approval_required: true,
    });
  });

  // --- Report fetch endpoint (auth required, trusted peers only) ---
  app.get('/myr/reports/:signature', (req, res) => {
    const peer = requireTrustedPeer(db, req, res);
    if (!peer) return;

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

    // Verify report's embedded signature before serving (if it has one)
    if (matchedRow.operator_signature && matchedRow.signed_by) {
      const reportForVerify = { ...matchedRow };
      delete reportForVerify.operator_signature;
      const reportCanonical = canonicalize(reportForVerify);
      if (!verifySignature(reportCanonical, matchedRow.operator_signature, matchedRow.signed_by)) {
        return errorResponse(res, 'internal_error',
          'Report failed internal signature verification');
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

  // --- Sync pull trigger (auth required, trusted peers only) ---
  app.post('/myr/sync/pull', (req, res) => {
    const peer = requireTrustedPeer(db, req, res);
    if (!peer) return;

    const since = (req.body && req.body.since) || null;

    // Count reports that would be fetched
    let estimatedReports = 0;
    try {
      if (since) {
        const row = db.prepare(
          'SELECT COUNT(*) as cnt FROM myr_reports WHERE share_network = 1 AND created_at > ?'
        ).get(since);
        estimatedReports = row ? row.cnt : 0;
      } else {
        const row = db.prepare(
          'SELECT COUNT(*) as cnt FROM myr_reports WHERE share_network = 1'
        ).get();
        estimatedReports = row ? row.cnt : 0;
      }
    } catch { /* leave at 0 */ }

    const syncId = crypto.randomUUID();

    // Update last_sync_at for this peer
    const now = new Date().toISOString();
    db.prepare('UPDATE myr_peers SET last_sync_at = ? WHERE public_key = ?')
      .run(now, req.auth.publicKey);

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
