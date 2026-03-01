'use strict';

const { program } = require('commander');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { validateConfig } = require('./config');

program
  .name('myr-keygen')
  .description('Generate Ed25519 keypair for this MYR node')
  .option('--force', 'Overwrite existing keypair');

program.parse();
const opts = program.opts();

function main() {
  const keysDir = config.keys_path;
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true });
  }

  const privateKeyPath = path.join(keysDir, `${config.node_id}.private.pem`);
  const publicKeyPath = path.join(keysDir, `${config.node_id}.public.pem`);

  if (fs.existsSync(privateKeyPath) && !opts.force) {
    console.error(`Keypair already exists at ${privateKeyPath}`);
    console.error('Use --force to overwrite.');
    process.exit(1);
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.writeFileSync(privateKeyPath, privateKey, 'utf8');
  fs.writeFileSync(publicKeyPath, publicKey, 'utf8');

  // Write node_uuid to config.json if not already present
  const configPath = require('path').join(__dirname, '..', 'config.json');
  let configJson = {};
  if (fs.existsSync(configPath)) {
    try { configJson = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
  }
  if (!configJson.node_uuid) {
    configJson.node_uuid = crypto.randomUUID();
    fs.writeFileSync(configPath, JSON.stringify(configJson, null, 2), 'utf8');
    console.log(`  UUID:    ${configJson.node_uuid}`);
  } else {
    console.log(`  UUID:    ${configJson.node_uuid} (existing)`);
  }

  console.log(`Keypair generated for node "${config.node_id}"`);
  console.log(`  Private: ${privateKeyPath}`);
  console.log(`  Public:  ${publicKeyPath}`);
  console.log('');
  console.log('--- PUBLIC KEY (share with peers) ---');
  console.log(publicKey.trim());
}

main();
