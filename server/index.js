'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { errorResponse } = require('./lib/errors');
const { createAuthMiddleware } = require('./middleware/auth');

function loadPublicKeyHex(keysPath, nodeId) {
  const publicKeyPath = path.join(keysPath, `${nodeId}.public.pem`);
  const pem = fs.readFileSync(publicKeyPath, 'utf8');
  const keyObj = crypto.createPublicKey(pem);
  const der = keyObj.export({ type: 'spki', format: 'der' });
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
 * Create the Express app. Accepts explicit publicKeyHex/createdAt for testing,
 * otherwise loads from the filesystem using config.keys_path and config.node_id.
 */
function createApp({ config, db, publicKeyHex, createdAt }) {
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
