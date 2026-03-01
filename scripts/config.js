'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  node_id: 'n1',
  node_name: '',
  db_path: './db/myr.db',
  keys_path: './keys/',
  export_path: './exports/',
  import_path: './imports/',
  peers: [],
};

function loadConfig() {
  let fileConfig = {};
  const configPath = path.join(ROOT, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (_) {
      // ignore malformed config.json — fall through to defaults
    }
  }

  const config = { ...DEFAULTS, ...fileConfig };

  if (process.env.MYR_NODE_ID) config.node_id = process.env.MYR_NODE_ID;
  if (process.env.MYR_DB_PATH) config.db_path = process.env.MYR_DB_PATH;
  if (process.env.MYR_NODE_NAME) config.node_name = process.env.MYR_NODE_NAME;

  // Resolve relative paths against project root
  config.db_path = path.resolve(ROOT, config.db_path);
  config.keys_path = path.resolve(ROOT, config.keys_path);
  config.export_path = path.resolve(ROOT, config.export_path);
  config.import_path = path.resolve(ROOT, config.import_path);

  return config;
}

const config = loadConfig();

module.exports = config;
// HARDENING: Validate node identity before operating
function validateConfig(cfg) {
  cfg = cfg || config;
  if (cfg.node_id === 'n1' && !process.env.MYR_NODE_ID) {
    console.error('ERROR: node_id is still the default "n1".');
    console.error('Set a unique node_id in config.json before operating:');
    console.error('  { "node_id": "yourname-node", "node_name": "Your Name" }');
    console.error('Or set: MYR_NODE_ID=yourname-node node scripts/myr-export.js ...');
    console.error('Run `node scripts/myr-identity.js` to verify your identity.');
    process.exit(1);
  }
}

module.exports.validateConfig = validateConfig;
