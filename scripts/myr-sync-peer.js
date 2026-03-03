#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');
const { validateConfig } = require('./config');
const { getDb } = require('./db');
const { syncPeer, cleanupNonces } = require('../lib/sync');

function loadKeypair(cfg) {
  const pubPem = fs.readFileSync(path.join(cfg.keys_path, `${cfg.node_id}.public.pem`), 'utf8');
  const pubDer = crypto.createPublicKey(pubPem).export({ type: 'spki', format: 'der' });
  const publicKey = pubDer.slice(-32).toString('hex');

  const privPem = fs.readFileSync(path.join(cfg.keys_path, `${cfg.node_id}.private.pem`), 'utf8');
  const privDer = crypto.createPrivateKey(privPem).export({ type: 'pkcs8', format: 'der' });
  const privateKey = privDer.slice(-32).toString('hex');

  return { publicKey, privateKey };
}

async function main() {
  const peerName = process.argv[2];
  if (!peerName) {
    console.error('Usage: myr-sync-peer.js <peer_name>');
    process.exit(1);
  }

  validateConfig(config);

  const db = getDb();
  const keys = loadKeypair(config);

  const peer = db.prepare('SELECT * FROM myr_peers WHERE operator_name = ?').get(peerName);
  if (!peer) {
    console.error(`No peer found: ${peerName}`);
    db.close();
    process.exit(1);
  }

  try {
    const result = await syncPeer({ db, peer, keys });

    if (result.peerNotTrusted) {
      console.log('Peer has not approved us yet');
      cleanupNonces(db);
      db.close();
      process.exit(0);
    }

    console.log(`Synced ${result.imported} new report(s) from ${peer.operator_name}`);
    if (result.skipped > 0) {
      console.log(`  ${result.skipped} report(s) already existed (skipped)`);
    }
    if (result.failed > 0) {
      console.log(`  ${result.failed} report(s) failed verification`);
    }

    cleanupNonces(db);
    db.close();
    process.exit(result.failed > 0 ? 1 : 0);
  } catch (err) {
    console.error(err.message);
    db.close();
    process.exit(1);
  }
}

main();
