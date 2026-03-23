#!/usr/bin/env node
'use strict';

// DEPRECATED: Use `myr sync` instead. This wrapper will be removed in a future release.

console.error('DEPRECATED: scripts/myr-sync-all.js is deprecated. Use: node bin/myr.js sync');

const { execFileSync } = require('child_process');
const path = require('path');

try {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'myr.js'), 'sync'], {
    stdio: 'inherit',
  });
} catch (err) {
  process.exit(err.status || 1);
}
