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
 *   myr start                     — Start server in foreground
 *   myr status                    — Show node identity and peer status
 */

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const os = require('os');
const nodeCrypto = require('crypto');
const { sign, fingerprint: computeFingerprint } = require('../lib/crypto');
const { syncPeer: syncPeerCore, makeSignedHeaders, httpFetch, cleanupNonces } = require('../lib/sync');
const { TOPIC_NAME, discoverPeers, startBackgroundAnnounce } = require('../lib/dht');
const { verifyNode } = require('../lib/liveness');

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

/**
 * Sync reports from a specific trusted peer.
 */
async function syncPeer({ db, peerName, keys, fetch: fetchFn }) {
  const peer = findPeer(db, peerName);
  if (!peer) throw new Error(`No peer found matching "${peerName}"`);
  if (peer.trust_level !== 'trusted') {
    throw new Error(`Peer "${peer.operator_name}" is not trusted (status: ${peer.trust_level})`);
  }

  const syncOpts = { db, peer, keys };
  if (fetchFn) syncOpts.fetch = fetchFn;

  const result = await syncPeerCore(syncOpts);

  if (result.peerNotTrusted) {
    throw new Error(`Peer "${peer.operator_name}" has not approved us yet.`);
  }

  return {
    message: `Synced ${result.imported} new report${result.imported !== 1 ? 's' : ''} from ${peer.operator_name}`,
    imported: result.imported,
    peerName: peer.operator_name,
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
        event_type TEXT NOT NULL,
        actor_fingerprint TEXT NOT NULL,
        target_fingerprint TEXT,
        artifact_signature TEXT,
        outcome TEXT NOT NULL,
        rejection_reason TEXT,
        metadata TEXT DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON myr_traces(timestamp);
    `);
    return db;
  }

  // Fall back to legacy config-based DB
  const { getDb } = require('../scripts/db');
  return getDb();
}

// --- CLI entry point ---

if (require.main === module) {
  const { loadNodeConfig } = require('../lib/node-config');

  const program = new Command();
  program
    .name('myr')
    .description('MYR network node management CLI')
    .version('1.0.0');

  // ── myr setup ──────────────────────────────────────────────────────────────
  program
    .command('setup')
    .description('Set up this node: generate keypair, provision tunnel, verify public URL')
    .option('--operator-name <name>', 'Operator name (skips interactive prompt)')
    .option('--public-url <url>', 'Use this URL instead of provisioning a Cloudflare Tunnel')
    .option('--tunnel-token <token>', 'Cloudflare Tunnel token for headless setup (or set CLOUDFLARE_TUNNEL_TOKEN)')
    .option('--port <port>', 'Server port (default: 3719)', parseInt)
    .action(async (opts) => {
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
        const result = await runSetup({
          operatorName: opts.operatorName,
          publicUrl: opts.publicUrl,
          tunnelToken: opts.tunnelToken,
          port,
          log: console.log,
          prompt,
        });

        console.log('\n✓ Node is live.\n');
        console.log('Your node identity:');
        console.log(`  Name:        ${result.config.operator_name}`);
        console.log(`  Fingerprint: ${computeFingerprint(result.keypair.publicKey)}`);
        console.log(`  URL:         ${result.nodeUrl}`);
        console.log('\nShare this to invite peers:');
        console.log(`  myr peer add --url ${result.nodeUrl}`);
        console.log('');

        if (result.tunnelProcess) {
          result.tunnelProcess.kill();
        }
      } catch (err) {
        console.error('\nSetup failed:', err.message);
        process.exit(1);
      }
    });

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
    .description('Discover peers on the DHT network (myr-network-v1)')
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

        console.log(`Scanning ${TOPIC_NAME} (DHT)...`);
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
          const result = await syncPeer({ db, peerName: opts.peer, keys });
          console.log(result.message);
        } else {
          const peers = db.prepare("SELECT * FROM myr_peers WHERE trust_level = 'trusted' AND auto_sync = 1").all();
          if (peers.length === 0) {
            console.log('No trusted peers to sync from.');
            return;
          }

          let totalImported = 0;
          for (const peer of peers) {
            try {
              const result = await syncPeer({ db, peerName: peer.operator_name, keys });
              console.log(result.message);
              totalImported += result.imported;
            } catch (err) {
              console.error(`  Failed to sync ${peer.operator_name}: ${err.message}`);
            }
          }
          console.log(`\nSync complete: ${totalImported} new report(s) imported.`);
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
    .action((opts) => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
        process.exit(1);
      }

      const { createApp } = require('../server');

      const port = opts.port || nodeConfig.port || 3719;
      const nodeUrl = nodeConfig.node_url || `http://localhost:${port}`;
      const db = getDbFromNodeConfig(nodeConfig);
      const keys = loadKeypair(nodeConfig);

      const app = createApp({
        config: { ...nodeConfig, port },
        db,
        publicKeyHex: keys.publicKey,
        privateKeyHex: keys.privateKey,
      });

      let dhtAnnouncer = null;

      const server = app.listen(port, () => {
        console.log(`MYR node server started`);
        console.log(`  Operator: ${nodeConfig.operator_name}`);
        console.log(`  URL:      ${nodeUrl}`);
        console.log(`  Port:     ${port}`);
        console.log(`  Discovery: ${nodeUrl}/.well-known/myr-node`);

        // Start DHT background announce if enabled in config
        if (nodeConfig.discovery && nodeConfig.discovery.dht_enabled) {
          const identityDocument = {
            protocol_version: '1.0.0',
            node_url: nodeUrl,
            operator_name: nodeConfig.operator_name,
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
          console.log(`  DHT: Announcing on ${TOPIC_NAME}`);
        }

        // Show relay status
        const relayConfig = nodeConfig.relay;
        if (relayConfig && relayConfig.enabled) {
          const fallbackStr = relayConfig.fallback_only !== false ? '(fallback)' : '(always)';
          console.log(`  Relay:     ${relayConfig.url} ${fallbackStr}`);
        }

        console.log('Press Ctrl+C to stop.');
      });

      function shutdown(signal) {
        console.log(`\n${signal} received. Shutting down...`);
        if (dhtAnnouncer) dhtAnnouncer.stop().catch(() => {});
        server.close(() => { db.close(); process.exit(0); });
        setTimeout(() => process.exit(1), 5000).unref();
      }

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    });

  // ── myr status ──────────────────────────────────────────────────────────────
  program
    .command('status')
    .description('Show node identity, active peers, and last sync times')
    .action(() => {
      const nodeConfig = loadNodeConfig();
      if (!nodeConfig) {
        console.error('Node not configured. Run: myr setup');
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

        console.log('\nNode Identity:');
        console.log(`  Operator:    ${nodeConfig.operator_name}`);
        console.log(`  Fingerprint: ${fp}`);
        console.log(`  URL:         ${nodeConfig.node_url || '(not set)'}`);
        console.log(`  Port:        ${nodeConfig.port || 3719}`);

        const relayConfig = nodeConfig.relay;
        if (relayConfig && relayConfig.enabled) {
          const fallbackStr = relayConfig.fallback_only !== false ? 'fallback enabled' : 'always active';
          console.log(`  Relay:       ${relayConfig.url} (${fallbackStr})`);
        }

        console.log('\nPeers:');
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
  listPeers,
  getFingerprint,
  getPeerFingerprint,
  syncPeer,
  nodeVerify,
  makeSignedHeaders,
  httpFetch,
  loadKeypair,
  loadPublicKeyHex,
  loadPrivateKeyHex,
};
