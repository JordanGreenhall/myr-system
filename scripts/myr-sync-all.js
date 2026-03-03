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
  validateConfig(config);

  const db = getDb();
  const keys = loadKeypair(config);

  const peers = db.prepare(
    "SELECT * FROM myr_peers WHERE auto_sync = 1 AND trust_level = 'trusted'"
  ).all();

  let totalImported = 0;
  let syncedOk = 0;
  let syncedFail = 0;

  for (const peer of peers) {
    try {
      const result = await syncPeer({ db, peer, keys });

      if (result.peerNotTrusted) {
        console.log(`  ${peer.operator_name}: Peer has not approved us yet`);
        continue;
      }

      syncedOk++;
      totalImported += result.imported;

      if (result.imported > 0 || result.skipped > 0 || result.failed > 0) {
        console.log(`  ${peer.operator_name}: imported=${result.imported} skipped=${result.skipped} failed=${result.failed}`);
      }

      if (result.failed > 0) syncedFail++;
    } catch (err) {
      console.error(`  ${peer.operator_name}: ${err.message}`);
      syncedFail++;
    }
  }

  cleanupNonces(db);

  console.log(`Sync complete. Imported ${totalImported} new reports from ${syncedOk} peers.`);

  db.close();

  if (syncedFail > 0 && syncedOk === 0) {
    process.exit(2);
  } else if (syncedFail > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(2);
});
