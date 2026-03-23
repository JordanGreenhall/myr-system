'use strict';

/**
 * myr setup — interactive and headless node setup.
 *
 * Generates keypair, provisions connectivity (Cloudflare Tunnel or --public-url),
 * starts server, verifies external reachability, writes config.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const { loadHomeConfig, saveHomeConfig, ensureMyrDirs, getMyrHome } = require('./home-config');
const cloudflaredModule = require('./cloudflared');
const { httpFetch } = require('./sync');

/**
 * Generate an Ed25519 keypair and store as PEM files.
 * Returns { publicKeyHex, privateKeyHex, keypairPath }
 */
function generateKeypair(keypairPath) {
  const dir = path.dirname(keypairPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const privatePath = keypairPath;
  const publicPath = keypairPath + '.pub';

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.writeFileSync(privatePath, privateKey, { mode: 0o600 });
  fs.writeFileSync(publicPath, publicKey, { mode: 0o644 });

  // Extract raw hex keys
  const pubDer = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  const publicKeyHex = pubDer.slice(-32).toString('hex');

  const privDer = crypto.createPrivateKey(privateKey).export({ type: 'pkcs8', format: 'der' });
  const privateKeyHex = privDer.slice(-32).toString('hex');

  return { publicKeyHex, privateKeyHex, keypairPath: privatePath };
}

/**
 * Load existing keypair from PEM files.
 */
function loadKeypairFromPem(keypairPath) {
  const privatePath = keypairPath;
  const publicPath = keypairPath + '.pub';

  if (!fs.existsSync(privatePath) || !fs.existsSync(publicPath)) {
    return null;
  }

  const privPem = fs.readFileSync(privatePath, 'utf8');
  const pubPem = fs.readFileSync(publicPath, 'utf8');

  const pubDer = crypto.createPublicKey(pubPem).export({ type: 'spki', format: 'der' });
  const publicKeyHex = pubDer.slice(-32).toString('hex');

  const privDer = crypto.createPrivateKey(privPem).export({ type: 'pkcs8', format: 'der' });
  const privateKeyHex = privDer.slice(-32).toString('hex');

  return { publicKeyHex, privateKeyHex, keypairPath: privatePath };
}

/**
 * Compute fingerprint from hex public key (base64url of SHA-256).
 * Per spec: base64url(sha256(public_key_bytes))
 */
function computeFingerprint(publicKeyHex) {
  const hash = crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest();
  return hash.toString('base64url');
}

/**
 * Prompt user for input (interactive mode).
 */
function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Verify external reachability of the node URL.
 * Fetches /.well-known/myr-node and checks for valid response.
 */
async function verifyExternalUrl(nodeUrl, fetchFn) {
  fetchFn = fetchFn || httpFetch;
  const wellKnownUrl = nodeUrl.replace(/\/$/, '') + '/.well-known/myr-node';

  try {
    const res = await fetchFn(wellKnownUrl);
    if (res.status === 200 && res.body && res.body.public_key) {
      return { ok: true };
    }
    return {
      ok: false,
      error: `Got HTTP ${res.status} from ${wellKnownUrl}. Expected 200 with node identity.`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Cannot reach ${wellKnownUrl}: ${err.message}\n\nMake sure your node is accessible from the public internet.\nIf behind NAT, use 'myr setup' without --public-url to provision a Cloudflare Tunnel.`,
    };
  }
}

/**
 * Run myr setup.
 *
 * @param {Object} opts
 * @param {string} [opts.operatorName] - operator name (skip prompt if provided)
 * @param {string} [opts.publicUrl] - skip tunnel, use this URL
 * @param {string} [opts.tunnelToken] - headless Cloudflare auth token
 * @param {Function} [opts.fetchFn] - HTTP fetch function (for testing)
 * @param {Function} [opts.promptFn] - prompt function (for testing)
 * @param {Function} [opts.startServerFn] - server start function (for testing)
 * @param {Object} [opts.configOverrides] - override config values
 * @param {Object} [opts.cloudflared] - cloudflared module override (for testing)
 * @returns {Promise<Object>} setup result
 */
async function runSetup(opts = {}) {
  const config = loadHomeConfig();
  if (opts.configOverrides) {
    Object.assign(config, opts.configOverrides);
  }
  ensureMyrDirs(config);

  const promptFn = opts.promptFn || prompt;
  const fetchFn = opts.fetchFn || httpFetch;

  // Step 1: Operator name
  let operatorName = opts.operatorName || config.operator_name;
  if (!operatorName) {
    operatorName = await promptFn('Operator name: ');
    if (!operatorName) {
      throw new Error('Operator name is required. Use --operator-name <name> or enter interactively.');
    }
  }
  config.operator_name = operatorName;

  // Step 2: Generate keypair (or load existing)
  let keys = loadKeypairFromPem(config.keypair_path);
  let keypairGenerated = false;
  if (!keys) {
    keys = generateKeypair(config.keypair_path);
    keypairGenerated = true;
  }

  const fingerprint = computeFingerprint(keys.publicKeyHex);

  const results = {
    operatorName,
    fingerprint,
    publicKeyHex: keys.publicKeyHex,
    keypairPath: keys.keypairPath,
    keypairGenerated,
    tunnelProvisioned: false,
    nodeUrl: null,
    verified: false,
  };

  // Step 3: Connectivity
  const port = config.port || 3719;

  if (opts.publicUrl) {
    // --public-url path: no tunnel needed
    config.node_url = opts.publicUrl.replace(/\/$/, '');
    results.nodeUrl = config.node_url;
  } else {
    // Cloudflare Tunnel path
    const tunnelToken = opts.tunnelToken || process.env.CLOUDFLARE_TUNNEL_TOKEN;
    const binDir = path.join(config._myrHome, 'bin');

    const cf = opts.cloudflared || cloudflaredModule;
    const cloudflaredPath = await cf.ensureCloudflared(binDir);

    if (tunnelToken) {
      // Headless token path
      const tunnel = cf.startTokenTunnel(cloudflaredPath, tunnelToken);
      results.tunnelProcess = tunnel.process;
      results.tunnelProvisioned = true;
      // Token tunnels have pre-configured URLs — user must set node_url in config or via env
      if (!config.node_url) {
        console.log('Note: Token tunnel started. Set node_url in config or MYR_NODE_URL env var.');
      }
      results.nodeUrl = config.node_url;
    } else {
      // Interactive quick tunnel
      console.log('Provisioning Cloudflare Tunnel...');
      const tunnel = await cf.startQuickTunnel(cloudflaredPath, port);
      config.node_url = tunnel.url;
      results.nodeUrl = tunnel.url;
      results.tunnelProcess = tunnel.process;
      results.tunnelProvisioned = true;
    }
  }

  // Step 4: Start server (if a startServerFn is provided or in real mode)
  if (opts.startServerFn) {
    results.server = await opts.startServerFn(config, keys);
  }

  // Step 5: Verify external reachability (if we have a URL and it's not localhost)
  if (results.nodeUrl && !results.nodeUrl.includes('localhost') && !results.nodeUrl.includes('127.0.0.1')) {
    // Give tunnel/server a moment to come up
    await new Promise((r) => setTimeout(r, 2000));
    const verify = await verifyExternalUrl(results.nodeUrl, fetchFn);
    results.verified = verify.ok;
    if (!verify.ok) {
      results.verifyError = verify.error;
    }
  }

  // Step 6: Save config
  saveHomeConfig(config);
  results.configPath = config._configPath;

  return results;
}

module.exports = {
  runSetup,
  generateKeypair,
  loadKeypairFromPem,
  computeFingerprint,
  verifyExternalUrl,
  prompt,
};
