#!/usr/bin/env node
'use strict';

/**
 * myr — MYR Network CLI v1.0
 *
 * Commands:
 *   myr setup          Initialize node (keypair, tunnel, verify)
 *   myr start          Start MYR server in foreground
 *   myr status         Show node identity and peer info
 *   myr peer add       Add a peer by URL
 *   myr peer approve   Approve a pending peer
 *   myr peer list      List known peers
 *   myr sync           Sync reports from trusted peers
 */

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { loadHomeConfig, saveHomeConfig, ensureMyrDirs, getMyrHome } = require('../lib/home-config');
const { getHomeDb } = require('../lib/home-db');
const { fingerprint: computeFingerprintLegacy } = require('../lib/crypto');
const { makeSignedHeaders, httpFetch, syncPeer: syncPeerCore } = require('../lib/sync');

// --- Key helpers (PEM-based, home-dir) ---

function loadKeysFromConfig(config) {
  const privatePath = config.keypair_path;
  const publicPath = config.keypair_path + '.pub';

  if (!fs.existsSync(privatePath) || !fs.existsSync(publicPath)) {
    throw new Error(
      `Keypair not found at ${privatePath}\nRun 'myr setup' first to generate your node identity.`
    );
  }

  const privPem = fs.readFileSync(privatePath, 'utf8');
  const pubPem = fs.readFileSync(publicPath, 'utf8');

  const pubDer = crypto.createPublicKey(pubPem).export({ type: 'spki', format: 'der' });
  const publicKeyHex = pubDer.slice(-32).toString('hex');

  const privDer = crypto.createPrivateKey(privPem).export({ type: 'pkcs8', format: 'der' });
  const privateKeyHex = privDer.slice(-32).toString('hex');

  return { publicKey: publicKeyHex, privateKey: privateKeyHex };
}

function computeFingerprint(publicKeyHex) {
  const hash = crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest();
  return hash.toString('base64url');
}

// --- Peer helpers ---

