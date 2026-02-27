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
