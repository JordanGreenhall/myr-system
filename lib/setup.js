'use strict';

/**
 * lib/setup.js — MYR node setup logic
 *
 * Handles:
 * - Keypair generation and storage at ~/.myr/keys/node.key
 * - Automatic reachability provisioning (with provider cascade)
 * - External URL reachability verification
 * - Config writing to ~/.myr/config.json
 *
 * All paths resolved via os.homedir() — never hard-coded.
 */

const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { generateKeypair } = require('./crypto');
const { DEFAULT_BOOTSTRAP_RELAY_URL, probeRelay } = require('./reachability');
const {
  getMyrDir,
  getKeysDir,
  getDbPath,
  saveKeypair,
  saveNodeConfig,
} = require('./node-config');
const providers = require('./connectivity');

/**
 * Verify that a URL is reachable from an external network by fetching
 * /.well-known/myr-node.
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
        reject(new Error('Request timed out after 15s'));
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
      '  Check that your node server is running and the URL is publicly reachable.'
    );
  }

  if (res.status !== 200) {
    throw new Error(
      `External URL verification failed: ${url} returned HTTP ${res.status}\n` +
      '  Expected 200 with node identity. Check your server is running correctly.'
    );
  }

  if (!res.body || !res.body.public_key) {
    throw new Error(
      `External URL verification failed: ${url} returned unexpected response.\n` +
      '  Expected node identity JSON with public_key field.'
    );
  }
}

/**
 * Main setup flow.
 *
 * @param {object} rawOpts - setup options
 * @returns {Promise<{ config: object, keypair: object, nodeUrl: string }>}
 */
