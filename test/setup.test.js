'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// --- Test helpers ---

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myr-test-'));
}

function cleanDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakeProcess() {
  return { killed: false, kill: () => {}, on: () => {}, stdout: { on: () => {} }, stderr: { on: () => {} } };
}

function mockCloudflared(captures) {
  return {
    ensureCloudflared: async (binDir) => {
      captures.binDir = binDir;
      return '/mock/cloudflared';
    },
    startTokenTunnel: (_path, token) => {
      captures.token = token;
      return { process: fakeProcess() };
    },
    startQuickTunnel: async (_path, port) => {
      captures.quickTunnelPort = port;
      return { url: 'https://mock-tunnel.trycloudflare.com', process: fakeProcess() };
    },
  };
}

// Clear module cache for home-config and setup before each test
function clearCaches() {
  delete require.cache[require.resolve('../lib/home-config')];
  delete require.cache[require.resolve('../lib/setup')];
}

// =============================================================================
// Config path resolution: ~ expands via os.homedir(), never hard-coded
// =============================================================================

describe('Config path resolution', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    process.env.MYR_HOME = tmpHome;
    clearCaches();
  });

  afterEach(() => {
    delete process.env.MYR_HOME;
    delete process.env.MYR_CONFIG;
    cleanDir(tmpHome);
  });

  it('resolves config path from MYR_HOME (never hard-coded)', () => {
    const { getConfigPath } = require('../lib/home-config');
    const configPath = getConfigPath();

    assert.ok(configPath.startsWith(tmpHome), `Config path ${configPath} should be under MYR_HOME ${tmpHome}`);
    assert.ok(configPath.endsWith('config.json'));
  });

  it('resolves default MYR_HOME via os.homedir() when MYR_HOME not set', () => {
    delete process.env.MYR_HOME;
    clearCaches();
    const { getMyrHome } = require('../lib/home-config');

    const myrHome = getMyrHome();
    // Must be path.join(os.homedir(), '.myr') — dynamically resolved, not hard-coded
    assert.equal(myrHome, path.join(os.homedir(), '.myr'),
      'MYR_HOME should resolve to $HOME/.myr via os.homedir()');
  });

  it('resolves keypair_path relative to MYR_HOME', () => {
    const { loadHomeConfig } = require('../lib/home-config');

    const config = loadHomeConfig();
    assert.ok(config.keypair_path.startsWith(tmpHome),
      `keypair_path ${config.keypair_path} should be under MYR_HOME ${tmpHome}`);
    assert.ok(config.keypair_path.includes('keys'));
  });

  it('resolves db_path relative to MYR_HOME', () => {
    const { loadHomeConfig } = require('../lib/home-config');

    const config = loadHomeConfig();
    assert.ok(config.db_path.startsWith(tmpHome),
      `db_path ${config.db_path} should be under MYR_HOME ${tmpHome}`);
    assert.ok(config.db_path.includes('data'));
  });

  it('overrides config path via MYR_CONFIG env var', () => {
    const customPath = path.join(tmpHome, 'custom', 'my-config.json');
    process.env.MYR_CONFIG = customPath;
    clearCaches();
    const { getConfigPath } = require('../lib/home-config');

    assert.equal(getConfigPath(), customPath);
  });

  it('saves and loads config without hard-coded paths', () => {
    const { loadHomeConfig, saveHomeConfig, ensureMyrDirs } = require('../lib/home-config');

    const config = loadHomeConfig();
    config.operator_name = 'test-operator';
    config.node_url = 'https://test.myr.network';
    ensureMyrDirs(config);
    saveHomeConfig(config);

    // Reload and verify
    clearCaches();
    const { loadHomeConfig: reload } = require('../lib/home-config');
    const loaded = reload();

    assert.equal(loaded.operator_name, 'test-operator');
    assert.equal(loaded.node_url, 'https://test.myr.network');

    // Verify the saved file doesn't contain internal fields
    const savedContent = fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8');
    assert.ok(!savedContent.includes('_myrHome'), 'Saved config should not contain _myrHome');
    assert.ok(!savedContent.includes('_configPath'), 'Saved config should not contain _configPath');
  });

  it('source code never contains hard-coded user paths', () => {
    // Verify that the home-config module source doesn't contain hard-coded paths
    const source = fs.readFileSync(require.resolve('../lib/home-config'), 'utf8');
    assert.ok(!source.includes('/Users/roberthall'), 'home-config.js must not contain hard-coded /Users/roberthall');
    assert.ok(!source.includes('/home/'), 'home-config.js must not contain hard-coded /home/ path');

    const setupSource = fs.readFileSync(require.resolve('../lib/setup'), 'utf8');
    assert.ok(!setupSource.includes('/Users/roberthall'), 'setup.js must not contain hard-coded /Users/roberthall');

    const cliSource = fs.readFileSync(require.resolve('../bin/myr-cli'), 'utf8');
    assert.ok(!cliSource.includes('/Users/roberthall'), 'myr-cli.js must not contain hard-coded /Users/roberthall');
  });
});

