'use strict';

const { program } = require('commander');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

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

  console.log(`Keypair generated for node "${config.node_id}"`);
  console.log(`  Private: ${privateKeyPath}`);
  console.log(`  Public:  ${publicKeyPath}`);
  console.log('');
  console.log('--- PUBLIC KEY (share with peers) ---');
  console.log(publicKey.trim());
}

main();