function findPeer(db, identifier) {
  // Try by operator_name
  let peer = db.prepare('SELECT * FROM myr_peers WHERE operator_name = ?').get(identifier);
  if (peer) return peer;

  // Try by fingerprint prefix (match against public_key -> fingerprint)
  const allPeers = db.prepare('SELECT * FROM myr_peers').all();
  const matches = allPeers.filter((p) => {
    const fp = computeFingerprint(p.public_key);
    return fp.startsWith(identifier) || p.public_key.startsWith(identifier);
  });

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Ambiguous: ${matches.length} peers match "${identifier}". Use a longer prefix.`);
  }
  return null;
}

// =============================================================================
// CLI Program
// =============================================================================

const program = new Command();
program
  .name('myr')
  .description('MYR Network — peer-to-peer intelligence compounding')
  .version('1.0.0');

// --- myr setup ---
program
  .command('setup')
  .description('Initialize this MYR node (generate identity, provision connectivity, verify)')
  .option('--operator-name <name>', 'Operator name (skip interactive prompt)')
  .option('--public-url <url>', 'Use this public URL instead of provisioning a Cloudflare Tunnel')
  .option('--tunnel-token <token>', 'Cloudflare Tunnel token for headless auth')
  .action(async (opts) => {
    try {
      const { runSetup } = require('../lib/setup');
      const result = await runSetup({
        operatorName: opts.operatorName,
        publicUrl: opts.publicUrl,
        tunnelToken: opts.tunnelToken,
      });

      console.log('');
      if (result.keypairGenerated) {
        console.log(`✓ Keypair generated: ${result.keypairPath}`);
      } else {
        console.log(`✓ Keypair loaded: ${result.keypairPath}`);
      }
      console.log(`✓ Fingerprint: ${result.fingerprint}`);

      if (result.tunnelProvisioned) {
        console.log(`✓ Cloudflare Tunnel provisioned: ${result.nodeUrl}`);
      }

      if (result.nodeUrl) {
        if (result.verified) {
          console.log(`✓ Public URL verified reachable (tested from external)`);
        } else if (result.verifyError) {
          console.log(`✗ Public URL NOT reachable: ${result.verifyError}`);
          console.log('');
          console.log('Setup completed but external verification failed.');
          console.log('Your node may not be accessible to peers until this is resolved.');
          process.exitCode = 1;
        }
      }

      console.log(`✓ Config saved: ${result.configPath}`);
      console.log('');
      console.log('Your node identity:');
      console.log(`  Name:        ${result.operatorName}`);
      console.log(`  Fingerprint: ${result.fingerprint}`);
      if (result.nodeUrl) {
        console.log(`  URL:         ${result.nodeUrl}`);
        console.log('');
        console.log('Share this to invite peers:');
        console.log(`  myr peer add --url ${result.nodeUrl}`);
      }

      // If tunnel is running, keep process alive
      if (result.tunnelProcess) {
        console.log('');
        console.log('Tunnel is running. Press Ctrl+C to stop.');
        process.on('SIGINT', () => {
          const { stopTunnel } = require('../lib/cloudflared');
          stopTunnel(result.tunnelProcess);
          process.exit(0);
        });
      }
    } catch (err) {
      console.error(`Setup failed: ${err.message}`);
      process.exit(1);
    }
  });

// --- myr start ---
program
  .command('start')
  .description('Start MYR server in foreground')
  .option('-p, --port <port>', 'Port to listen on', '3719')
  .action((opts) => {
    try {
      const config = loadHomeConfig();
      const port = parseInt(opts.port, 10) || config.port || 3719;
      config.port = port;

      const keys = loadKeysFromConfig(config);
      const db = getHomeDb(config);

      const { createApp } = require('../server/index');
      const app = createApp({
        config: {
          ...config,
          node_id: config.operator_name,
          operator_name: config.operator_name,
          keys_path: path.dirname(config.keypair_path),
        },
        db,
        publicKeyHex: keys.publicKey,
        privateKeyHex: keys.privateKey,
      });

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
        setTimeout(() => process.exit(1), 5000).unref();
      }

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    } catch (err) {
      console.error(`Failed to start: ${err.message}`);
      process.exit(1);
    }
  });

// --- myr status ---
program
  .command('status')
  .description('Show node identity, active peers, and last sync times')
  .action(() => {
    try {
      const config = loadHomeConfig();

      if (!fs.existsSync(config.keypair_path)) {
        console.log('Node not set up. Run: myr setup');
        process.exit(1);
      }

      const keys = loadKeysFromConfig(config);
      const fingerprint = computeFingerprint(keys.publicKey);
      const db = getHomeDb(config);

      console.log('Node Identity:');
      console.log(`  Operator:    ${config.operator_name || '(not set)'}`);
      console.log(`  Fingerprint: ${fingerprint}`);
      console.log(`  Public Key:  ${keys.publicKey}`);
      console.log(`  URL:         ${config.node_url || '(not set)'}`);
      console.log(`  Config:      ${config._configPath}`);
      console.log('');

      const peers = db.prepare('SELECT * FROM myr_peers ORDER BY added_at DESC').all();
      if (peers.length === 0) {
        console.log('Peers: none');
      } else {
        console.log(`Peers (${peers.length}):`);
        for (const p of peers) {
          const pFp = computeFingerprint(p.public_key);
          const syncInfo = p.last_sync_at ? `last sync: ${p.last_sync_at}` : 'never synced';
          console.log(`  ${p.operator_name || '?'} [${p.trust_level}] ${pFp.slice(0, 12)}... (${syncInfo})`);
        }
      }

      db.close();
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// --- myr peer (subcommand group) ---
const peer = program.command('peer').description('Manage peers');

peer
  .command('add')
  .description('Add a new peer by URL')
  .requiredOption('--url <url>', 'Peer node URL')
  .action(async (opts) => {
    let db;
    try {
      const config = loadHomeConfig();
      const keys = loadKeysFromConfig(config);
      db = getHomeDb(config);

      const baseUrl = opts.url.replace(/\/$/, '');
      console.log(`Fetching node identity from ${baseUrl}...`);

      const discovery = await httpFetch(baseUrl + '/.well-known/myr-node');
      if (discovery.status !== 200) {
        throw new Error(`Failed to fetch node info from ${opts.url}: HTTP ${discovery.status}`);
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
      ).run(peerUrl, operator_name, public_key, 'introduced', new Date().toISOString());

      // Send introduction
      const ourNodeUrl = config.node_url || `http://localhost:${config.port}`;
      const announceBody = {
        identity_document: {
          protocol_version: '1.0.0',
          public_key: keys.publicKey,
          operator_name: config.operator_name,
          node_url: ourNodeUrl,
          fingerprint: computeFingerprint(keys.publicKey),
          created_at: new Date().toISOString(),
        },
        introduction_message: `Introduction from ${config.operator_name}`,
      };

      const signedHeaders = makeSignedHeaders({
        method: 'POST',
        urlPath: '/myr/peer/introduce',
        body: announceBody,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
      });

      try {
        await httpFetch(baseUrl + '/myr/peer/introduce', {
          method: 'POST',
          headers: signedHeaders,
          body: announceBody,
        });
      } catch {
        // Introduction endpoint may not exist on older nodes — try announce
        try {
          const legacyBody = {
            peer_url: ourNodeUrl,
            public_key: keys.publicKey,
            operator_name: config.operator_name,
            timestamp: new Date().toISOString(),
            nonce: crypto.randomBytes(32).toString('hex'),
          };
          const legacyHeaders = makeSignedHeaders({
            method: 'POST',
            urlPath: '/myr/peers/announce',
            body: legacyBody,
            privateKey: keys.privateKey,
            publicKey: keys.publicKey,
          });
          await httpFetch(baseUrl + '/myr/peers/announce', {
            method: 'POST',
            headers: legacyHeaders,
            body: legacyBody,
          });
        } catch {
          // peer not reachable for introduction — that's OK
        }
      }

      const peerFp = computeFingerprint(public_key);
      console.log(`✓ Found: ${operator_name} (fingerprint: ${peerFp.slice(0, 12)}...)`);
      console.log(`Introduction sent. Waiting for ${operator_name} to approve.`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    } finally {
      if (db) db.close();
    }
  });

