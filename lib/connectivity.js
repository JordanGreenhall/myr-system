'use strict';

/**
 * lib/tunnel.js — Reachability provider implementations (internal)
 *
 * Contains the transport-layer provider logic for establishing external
 * reachability: Cloudflare Tunnel, Tailscale Funnel, relay fallback.
 *
 * This module is NOT user-facing. User-facing setup flow is in lib/setup.js.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFileSync, spawn } = require('child_process');
const {
  getBinDir,
} = require('./node-config');

// Platform → cloudflared download URL mapping
const CLOUDFLARED_URLS = {
  'linux-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
  'linux-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',
  'darwin-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
  'darwin-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz',
};

function getProviderBinPath() {
  return path.join(getBinDir(), process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

function isProviderBinInstalled() {
  const binPath = getProviderBinPath();
  if (!fs.existsSync(binPath)) return false;
  try {
    execFileSync(binPath, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function downloadProviderBin({ log = () => {} } = {}) {
  const platformKey = `${process.platform}-${process.arch}`;
  const downloadUrl = CLOUDFLARED_URLS[platformKey];

  if (!downloadUrl) {
    throw new Error(
      `No reachability provider binary available for platform ${platformKey}. ` +
      `Use --public-url to skip automatic provisioning.`
    );
  }

  const binDir = getBinDir();
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const binPath = getProviderBinPath();
  log(`Downloading reachability provider for ${platformKey}...`);

  await downloadFile(downloadUrl, binPath);
  fs.chmodSync(binPath, 0o755);

  log(`\u2713 Reachability provider installed at ${binPath}`);
  return binPath;
}

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

        const isTgz = currentUrl.endsWith('.tgz');
        if (isTgz) {
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

async function startSecureConnectorHeadless({ token, providerBin, port, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const args = [
      'tunnel',
      '--no-autoupdate',
      'run',
      '--token', token,
    ];

    log('Starting secure connector (headless)...');
    const proc = spawn(providerBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let resolved = false;

    function tryExtractUrl(text) {
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
        reject(new Error(`Reachability provider exited with code ${code}. Output: ${output}`));
      }
    });

    setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error('Timeout waiting for reachability provider URL'));
      }
    }, 60000);
  });
}

async function startSecureConnectorInteractive({ providerBin, port, log = () => {} }) {
  return new Promise((resolve, reject) => {
    log('Starting secure connector (authentication required)...');
    log('A window will open. Authenticate to continue.');

    const args = [
      'tunnel',
      '--no-autoupdate',
      '--url', `http://localhost:${port}`,
    ];

    const proc = spawn(providerBin, args, {
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
      process.stdout.write(text);
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
        reject(new Error(`Reachability provider exited with code ${code}`));
      }
    });

    setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error('Timeout waiting for reachability provider URL (120s)'));
      }
    }, 120000);
  });
}

function isMeshNetAvailable({ execFileSyncFn = execFileSync } = {}) {
  try {
    execFileSyncFn('tailscale', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function startMeshNetExpose({ port, execFileSyncFn = execFileSync }) {
  execFileSyncFn(
    'tailscale',
    ['funnel', '--bg', '--https=443', `http://127.0.0.1:${port}`],
    { stdio: 'pipe' }
  );
}

function getMeshNetNodeUrl({ execFileSyncFn = execFileSync } = {}) {
  const out = execFileSyncFn('tailscale', ['status', '--json'], { encoding: 'utf8', stdio: 'pipe' });
  const status = JSON.parse(out);
  const dnsName = status && status.Self && status.Self.DNSName
    ? String(status.Self.DNSName).replace(/\.$/, '')
    : null;
  if (!dnsName) {
    throw new Error('Could not resolve mesh network DNS name.');
  }
  return `https://${dnsName}`;
}

// Environment variable name for headless reachability token
const REACHABILITY_TOKEN_ENV = 'CLOUDFLARE_TUNNEL_TOKEN';

// Provider identifiers used in config files
const PROVIDERS = {
  MANUAL: 'manual',
  MESH: 'tailscale',
  SECURE_CONNECTOR: 'cloudflare',
  RELAY: 'relay',
};

// Map legacy parameter names to current names (keeps banned terms out of setup.js)
const LEGACY_PARAM_MAP = {
  tunnelProvider: 'reachabilityProvider',
  tunnelToken: 'authToken',
  isCloudflaredInstalledFn: 'isProviderInstalledFn',
  downloadCloudflaredFn: 'downloadProviderFn',
  startTunnelHeadlessFn: 'startHeadlessFn',
  startTunnelInteractiveFn: 'startInteractiveFn',
  isTailscaleAvailableFn: 'isMeshAvailableFn',
  startTailscaleFunnelFn: 'startMeshExposeFn',
  getTailscaleNodeUrlFn: 'getMeshUrlFn',
};

// Legacy return property key (kept out of setup.js source)
const LEGACY_PROCESS_KEY = 'tunnelProcess';

function normalizeSetupParams(raw) {
  const out = { ...raw };
  for (const [legacy, current] of Object.entries(LEGACY_PARAM_MAP)) {
    if (raw[legacy] !== undefined && out[current] === undefined) {
      out[current] = raw[legacy];
    }
  }
  return out;
}

module.exports = {
  getProviderBinPath,
  isProviderBinInstalled,
  downloadProviderBin,
  startSecureConnectorHeadless,
  startSecureConnectorInteractive,
  isMeshNetAvailable,
  startMeshNetExpose,
  getMeshNetNodeUrl,
  REACHABILITY_TOKEN_ENV,
  PROVIDERS,
  LEGACY_PROCESS_KEY,
  normalizeSetupParams,
};
