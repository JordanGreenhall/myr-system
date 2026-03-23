'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Returns the MYR home directory: ~/.myr (resolved via os.homedir())
 * Override with MYR_HOME env var.
 */
function getMyrDir() {
  return process.env.MYR_HOME || path.join(os.homedir(), '.myr');
}

/**
 * Returns the config file path: ~/.myr/config.json
 * Override with MYR_CONFIG env var.
 */
function getConfigPath() {
  return process.env.MYR_CONFIG || path.join(getMyrDir(), 'config.json');
}

/**
 * Returns the keys directory: ~/.myr/keys/
 */
function getKeysDir() {
  return path.join(getMyrDir(), 'keys');
}

/**
 * Returns the node keypair path: ~/.myr/keys/node.key
 */
function getNodeKeyPath() {
  return path.join(getKeysDir(), 'node.key');
}

/**
 * Returns the DB path: ~/.myr/myr.db
 */
function getDbPath() {
  return path.join(getMyrDir(), 'myr.db');
}

/**
 * Returns the bin directory for auto-downloaded binaries: ~/.myr/bin/
 */
function getBinDir() {
  return path.join(getMyrDir(), 'bin');
}

/**
 * Resolve a path that may start with ~ to an absolute path via os.homedir().
 * Never uses hard-coded usernames or paths.
 */
function resolvePath(p) {
  if (!p) return p;
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Load the node config from ~/.myr/config.json.
 * Returns null if not found or malformed.
 */
function loadNodeConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Save the node config to ~/.myr/config.json.
 * Creates the directory if needed.
 */
function saveNodeConfig(config) {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Load the keypair from ~/.myr/keys/node.key.
 * Returns { publicKey, privateKey } (hex strings) or null.
 */
function loadKeypair() {
  const keyPath = getNodeKeyPath();
  if (!fs.existsSync(keyPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Save the keypair to ~/.myr/keys/node.key.
 * Sets file permissions to 0600 (owner read/write only).
 */
function saveKeypair(keypair) {
  const keyPath = getNodeKeyPath();
  const dir = path.dirname(keyPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(keyPath, JSON.stringify(keypair, null, 2), { encoding: 'utf8', mode: 0o600 });
}

module.exports = {
  getMyrDir,
  getConfigPath,
  getKeysDir,
  getNodeKeyPath,
  getDbPath,
  getBinDir,
  resolvePath,
  loadNodeConfig,
  saveNodeConfig,
  loadKeypair,
  saveKeypair,
};
