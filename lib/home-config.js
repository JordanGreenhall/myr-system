'use strict';

/**
 * Home-directory based configuration for myr v1.0.
 *
 * Default data dir: ~/.myr/ (via os.homedir())
 * Override: MYR_HOME env var
 *
 * Config file: $MYR_HOME/config.json (or MYR_CONFIG env var)
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

function getMyrHome() {
  return process.env.MYR_HOME || path.join(os.homedir(), '.myr');
}

function getConfigPath() {
  return process.env.MYR_CONFIG || path.join(getMyrHome(), 'config.json');
}

const DEFAULTS = {
  operator_name: null,
  node_url: null,
  port: 3719,
  keypair_path: null, // resolved lazily to $MYR_HOME/keys/node.key
  db_path: null, // resolved lazily to $MYR_HOME/data/myr.db
  auto_sync_interval: '1h',
  min_sync_interval: '15m',
  tunnel: {
    provider: 'cloudflare',
    token_env: 'CLOUDFLARE_TUNNEL_TOKEN',
  },
  rate_limit: {
    requests_per_minute: 60,
  },
};

function loadHomeConfig() {
  const myrHome = getMyrHome();
  const configPath = getConfigPath();

  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      // ignore malformed config — fall through to defaults
    }
  }

  const config = { ...DEFAULTS, ...fileConfig };

  // Resolve paths relative to MYR_HOME
  if (!config.keypair_path) {
    config.keypair_path = path.join(myrHome, 'keys', 'node.key');
  } else if (!path.isAbsolute(config.keypair_path)) {
    config.keypair_path = path.join(myrHome, config.keypair_path);
  }

  if (!config.db_path) {
    config.db_path = path.join(myrHome, 'data', 'myr.db');
  } else if (!path.isAbsolute(config.db_path)) {
    config.db_path = path.join(myrHome, config.db_path);
  }

  // Env var overrides
  if (process.env.MYR_OPERATOR_NAME) config.operator_name = process.env.MYR_OPERATOR_NAME;
  if (process.env.MYR_NODE_URL) config.node_url = process.env.MYR_NODE_URL;
  if (process.env.MYR_PORT) config.port = parseInt(process.env.MYR_PORT, 10);

  config._myrHome = myrHome;
  config._configPath = configPath;

  return config;
}

function saveHomeConfig(config) {
  const configPath = config._configPath || getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Strip internal fields before saving
  const toSave = { ...config };
  delete toSave._myrHome;
  delete toSave._configPath;

  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2) + '\n', 'utf8');
}

function ensureMyrDirs(config) {
  const myrHome = config._myrHome || getMyrHome();
  const dirs = [
    myrHome,
    path.dirname(config.keypair_path),
    path.dirname(config.db_path),
    path.join(myrHome, 'bin'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

module.exports = {
  getMyrHome,
  getConfigPath,
  loadHomeConfig,
  saveHomeConfig,
  ensureMyrDirs,
};
