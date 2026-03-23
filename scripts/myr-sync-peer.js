#!/usr/bin/env node
'use strict';

// DEPRECATED: Use `myr sync --peer <name>` instead. This wrapper will be removed in a future release.

const peerName = process.argv[2];
if (!peerName) {
  console.error('Usage: myr-sync-peer.js <peer_name>');
  console.error('DEPRECATED: Use: node bin/myr.js sync --peer <name>');
  process.exit(1);
}

console.error(`DEPRECATED: scripts/myr-sync-peer.js is deprecated. Use: node bin/myr.js sync --peer ${peerName}`);

const { execFileSync } = require('child_process');
const path = require('path');

try {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'myr.js'), 'sync', '--peer', peerName], {
    stdio: 'inherit',
  });
} catch (err) {
  process.exit(err.status || 1);
}
