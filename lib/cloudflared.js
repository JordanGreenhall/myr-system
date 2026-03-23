'use strict';

/**
 * Cloudflare Tunnel management for myr.
 *
 * Handles:
 * - Auto-downloading cloudflared binary to ~/.myr/bin/
 * - Starting/stopping tunnel as managed subprocess
 * - Headless token-based auth (CLOUDFLARE_TUNNEL_TOKEN or --tunnel-token)
 * - Interactive browser-based auth
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');
const https = require('https');
const http = require('http');

const CLOUDFLARED_VERSION = '2024.12.2';

function getPlatformBinary() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'darwin') {
    return arch === 'arm64'
      ? `cloudflared-darwin-arm64`
      : `cloudflared-darwin-amd64`;
  }
  if (platform === 'linux') {
    if (arch === 'arm64' || arch === 'aarch64') return `cloudflared-linux-arm64`;
    return `cloudflared-linux-amd64`;
  }

  throw new Error(`Unsupported platform: ${platform}/${arch}. Install cloudflared manually.`);
}

function getDownloadUrl() {
  const binary = getPlatformBinary();
  return `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${binary}`;
}

/**
 * Download a file from a URL to a local path.
 * Follows redirects (GitHub releases use them).
 */
function downloadFile(url, dest, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'myr-system' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadFile(res.headers.location, dest, maxRedirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Ensure cloudflared binary is available.
 * Returns the path to the binary.
 */
async function ensureCloudflared(binDir) {
  // Check if cloudflared is on PATH
  try {
    const which = execFileSync('which', ['cloudflared'], { encoding: 'utf8' }).trim();
    if (which) return which;
  } catch {
    // not on PATH
  }

  // Check local bin dir
  const localPath = path.join(binDir, 'cloudflared');
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  // Download
  console.log('Downloading cloudflared...');
  const url = getDownloadUrl();
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  await downloadFile(url, localPath);
  fs.chmodSync(localPath, 0o755);
  console.log(`cloudflared installed to ${localPath}`);
  return localPath;
}

/**
 * Start a Cloudflare Quick Tunnel (no account needed, generates random URL).
 * This is the interactive path — no token required.
 *
 * Returns: { url, process }
 */
function startQuickTunnel(cloudflaredPath, localPort) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cloudflaredPath, [
      'tunnel', '--url', `http://localhost:${localPort}`,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for tunnel URL (30s). Check cloudflared logs.'));
    }, 30000);

    function checkOutput(data) {
      output += data.toString();
      // cloudflared prints the URL to stderr
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timeout);
        resolve({ url: match[0], process: proc });
      }
    }

    proc.stdout.on('data', checkOutput);
    proc.stderr.on('data', checkOutput);
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && code !== null) {
        reject(new Error(`cloudflared exited with code ${code}\n${output}`));
      }
    });
  });
}

/**
 * Start a named Cloudflare Tunnel using a pre-configured token.
 * This is the headless path for VPS deployments.
 *
 * The token encodes the tunnel ID + credentials — cloudflared handles the rest.
 *
 * Returns: { process }
 */
function startTokenTunnel(cloudflaredPath, token) {
  const proc = spawn(cloudflaredPath, [
    'tunnel', 'run', '--token', token,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return { process: proc };
}

/**
 * Kill a tunnel process gracefully.
 */
function stopTunnel(tunnelProcess) {
  if (tunnelProcess && !tunnelProcess.killed) {
    tunnelProcess.kill('SIGTERM');
    setTimeout(() => {
      if (!tunnelProcess.killed) tunnelProcess.kill('SIGKILL');
    }, 5000);
  }
}

module.exports = {
  ensureCloudflared,
  startQuickTunnel,
  startTokenTunnel,
  stopTunnel,
  downloadFile,
  getPlatformBinary,
  getDownloadUrl,
};