async function runSetup(rawOpts = {}) {
  const opts = providers.normalizeSetupParams(rawOpts);

  const {
    operatorName,
    port = 3719,
    log = console.log,
    prompt,
    verifyFetch,
    startServer,
    stopServer,
    env = process.env,
  } = opts;

  let publicUrl = opts.publicUrl;

  // Resolve provider override functions (for testing)
  const isProviderInstalledFn = opts.isProviderInstalledFn || providers.isProviderBinInstalled;
  const downloadProviderFn = opts.downloadProviderFn || providers.downloadProviderBin;
  const startHeadlessFn = opts.startHeadlessFn || providers.startSecureConnectorHeadless;
  const startInteractiveFn = opts.startInteractiveFn || providers.startSecureConnectorInteractive;
  const isMeshAvailableFn = opts.isMeshAvailableFn || providers.isMeshNetAvailable;
  const startMeshExposeFn = opts.startMeshExposeFn || providers.startMeshNetExpose;
  const getMeshUrlFn = opts.getMeshUrlFn || providers.getMeshNetNodeUrl;

  const providerOverride = opts.reachabilityProvider;
  const authToken = opts.authToken;

  // Resolve reachability token from env if not provided
  const resolvedToken = authToken || env[providers.REACHABILITY_TOKEN_ENV];
  const relayUrl = env.MYR_BOOTSTRAP_RELAY_URL || DEFAULT_BOOTSTRAP_RELAY_URL;
  const normalizedProvider = providerOverride ? String(providerOverride).trim().toLowerCase() : null;

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
  log(`\u2713 Keypair saved to ${path.join(getKeysDir(), 'node.key')}`);

  // Determine node URL
  let nodeUrl;
  let reachabilityProcess = null;
  let reachabilityConfig = null;
  let relayConfig = null;
  let skipExternalVerification = false;
  let selectedProvider = normalizedProvider || (publicUrl ? providers.PROVIDERS.MANUAL : 'auto');
  const autoMode = selectedProvider === 'auto';

  const P = providers.PROVIDERS;
  const providerAttempts = autoMode
    ? (publicUrl
        ? [P.MANUAL, P.MESH, P.SECURE_CONNECTOR, P.RELAY]
        : [P.MESH, P.SECURE_CONNECTOR, P.RELAY])
    : [selectedProvider];

  const attemptErrors = [];
  for (const provider of providerAttempts) {
    try {
      if (provider === P.MANUAL) {
        if (!publicUrl && prompt) {
          publicUrl = await prompt('Enter public URL (e.g. https://node.example.com): ');
        }
        if (!publicUrl) {
          throw new Error('Manual reachability selected but no public URL was provided.');
        }
        nodeUrl = publicUrl.replace(/\/$/, '');
        reachabilityConfig = { provider: P.MANUAL };
        log(`\u2713 Using provided public URL: ${nodeUrl}`);
      } else if (provider === P.MESH) {
        if (!isMeshAvailableFn()) {
          throw new Error('Mesh network provider is not installed or not available in PATH');
        }
        log('Starting mesh network exposure...');
        startMeshExposeFn({ port });
        nodeUrl = getMeshUrlFn();
        reachabilityConfig = { provider: P.MESH, mode: 'expose' };
        log(`\u2713 Mesh network exposure established: ${nodeUrl}`);
      } else if (provider === P.SECURE_CONNECTOR) {
        if (!isProviderInstalledFn()) {
          await downloadProviderFn({ log });
        }
        const providerBin = providers.getProviderBinPath();
        if (resolvedToken) {
          const result = await startHeadlessFn({ token: resolvedToken, providerBin, port, log });
          nodeUrl = result.url;
          reachabilityProcess = result.process;
          reachabilityConfig = {
            provider: P.SECURE_CONNECTOR,
            mode: 'token',
            token_env: providers.REACHABILITY_TOKEN_ENV,
          };
        } else {
          const result = await startInteractiveFn({ providerBin, port, log });
          nodeUrl = result.url;
          reachabilityProcess = result.process;
          reachabilityConfig = { provider: P.SECURE_CONNECTOR, mode: 'interactive' };
        }
        log(`\u2713 Secure connector established: ${nodeUrl}`);
      } else if (provider === P.RELAY) {
        nodeUrl = `http://127.0.0.1:${port}`;
        reachabilityConfig = { provider: P.RELAY, mode: autoMode ? 'bootstrap-auto' : 'bootstrap' };
        relayConfig = { enabled: true, url: relayUrl, fallback_only: true };
        skipExternalVerification = true;
        log(`Using relay-backed reachability: ${relayUrl}`);
      } else {
        const validProviders = Object.values(P).join(', ');
        throw new Error(
          `Unsupported reachability provider "${provider}". Use one of: auto, ${validProviders}.`
        );
      }
      selectedProvider = provider;
      break;
    } catch (err) {
      if (reachabilityProcess && provider === P.SECURE_CONNECTOR) {
        reachabilityProcess.kill();
        reachabilityProcess = null;
      }
      attemptErrors.push(`${provider}: ${err.message}`);
      if (!autoMode) {
        throw err;
      }
      log(`Reachability attempt "${provider}" failed: ${err.message}`);
      log('Trying next method...');
    }
  }

  if (!nodeUrl || !reachabilityConfig) {
    throw new Error(`Unable to establish reachability automatically. Attempts:\n- ${attemptErrors.join('\n- ')}`);
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
    reachability: reachabilityConfig,
    ...(relayConfig ? { relay: relayConfig } : {}),
    rate_limit: { requests_per_minute: 60 },
    discovery: { enabled: false },
  };

  saveNodeConfig(config);
  log(`\u2713 Config saved to ${path.join(getMyrDir(), 'config.json')}`);

  let serverHandle = null;
  try {
    if (startServer) {
      log(`Starting local server on port ${port} for verification...`);
      serverHandle = await startServer({ config, keypair, port, log });
      log('\u2713 Local server started');
    }

    if (skipExternalVerification) {
      log('Skipping direct external URL verification; using relay-backed reachability.');
      const relayProbe = await probeRelay({ relayUrl, fetchFn: verifyFetch });
      if (relayProbe.ok) {
        log(`\u2713 Relay reachable: ${relayUrl}`);
      } else {
        log(`! Relay probe failed: ${relayProbe.reason}`);
        log('  Node will start in degraded mode until relay becomes reachable.');
      }
    } else {
      log(`Verifying external URL reachability: ${nodeUrl}...`);
      await verifyExternalUrl(nodeUrl, { fetch: verifyFetch });
      log('\u2713 Public URL verified reachable');
    }

    return { config, keypair, nodeUrl, [providers.LEGACY_PROCESS_KEY]: reachabilityProcess };
  } finally {
    if (serverHandle) {
      if (stopServer) {
        await stopServer(serverHandle);
      } else if (serverHandle && typeof serverHandle.close === 'function') {
        await new Promise((resolve) => serverHandle.close(resolve));
      }
    }
  }
}

module.exports = {
  verifyExternalUrl,
  runSetup,
};