peer
  .command('approve')
  .description('Approve a pending peer by fingerprint or name')
  .argument('<identifier>', 'Peer fingerprint prefix or operator name')
  .action((identifier) => {
    let db;
    try {
      const config = loadHomeConfig();
      db = getHomeDb(config);

      const peerRecord = findPeer(db, identifier);
      if (!peerRecord) throw new Error(`No peer found matching "${identifier}"`);

      db.prepare('UPDATE myr_peers SET trust_level = ?, approved_at = ? WHERE public_key = ?')
        .run('trusted', new Date().toISOString(), peerRecord.public_key);

      console.log(`✓ Peer approved: ${peerRecord.operator_name}. Sync enabled.`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    } finally {
      if (db) db.close();
    }
  });

peer
  .command('list')
  .description('List all known peers and their trust status')
  .action(() => {
    let db;
    try {
      const config = loadHomeConfig();
      db = getHomeDb(config);

      const peers = db.prepare('SELECT * FROM myr_peers ORDER BY added_at DESC').all();
      if (peers.length === 0) {
        console.log('No peers configured. Add one with: myr peer add --url <url>');
        return;
      }

      const cols = { name: 16, url: 40, trust: 12, synced: 22 };
      console.log(
        'OPERATOR'.padEnd(cols.name) +
        'URL'.padEnd(cols.url) +
        'TRUST'.padEnd(cols.trust) +
        'LAST SYNC'
      );
      console.log('-'.repeat(cols.name + cols.url + cols.trust + cols.synced));
      for (const p of peers) {
        console.log(
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

// --- myr sync ---
program
  .command('sync')
  .description('Sync reports from trusted peers')
  .option('--peer <fingerprint>', 'Sync from a specific peer only')
  .action(async (opts) => {
    let db;
    try {
      const config = loadHomeConfig();
      const keys = loadKeysFromConfig(config);
      db = getHomeDb(config);

      let peers;
      if (opts.peer) {
        const p = findPeer(db, opts.peer);
        if (!p) throw new Error(`No peer found matching "${opts.peer}"`);
        if (p.trust_level !== 'trusted') {
          throw new Error(`Peer "${p.operator_name}" is not trusted (status: ${p.trust_level})`);
        }
        peers = [p];
      } else {
        peers = db.prepare("SELECT * FROM myr_peers WHERE trust_level = 'trusted'").all();
        if (peers.length === 0) {
          console.log('No trusted peers to sync with.');
          return;
        }
      }

      let totalImported = 0;
      for (const p of peers) {
        try {
          console.log(`Syncing from ${p.operator_name}...`);
          const result = await syncPeerCore({
            db,
            peer: p,
            keys: { publicKey: keys.publicKey, privateKey: keys.privateKey },
          });

          if (result.peerNotTrusted) {
            console.log(`  ${p.operator_name} has not approved us yet.`);
          } else {
            console.log(`  ✓ ${result.imported} new report(s) from ${p.operator_name}`);
            totalImported += result.imported;
          }
        } catch (err) {
          console.error(`  ✗ Error syncing from ${p.operator_name}: ${err.message}`);
        }
      }

      console.log(`\nSync complete. ${totalImported} new report(s) imported.`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    } finally {
      if (db) db.close();
    }
  });

program.parse(process.argv);
