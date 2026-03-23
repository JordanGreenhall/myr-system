'use strict';

/**
 * lib/setup.js — MYR node setup logic
 *
 * Handles:
 * - Keypair generation and storage at ~/.myr/keys/node.key
 * - Cloudflare Tunnel provisioning (interactive and headless)
 * - External URL reachability verification
 * - Config writing to ~/.myr/config.json
 *
 * All paths resolved via os.homedir() — never hard-coded.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFileSync, spawn } = require('child_process');
const { generateKeypair } = require('./crypto');
const {
  getMyrDir,
  getBinDir,
  getKeysDir,
  getDbPath,
  saveKeypair,
  saveNodeConfig,
  loadNodeConfig,
} = require('./node-config');

// Platform → cloudflared download URL mapping
const CLOUDFLARED_URLS = {
  'linux-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
  'linux-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',
  'darwin-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
  'darwin-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz',
};

/**
 * Returns the path where cloudflared binary will be stored.
 * ~/.myr/bin/cloudflared
 */
function getCloudflaredBinPath() {
  return path.join(getBinDir(), process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

/**
 * Check if cloudflared binary exists and is executable.
 */
function isCloudflaredInstalled() {
  const binPath = getCloudflaredBinPath();
  if (!fs.existsSync(binPath)) return false;
  try {
    execFileSync(binPath, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Download cloudflared binary to ~/.myr/bin/cloudflared.
 * @param {object} opts
 * @param {function} [opts.log] - logging function
 * @returns {Promise<string>} path to binary
 */
async function downloadCloudflared({ log = () => {} } = {}) {
  const platformKey = `${process.platform}-${process.arch}`;
  const downloadUrl = CLOUDFLARED_URLS[platformKey];

  if (!downloadUrl) {
    throw new Error(
      `No cloudflared binary available for platform ${platformKey}. ` +
      `Use --public-url to skip tunnel provisioning.`
    );
  }

  const binDir = getBinDir();
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const binPath = getCloudflaredBinPath();
  log(`Downloading cloudflared for ${platformKey}...`);

  await downloadFile(downloadUrl, binPath);
  fs.chmodSync(binPath, 0o755);

  log(`✓ cloudflared installed at ${binPath}`);
  return binPath;
}

/**
 * Download a file via HTTP redirect following.
 * @param {string} url
 * @param {string} dest
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    function followRedirect(currentUrl) {
      const mod = currentUrl.startsWith('https:') ? https : http;
      const req = mod.get(currentUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (!redirectUrl) return reject(new Error('Redirect with no location header'));
          res.resume();
          return followRedirect(redirectUrl);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode} from ${currentUrl}`));
        }

        // For .tgz files (macOS), we'd need to extract — for now pipe directly
        // This works for Linux binaries; macOS .tgz handling is simplified
        const isTgz = currentUrl.endsWith('.tgz');
        if (isTgz) {
          // Extract tar.gz inline using built-in zlib
          const zlib = require('zlib');
          const tar = require('tar');
          res.pipe(zlib.createGunzip()).pipe(
            tar.extract({ cwd: path.dirname(dest), filter: (p) => p === 'cloudflared' })
          ).on('finish', resolve).on('error', reject);
        } else {
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
          req.on('error', reject);
        }
      });
      req.on('error', reject);
    }
    followRedirect(url);
  });
}

/**
 * Start a Cloudflare Tunnel in headless mode using a token.
 * Returns the public URL once the tunnel is established.
 *
 * @param {object} opts
 * @param {string} opts.tunnelToken - Cloudflare Tunnel token
 * @param {string} opts.cloudflaredBin - path to cloudflared binary
 * @param {number} opts.port - local port to forward traffic to
 * @param {function} [opts.log] - logging function
 * @returns {Promise<{ url: string, process: ChildProcess }>}
 */
async function startTunnelHeadless({ tunnelToken, cloudflaredBin, port, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const args = [
      'tunnel',
      '--no-autoupdate',
      'run',
      '--token', tunnelToken,
    ];

    log('Starting Cloudflare Tunnel (headless)...');
    const proc = spawn(cloudflaredBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let resolved = false;

    function tryExtractUrl(text) {
      // cloudflared outputs the tunnel URL in logs
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (!match) {
        const cfMatch = text.match(/https:\/\/[a-z0-9-]+\.cfargotunnel\.com/);
        return cfMatch ? cfMatch[0] : null;
      }
      return match[0];
    }

    proc.stdout.on('data', (d) => {
      output += d.toString();
      const url = tryExtractUrl(output);
      if (url && !resolved) {
        resolved = true;
        resolve({ url, process: proc });
      }
    });

    proc.stderr.on('data', (d) => {
      output += d.toString();
      const url = tryExtractUrl(output);
      if (url && !resolved) {
        resolved = true;
        resolve({ url, process: proc });
      }
    });

    proc.on('error', reject);

    proc.on('exit', (code) => {
      if (!resolved) {
        reject(new Error(`cloudflared exited with code ${code}. Output: ${output}`));
      }
    });

    // Timeout after 60 seconds
    setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error('Timeout waiting for Cloudflare Tunnel URL'));
      }
    }, 60000);
  });
}

/**
 * Start an interactive Cloudflare Tunnel (opens browser for auth).
 * For use during interactive `myr setup`.
 *
 * @param {object} opts
 * @param {string} opts.cloudflaredBin
 * @param {number} opts.port
 * @param {function} [opts.log]
 * @returns {Promise<{ url: string, process: ChildProcess }>}
 */
async function startTunnelInteractive({ cloudflaredBin, port, log = () => {} }) {
  return new Promise((resolve, reject) => {
    log('Starting Cloudflare Tunnel (browser auth required)...');
    log('A browser window will open. Authenticate with Cloudflare to continue.');

    // First run tunnel --hello-world to get a quick URL, or use service mode
    // For interactive setup, use `cloudflared tunnel --url localhost:PORT`
    const args = [
      'tunnel',
      '--no-autoupdate',
      '--url', `http://localhost:${port}`,
    ];

    const proc = spawn(cloudflaredBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let resolved = false;

    function tryExtractUrl(text) {
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) return match[0];
      const cfMatch = text.match(/https:\/\/[a-z0-9-]+\.cfargotunnel\.com/);
      return cfMatch ? cfMatch[0] : null;
    }

    proc.stdout.on('data', (d) => {
      const text = d.toString();
      output += text;
      process.stdout.write(text); // forward to user
      const url = tryExtractUrl(output);
      if (url && !resolved) {
        resolved = true;
        resolve({ url, process: proc });
      }
    });

    proc.stderr.on('data', (d) => {
      const text = d.toString();
      output += text;
      process.stderr.write(text);
      const url = tryExtractUrl(output);
      if (url && !resolved) {
        resolved = true;
        resolve({ url, process: proc });
      }
    });

    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (!resolved) {
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });

    setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error('Timeout waiting for Cloudflare Tunnel URL (120s)'));
      }
    }, 120000);
  });
}

