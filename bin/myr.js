#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const nodeCrypto = require('crypto');
const { sign, fingerprint: computeFingerprint } = require('../lib/crypto');
const { syncPeer: syncPeerCore, makeSignedHeaders, httpFetch } = require('../lib/sync');

// --- Key loading ---

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

function loadKeypair(config) {
  return {
    publicKey: loadPublicKeyHex(config.keys_path, config.node_id),
    privateKey: loadPrivateKeyHex(config.keys_path, config.node_id),
  };
}

// --- Peer lookup ---

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

// --- Command implementations (exported for testing) ---

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

  const ourOperatorName = config.operator_name || config.node_name;
  const ourNodeUrl = config.node_url || `http://localhost:${config.port}`;
  const announceBody = {
    peer_url: ourNodeUrl,
    public_key: keys.publicKey,
    operator_name: ourOperatorName,
    timestamp: new Date().toISOString(),
    nonce: nodeCrypto.randomBytes(32).toString('hex'),
  };

  const signedHeaders = makeSignedHeaders({
    method: 'POST',
    urlPath: '/myr/peers/announce',
    body: announceBody,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });

  let announceStatus;
  try {
    const announceRes = await fetchFn(baseUrl + '/myr/peers/announce', {
      method: 'POST',
      headers: signedHeaders,
      body: announceBody,
    });
    announceStatus = announceRes.status;
  } catch {
    announceStatus = 0;
  }

  return {
    message: `Peer added (pending approval): ${operator_name} at ${peerUrl}`,
    peer: { operator_name, public_key, peer_url: peerUrl },
    announceStatus,
  };
}

function approvePeer({ db, identifier }) {
  const peer = findPeer(db, identifier);
  if (!peer) throw new Error(`No peer found matching "${identifier}"`);

  db.prepare('UPDATE myr_peers SET trust_level = ?, approved_at = ? WHERE public_key = ?')
    .run('trusted', new Date().toISOString(), peer.public_key);

  return { message: `Peer approved: ${peer.operator_name}`, peer };
}

function rejectPeer({ db, identifier }) {
  const peer = findPeer(db, identifier);
  if (!peer) throw new Error(`No peer found matching "${identifier}"`);

  db.prepare('UPDATE myr_peers SET trust_level = ? WHERE public_key = ?')
    .run('rejected', peer.public_key);

  return { message: `Peer rejected: ${peer.operator_name}`, peer };
}

function listPeers({ db }) {
  return db.prepare('SELECT * FROM myr_peers ORDER BY added_at DESC').all();
}

function getFingerprint({ publicKeyHex }) {
  return computeFingerprint(publicKeyHex);
}

function getPeerFingerprint({ db, name }) {
  const peer = findPeer(db, name);
  if (!peer) throw new Error(`No peer found matching "${name}"`);
  return { name: peer.operator_name, fingerprint: computeFingerprint(peer.public_key) };
}

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

// --- CLI wiring ---

if (require.main === module) {
  const config = require('../scripts/config');
  const { getDb } = require('../scripts/db');

  const program = new Command();
  program.name('myr').description('MYR network peer management CLI').version('0.4.0');

  program.command('add-peer <url>').description('Add a new peer by URL')
    .action(async (url) => {
      let db;
      try {
        db = getDb();
        const keys = loadKeypair(config);
        const result = await addPeer({ db, config, url, keys });
        console.log(result.message);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program.command('approve-peer <identifier>').description('Approve a pending peer')
    .action((identifier) => {
      let db;
      try {
        db = getDb();
        console.log(approvePeer({ db, identifier }).message);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program.command('reject-peer <identifier>').description('Reject a peer')
    .action((identifier) => {
      let db;
      try {
        db = getDb();
        console.log(rejectPeer({ db, identifier }).message);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program.command('peers').description('List all peers')
    .action(() => {
      let db;
      try {
        db = getDb();
        const peers = listPeers({ db });
        if (peers.length === 0) {
          console.log('No peers configured.');
          return;
        }

        const cols = { name: 16, url: 36, trust: 10, added: 20, synced: 20 };
        console.log(
          'OPERATOR'.padEnd(cols.name) + 'URL'.padEnd(cols.url) +
          'TRUST'.padEnd(cols.trust) + 'ADDED'.padEnd(cols.added) + 'LAST SYNC'
        );
        console.log('-'.repeat(cols.name + cols.url + cols.trust + cols.added + cols.synced));
        for (const p of peers) {
          console.log(
            (p.operator_name || '\u2014').padEnd(cols.name) +
            (p.peer_url || '\u2014').padEnd(cols.url) +
            (p.trust_level || 'pending').padEnd(cols.trust) +
            (p.added_at ? p.added_at.slice(0, 10) : '\u2014').padEnd(cols.added) +
            (p.last_sync_at ? p.last_sync_at.slice(0, 10) : 'never')
          );
        }
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program.command('fingerprint').description('Show our node fingerprint')
    .action(() => {
      try {
        const hex = loadPublicKeyHex(config.keys_path, config.node_id);
        console.log(`Your fingerprint: ${getFingerprint({ publicKeyHex: hex })}`);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
    });

  program.command('peer-fingerprint <name>').description("Show a peer's fingerprint")
    .action((name) => {
      let db;
      try {
        db = getDb();
        const result = getPeerFingerprint({ db, name });
        console.log(`${result.name} fingerprint: ${result.fingerprint}`);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program.command('sync <peer_name>').description('Sync reports from a trusted peer')
    .action(async (peerName) => {
      let db;
      try {
        db = getDb();
        const keys = loadKeypair(config);
        const result = await syncPeer({ db, peerName, keys });
        console.log(result.message);
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
  findPeer, addPeer, approvePeer, rejectPeer, listPeers,
  getFingerprint, getPeerFingerprint, syncPeer,
  makeSignedHeaders, httpFetch, loadKeypair, loadPublicKeyHex, loadPrivateKeyHex,
};
