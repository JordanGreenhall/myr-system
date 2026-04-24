'use strict';

/**
 * myr-readiness.js — MYR-facing readiness check
 *
 * Gate 3 proof: Reports node status entirely in MYR terms.
 * Hyperspace is queried but never exposed to the user.
 *
 * Usage:
 *   node scripts/myr-readiness.js [--json] [--verbose]
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const MYR_HOME = process.env.MYR_HOME || path.join(__dirname, '..');
const JSON_OUTPUT = process.argv.includes('--json');
const VERBOSE = process.argv.includes('--verbose');

// ─────────────────────────────────────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────────────────────────────────────

const checks = {
  identity: { status: 'unknown', detail: null },
  store: { status: 'unknown', detail: null },
  network: { status: 'unknown', detail: null },
  substrate: { status: 'unknown', detail: null },
};

// 1. Identity
try {
  const config = JSON.parse(fs.readFileSync(path.join(MYR_HOME, 'config.json'), 'utf8'));
  const keyFiles = fs.readdirSync(path.join(MYR_HOME, 'keys')).filter(f => f.endsWith('.public.pem'));
  if (keyFiles.length === 0) throw new Error('No public key');

  const pubPem = fs.readFileSync(path.join(MYR_HOME, 'keys', keyFiles[0]), 'utf8');
  const pubKey = crypto.createPublicKey(pubPem);
  const spki = pubKey.export({ type: 'spki', format: 'der' });
  const fingerprint = crypto.createHash('sha256').update(spki).digest('base64url');

  checks.identity = {
    status: 'ok',
    detail: { node_id: config.node_id, fingerprint },
  };
} catch (err) {
  checks.identity = { status: 'error', detail: err.message };
}

// 2. Store
try {
  const dbPath = path.join(MYR_HOME, 'myr.db');
  if (fs.existsSync(dbPath)) {
    const stat = fs.statSync(dbPath);
    checks.store = {
      status: 'ok',
      detail: { size_kb: Math.round(stat.size / 1024) },
    };
  } else {
    checks.store = { status: 'empty', detail: 'No database yet' };
  }
} catch (err) {
  checks.store = { status: 'error', detail: err.message };
}

// 3. Network substrate (Hyperspace — queried but reported as "network")
try {
  const statusPath = path.join(process.env.HOME, '.hyperspace', 'status.json');
  delete require.cache[require.resolve(statusPath)];
  const s = require(statusPath);
  const alive =
    s.pid &&
    execSync(`kill -0 ${s.pid} 2>/dev/null && echo y || echo n`)
      .toString()
      .trim() === 'y';

  if (alive) {
    checks.substrate = {
      status: 'running',
      detail: {
        peers: s.peerCount || 0,
        capabilities: (s.capabilities || []).length,
        uptime_hours: parseFloat((s.uptimeHours || 0).toFixed(2)),
      },
    };
    checks.network = {
      status: (s.peerCount || 0) > 0 ? 'connected' : 'isolated',
      detail: { peers: s.peerCount || 0 },
    };
  } else {
    checks.substrate = { status: 'stopped', detail: null };
    checks.network = { status: 'offline', detail: 'Network node not running' };
  }
} catch {
  checks.substrate = { status: 'not_installed', detail: null };
  checks.network = { status: 'unavailable', detail: 'Network substrate not configured' };
}

// 4. Hyperspace API reachable (quick health check)
async function checkSubstrateAPI() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8080/health', { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          if (body.status === 'ok') {
            resolve({ api: true, version: body.version });
          } else {
            resolve({ api: false });
          }
        } catch {
          resolve({ api: false });
        }
      });
    });
    req.on('error', () => resolve({ api: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ api: false });
    });
  });
}

async function main() {
  const apiCheck = await checkSubstrateAPI();

  if (apiCheck.api && checks.substrate.detail) {
    checks.substrate.detail.api_reachable = true;
  }

  // ── Output ──────────────────────────────────────────────────────────────
  if (JSON_OUTPUT) {
    const result = {
      timestamp: new Date().toISOString(),
      node_id: checks.identity.detail?.node_id || 'unknown',
      overall:
        checks.identity.status === 'ok' &&
        checks.store.status === 'ok' &&
        checks.network.status === 'connected'
          ? 'ready'
          : 'degraded',
      checks: {
        identity: checks.identity.status,
        store: checks.store.status,
        network: checks.network.status,
      },
    };
    if (VERBOSE) {
      result.details = checks;
    }
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Human-readable MYR-facing output
    console.log('');
    console.log('MYR Node Status');
    console.log('────────────────────────────────────');

    // Identity
    if (checks.identity.status === 'ok') {
      console.log(`  Identity:  ✓ ${checks.identity.detail.node_id} (${checks.identity.detail.fingerprint.substring(0, 16)}...)`);
    } else {
      console.log(`  Identity:  ✗ ${checks.identity.detail}`);
    }

    // Store
    if (checks.store.status === 'ok') {
      console.log(`  Store:     ✓ operational (${checks.store.detail.size_kb}KB)`);
    } else {
      console.log(`  Store:     ${checks.store.status === 'empty' ? '~' : '✗'} ${checks.store.detail}`);
    }

    // Network
    if (checks.network.status === 'connected') {
      console.log(`  Network:   ✓ connected (${checks.network.detail.peers} peers)`);
    } else if (checks.network.status === 'isolated') {
      console.log(`  Network:   ~ node running but no peers yet`);
    } else {
      console.log(`  Network:   ✗ ${checks.network.detail}`);
    }

    // Substrate (only in verbose mode — this is the layer we're hiding)
    if (VERBOSE && checks.substrate.status !== 'not_installed') {
      console.log('');
      console.log('  Substrate details (hidden from normal output):');
      console.log(`    Status:       ${checks.substrate.status}`);
      if (checks.substrate.detail) {
        console.log(`    Capabilities: ${checks.substrate.detail.capabilities}`);
        console.log(`    API:          ${checks.substrate.detail.api_reachable ? 'reachable' : 'unreachable'}`);
        console.log(`    Uptime:       ${checks.substrate.detail.uptime_hours}h`);
      }
    }

    console.log('');

    // Overall
    const overall =
      checks.identity.status === 'ok' &&
      checks.store.status === 'ok' &&
      checks.network.status === 'connected';
    console.log(overall ? '  Status: READY' : '  Status: DEGRADED');
    console.log('');
  }
}

main().catch((err) => {
  console.error('Readiness check failed:', err.message);
  process.exit(1);
});
