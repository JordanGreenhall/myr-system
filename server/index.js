'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { errorResponse } = require('./lib/errors');
const { createAuthMiddleware } = require('./middleware/auth');
const { canonicalize } = require('../lib/canonicalize');
const { sign: signMessage } = require('../lib/crypto');

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

    res.json({
      protocol_version: '0.3.0',
      node_url: nodeUrl,
      operator_name: operatorName,
      public_key: publicKeyHex,
      supported_features: ['report-sync', 'peer-discovery', 'incremental-sync'],
      created_at: createdAt,
      rate_limits: {
        requests_per_minute: 60,
        min_sync_interval_minutes: 15,
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

      res.json({
        status: 'ok',
        node_url: nodeUrl,
        operator_name: operatorName,
        last_sync_at: lastSyncAt,
        peers_active: peersActive,
        peers_total: peersTotal,
        reports_total: reportsTotal,
        reports_shared: reportsShared,
        uptime_seconds: uptimeSeconds,
      });
    } catch (err) {
      return errorResponse(res, 'internal_error',
        'Failed to query node status', err.message);
    }
  });

  // Auth middleware for all subsequent (protected) routes
  app.use(createAuthMiddleware(db));

  // --- Reports listing endpoint (auth required, trusted peers only) ---
  app.get('/myr/reports', (req, res) => {
    const publicKey = req.auth.publicKey;

    const peer = db.prepare(
      'SELECT trust_level FROM myr_peers WHERE public_key = ?'
    ).get(publicKey);

    if (!peer) {
      return errorResponse(res, 'unknown_peer',
        'Your public key is not in our peer list');
    }

    if (peer.trust_level !== 'trusted') {
      return errorResponse(res, 'peer_not_trusted',
        "Peer relationship exists but trust_level != 'trusted'");
    }

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

    res.json({
      reports,
      total,
      since,
    });
  });

  // --- Peer announce endpoint (auth required, unknown peers allowed) ---
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

    const peerKey = body.public_key; // hex

    // Check the signed registry — registry membership IS approval.
    const registry = loadRegistry(config);
    const registryNode = registry.get(peerKey);

    if (!registryNode) {
      return errorResponse(res, 'forbidden',
        'Public key not found in signed node registry. Contact the operator to be added.');
    }

    const now = new Date().toISOString();
    const existing = db.prepare(
      'SELECT trust_level FROM myr_peers WHERE public_key = ?'
    ).get(peerKey);

    if (existing) {
      // Already in DB — update URL and ensure trusted (handles pending→trusted upgrade too).
      db.prepare(
        'UPDATE myr_peers SET peer_url = ?, operator_name = ?, trust_level = ?, approved_at = ? WHERE public_key = ?'
      ).run(body.peer_url, body.operator_name, 'trusted', now, peerKey);
    } else {
      // First announce — auto-trust because they're in the signed registry.
      db.prepare(
        'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(body.peer_url, body.operator_name, peerKey, 'trusted', now, now);
    }

    return res.json({
      status: 'connected',
      our_public_key: publicKeyHex,
      message: 'Registry member recognized. Connection confirmed.',
      approval_required: false,
    });
  });

  // --- Report fetch endpoint (auth required, trusted peers only) ---
  app.get('/myr/reports/:signature', (req, res) => {
    const publicKey = req.auth.publicKey;

    const peer = db.prepare(
      'SELECT trust_level FROM myr_peers WHERE public_key = ?'
    ).get(publicKey);

    if (!peer) {
      return errorResponse(res, 'unknown_peer',
        'Your public key is not in our peer list');
    }

    if (peer.trust_level !== 'trusted') {
      return errorResponse(res, 'peer_not_trusted',
        "Peer relationship exists but trust_level != 'trusted'");
    }

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

    const report = { ...matchedRow, signature: computedSig };
    const responseBody = JSON.stringify(report);

    if (privateKeyHex) {
      const responseSig = signMessage(responseBody, privateKeyHex);
      res.set('X-MYR-Signature', responseSig);
    }

    res.set('Content-Type', 'application/json');
    res.send(responseBody);
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