// =============================================================================
// --public-url flag bypasses tunnel provisioning entirely
// =============================================================================

describe('--public-url bypasses tunnel provisioning', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    process.env.MYR_HOME = tmpHome;
    clearCaches();
  });

  afterEach(() => {
    delete process.env.MYR_HOME;
    cleanDir(tmpHome);
  });

  it('uses provided public URL and does not call cloudflared', async () => {
    const { runSetup } = require('../lib/setup');

    const captures = {};
    const cf = mockCloudflared(captures);

    const result = await runSetup({
      operatorName: 'test-operator',
      publicUrl: 'https://mynode.example.com',
      fetchFn: async () => ({ status: 200, body: { public_key: 'abc123' } }),
      cloudflared: cf,
    });

    assert.equal(result.nodeUrl, 'https://mynode.example.com');
    assert.equal(result.tunnelProvisioned, false, 'Tunnel should NOT be provisioned when --public-url is set');
    assert.equal(captures.binDir, undefined, 'cloudflared should NOT be called when --public-url is set');
    assert.equal(captures.token, undefined, 'startTokenTunnel should NOT be called');
    assert.equal(captures.quickTunnelPort, undefined, 'startQuickTunnel should NOT be called');
    assert.equal(result.operatorName, 'test-operator');
    assert.ok(result.keypairGenerated, 'Keypair should still be generated');
  });

  it('saves node_url from --public-url in config', async () => {
    const { runSetup } = require('../lib/setup');

    await runSetup({
      operatorName: 'url-test',
      publicUrl: 'https://direct.example.com',
      fetchFn: async () => ({ status: 200, body: { public_key: 'abc123' } }),
    });

    const savedConfig = JSON.parse(
      fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8')
    );
    assert.equal(savedConfig.node_url, 'https://direct.example.com');
  });

  it('still generates keypair when --public-url is set', async () => {
    const { runSetup } = require('../lib/setup');

    const result = await runSetup({
      operatorName: 'keypair-test',
      publicUrl: 'https://direct.example.com',
      fetchFn: async () => ({ status: 200, body: { public_key: 'abc123' } }),
    });

    assert.ok(result.keypairGenerated);
    assert.ok(result.fingerprint);
    assert.ok(result.publicKeyHex);
    assert.ok(fs.existsSync(result.keypairPath), 'Private key file should exist');
    assert.ok(fs.existsSync(result.keypairPath + '.pub'), 'Public key file should exist');
  });
});

// =============================================================================
// Cloudflare Tunnel provisioning: headless token path (env var)
// =============================================================================

describe('Cloudflare Tunnel headless token path', () => {
  let tmpHome, origToken;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    process.env.MYR_HOME = tmpHome;
    origToken = process.env.CLOUDFLARE_TUNNEL_TOKEN;
    clearCaches();
  });

  afterEach(() => {
    delete process.env.MYR_HOME;
    if (origToken !== undefined) {
      process.env.CLOUDFLARE_TUNNEL_TOKEN = origToken;
    } else {
      delete process.env.CLOUDFLARE_TUNNEL_TOKEN;
    }
    cleanDir(tmpHome);
  });

  it('uses CLOUDFLARE_TUNNEL_TOKEN env var for headless tunnel', async () => {
    const { runSetup } = require('../lib/setup');

    const captures = {};
    const cf = mockCloudflared(captures);

    process.env.CLOUDFLARE_TUNNEL_TOKEN = 'test-tunnel-token-abc123';

    const result = await runSetup({
      operatorName: 'headless-test',
      configOverrides: { node_url: 'https://headless.example.com' },
      cloudflared: cf,
    });

    assert.equal(captures.token, 'test-tunnel-token-abc123',
      'Should pass CLOUDFLARE_TUNNEL_TOKEN to startTokenTunnel');
    assert.ok(captures.binDir.includes(tmpHome),
      'cloudflared binary should be stored under MYR_HOME');
    assert.equal(result.tunnelProvisioned, true);
    assert.ok(result.keypairGenerated);
  });

  it('uses --tunnel-token flag over env var', async () => {
    const { runSetup } = require('../lib/setup');

    const captures = {};
    const cf = mockCloudflared(captures);

    process.env.CLOUDFLARE_TUNNEL_TOKEN = 'env-token';

    const result = await runSetup({
      operatorName: 'flag-test',
      tunnelToken: 'flag-token-override',
      configOverrides: { node_url: 'https://flag.example.com' },
      cloudflared: cf,
    });

    assert.equal(captures.token, 'flag-token-override',
      'Should prefer --tunnel-token flag over env var');
    assert.equal(result.tunnelProvisioned, true);
  });

  it('downloads cloudflared to MYR_HOME/bin (no hard-coded path)', async () => {
    const { runSetup } = require('../lib/setup');

    const captures = {};
    const cf = mockCloudflared(captures);

    process.env.CLOUDFLARE_TUNNEL_TOKEN = 'some-token';

    await runSetup({
      operatorName: 'bindir-test',
      configOverrides: { node_url: 'https://bindir.example.com' },
      cloudflared: cf,
    });

    assert.ok(captures.binDir, 'ensureCloudflared should have been called with a binDir');
    assert.equal(captures.binDir, path.join(tmpHome, 'bin'),
      'cloudflared should be downloaded to $MYR_HOME/bin/');
    assert.ok(!captures.binDir.includes('/Users/roberthall'),
      'cloudflared path must not contain hard-coded user path');
  });

  it('falls back to quick tunnel when no token provided', async () => {
    delete process.env.CLOUDFLARE_TUNNEL_TOKEN;
    const { runSetup } = require('../lib/setup');

    const captures = {};
    const cf = mockCloudflared(captures);

    const result = await runSetup({
      operatorName: 'quick-test',
      cloudflared: cf,
      fetchFn: async () => ({ status: 200, body: { public_key: 'abc' } }),
    });

    assert.ok(captures.quickTunnelPort, 'Should have called startQuickTunnel');
    assert.equal(captures.token, undefined, 'Should NOT have called startTokenTunnel');
    assert.equal(result.tunnelProvisioned, true);
    assert.equal(result.nodeUrl, 'https://mock-tunnel.trycloudflare.com');
  });
});

