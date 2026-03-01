'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

function getKeyFingerprint(nodeId, keysPath) {
  const keyPath = path.join(keysPath, `${nodeId}.public.pem`);
  if (!fs.existsSync(keyPath)) return null;
  try {
    const pem = fs.readFileSync(keyPath, 'utf8');
    const pubKey = crypto.createPublicKey(pem);
    const der = pubKey.export({ type: 'spki', format: 'der' });
    const hash = crypto.createHash('sha256').update(der).digest('hex');
    return 'SHA256:' + hash.slice(0, 16) + '…';
  } catch (_) {
    return null;
  }
}

function short(str) {
  if (!str) return 'unknown';
  return str.slice(0, 8);
}

function main() {
  const nodeId = config.node_id;
  const nodeUuid = config.node_uuid || null;
  const fingerprint = getKeyFingerprint(nodeId, config.keys_path);

  console.log('\nMYR Node Identity');
  console.log('─────────────────────────────────────────');
  console.log(`  node_id:     ${nodeId}`);
  console.log(`  node_uuid:   ${nodeUuid || 'not set (run myr-keygen to generate)'}`);
  console.log(`  key:         ${fingerprint || 'no public key found for ' + nodeId}`);
  console.log('');
  console.log(`  Fingerprint: ${nodeId} / ${short(nodeUuid)} / ${fingerprint || 'n/a'}`);
  console.log('─────────────────────────────────────────');
  console.log('Share this identity card with peers before exchanging MYR packages.\n');
}

main();