/**
 * Verify that a URL is reachable from an external network by fetching
 * /.well-known/myr-node. Uses a plain HTTPS/HTTP request (non-local).
 *
 * @param {string} nodeUrl - base URL to check
 * @param {object} [opts]
 * @param {function} [opts.fetch] - injectable HTTP fetch for testing
 * @returns {Promise<void>} resolves on success, throws with actionable error on failure
 */
async function verifyExternalUrl(nodeUrl, { fetch: fetchFn } = {}) {
  const url = nodeUrl.replace(/\/$/, '') + '/.well-known/myr-node';

  const doFetch = fetchFn || function defaultFetch(u) {
    return new Promise((resolve, reject) => {
      const mod = u.startsWith('https:') ? https : http;
      const req = mod.get(u, { timeout: 15000 }, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out after 15s`));
      });
    });
  };

  let res;
  try {
    res = await doFetch(url);
  } catch (err) {
    throw new Error(
      `External URL verification failed: cannot reach ${url}\n` +
      `  Cause: ${err.message}\n` +
      `  Check that your node server is running and the URL is publicly reachable.\n` +
      `  If using Cloudflare Tunnel, ensure cloudflared is running.`
    );
  }

  if (res.status !== 200) {
    throw new Error(
      `External URL verification failed: ${url} returned HTTP ${res.status}\n` +
      `  Expected 200 with node identity. Check your server is running correctly.`
    );
  }

  if (!res.body || !res.body.public_key) {
    throw new Error(
      `External URL verification failed: ${url} returned unexpected response.\n` +
      `  Expected node identity JSON with public_key field.`
    );
  }
}

/**
 * Main setup flow.
 *
 * @param {object} opts
 * @param {string} [opts.operatorName] - operator name (skips prompt if set)
 * @param {string} [opts.publicUrl] - skip tunnel, use this URL directly
 * @param {string} [opts.tunnelToken] - headless Cloudflare auth token (also reads CLOUDFLARE_TUNNEL_TOKEN env)
 * @param {number} [opts.port] - server port (default 3719)
 * @param {function} [opts.log] - logging function (default console.log)
 * @param {function} [opts.prompt] - async function(question) => string, for interactive input
 * @param {function} [opts.verifyFetch] - injectable fetch for URL verification (testing)
 * @returns {Promise<{ config: object, keypair: object, nodeUrl: string }>}
 */
async function runSetup({
  operatorName,
  publicUrl,
  tunnelToken,
  port = 3719,
  log = console.log,
  prompt,
  verifyFetch,
} = {}) {
  // Resolve tunnel token from env if not provided
  const resolvedTunnelToken = tunnelToken || process.env.CLOUDFLARE_TUNNEL_TOKEN;

  // If no operator name given and no prompt function, use a default
  let resolvedOperatorName = operatorName;
  if (!resolvedOperatorName) {
    if (prompt) {
      resolvedOperatorName = await prompt('Enter operator name: ');
    } else {
      resolvedOperatorName = os.hostname().split('.')[0] || 'operator';
    }
  }

  // Generate keypair
  log('Generating Ed25519 keypair...');
  const keypair = generateKeypair();
  saveKeypair(keypair);
  log(`✓ Keypair saved to ${path.join(getKeysDir(), 'node.key')}`);

  // Determine node URL
  let nodeUrl;
  let tunnelProcess = null;

  if (publicUrl) {
    // Skip tunnel provisioning — use provided URL
    nodeUrl = publicUrl.replace(/\/$/, '');
    log(`✓ Using provided public URL: ${nodeUrl}`);
  } else if (resolvedTunnelToken) {
    // Headless tunnel via token
    if (!isCloudflaredInstalled()) {
      await downloadCloudflared({ log });
    }
    const cloudflaredBin = getCloudflaredBinPath();
    const result = await startTunnelHeadless({ tunnelToken: resolvedTunnelToken, cloudflaredBin, port, log });
    nodeUrl = result.url;
    tunnelProcess = result.process;
    log(`✓ Cloudflare Tunnel established: ${nodeUrl}`);
  } else {
    // Interactive tunnel (browser auth)
    if (!isCloudflaredInstalled()) {
      await downloadCloudflared({ log });
    }
    const cloudflaredBin = getCloudflaredBinPath();
    const result = await startTunnelInteractive({ cloudflaredBin, port, log });
    nodeUrl = result.url;
    tunnelProcess = result.process;
    log(`✓ Cloudflare Tunnel established: ${nodeUrl}`);
  }

  // Build and save config
  const config = {
    protocol_version: '1.0.0',
    node_url: nodeUrl,
    port,
    operator_name: resolvedOperatorName,
    keypair_path: path.join(getKeysDir(), 'node.key'),
    db_path: getDbPath(),
    auto_sync_interval: '1h',
    min_sync_interval: '15m',
    tunnel: resolvedTunnelToken ? {
      provider: 'cloudflare',
      token_env: 'CLOUDFLARE_TUNNEL_TOKEN',
    } : null,
    rate_limit: { requests_per_minute: 60 },
    discovery: { dht_enabled: false },
  };

  saveNodeConfig(config);
  log(`✓ Config saved to ${path.join(getMyrDir(), 'config.json')}`);

  // Verify external reachability — start server first, then check
  // Note: caller is responsible for starting the server; we just verify
  log(`Verifying external URL reachability: ${nodeUrl}...`);
  await verifyExternalUrl(nodeUrl, { fetch: verifyFetch });
  log(`✓ Public URL verified reachable`);

  return { config, keypair, nodeUrl, tunnelProcess };
}

module.exports = {
  getCloudflaredBinPath,
  isCloudflaredInstalled,
  downloadCloudflared,
  startTunnelHeadless,
  startTunnelInteractive,
  verifyExternalUrl,
  runSetup,
};