// =============================================================================
// Keypair generation (basic sanity)
// =============================================================================

describe('Keypair generation in setup', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    process.env.MYR_HOME = tmpHome;
    clearCaches();
  });

  afterEach(() => {
    delete process.env.MYR_HOME;
    cleanDir(tmpHome);
  });

  it('generates valid Ed25519 keypair stored at configured path', async () => {
    const { runSetup } = require('../lib/setup');

    const result = await runSetup({
      operatorName: 'keygen-test',
      publicUrl: 'https://keygen.example.com',
      fetchFn: async () => ({ status: 200, body: { public_key: 'test' } }),
    });

    assert.ok(result.keypairGenerated);
    assert.ok(result.publicKeyHex);
    assert.equal(result.publicKeyHex.length, 64, 'Public key should be 64 hex chars (32 bytes)');
    assert.ok(result.fingerprint);

    // Verify files exist
    assert.ok(fs.existsSync(result.keypairPath), 'Private key file should exist');
    assert.ok(fs.existsSync(result.keypairPath + '.pub'), 'Public key file should exist');

    // Verify key permissions (private key should be restrictive)
    const stats = fs.statSync(result.keypairPath);
    const mode = stats.mode & 0o777;
    assert.ok(mode <= 0o600, `Private key should have restrictive permissions, got ${mode.toString(8)}`);
  });

  it('does not regenerate keypair on second setup', async () => {
    const { runSetup } = require('../lib/setup');

    const fetchFn = async () => ({ status: 200, body: { public_key: 'test' } });

    const first = await runSetup({
      operatorName: 'no-regen-test',
      publicUrl: 'https://noregen.example.com',
      fetchFn,
    });

    clearCaches();
    const { runSetup: runSetup2 } = require('../lib/setup');

    const second = await runSetup2({
      operatorName: 'no-regen-test',
      publicUrl: 'https://noregen.example.com',
      fetchFn,
    });

    assert.equal(first.publicKeyHex, second.publicKeyHex, 'Public key should be same on second setup');
    assert.equal(second.keypairGenerated, false, 'Keypair should NOT be regenerated');
  });
});

// =============================================================================
// External URL verification
// =============================================================================

describe('External URL verification', () => {
  beforeEach(() => clearCaches());

  it('reports verification failure when URL is unreachable', async () => {
    const { verifyExternalUrl } = require('../lib/setup');

    const result = await verifyExternalUrl('https://unreachable.invalid', async () => {
      throw new Error('ENOTFOUND');
    });

    assert.equal(result.ok, false);
    assert.ok(result.error.includes('ENOTFOUND'));
  });

  it('reports verification success when node responds correctly', async () => {
    const { verifyExternalUrl } = require('../lib/setup');

    const result = await verifyExternalUrl('https://mynode.example.com', async () => ({
      status: 200,
      body: { public_key: 'abc123', operator_name: 'test' },
    }));

    assert.equal(result.ok, true);
  });
});
