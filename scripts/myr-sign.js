'use strict';

const { program } = require('commander');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getDb } = require('./db');

program
  .name('myr-sign')
  .description('Sign MYR report(s) as Ed25519 artifacts')
  .option('--id <myr-id>', 'Sign a specific MYR by ID')
  .option('--all', 'Sign all unsigned local MYRs')
  .option('--out <path>', 'Write output to file (single-ID mode)');

program.parse();
const opts = program.opts();

function loadPrivateKey() {
  const keyPath = path.join(config.keys_path, `${config.node_id}.private.pem`);
  if (!fs.existsSync(keyPath)) {
    console.error(`Private key not found: ${keyPath}`);
    console.error('Run myr-keygen.js first.');
    process.exit(1);
  }
  return fs.readFileSync(keyPath, 'utf8');
}

function loadPublicKey() {
  const keyPath = path.join(config.keys_path, `${config.node_id}.public.pem`);
  if (!fs.existsSync(keyPath)) {
    console.error(`Public key not found: ${keyPath}`);
    process.exit(1);
  }
  return fs.readFileSync(keyPath, 'utf8');
}

function rowToPayload(row) {
  return sortKeysDeep({
    id: row.id,
    timestamp: row.timestamp,
    agent_id: row.agent_id,
    node_id: row.node_id,
    session_ref: row.session_ref || null,
    cycle: {
      intent: row.cycle_intent,
      domain_tags: JSON.parse(row.domain_tags || '[]'),
      context: row.cycle_context || null,
    },
    yield: {
      type: row.yield_type,
      question_answered: row.question_answered,
      evidence: row.evidence,
      what_changes_next: row.what_changes_next,
      what_was_falsified: row.what_was_falsified || null,
      transferable_to: JSON.parse(row.transferable_to || '[]'),
      confidence: row.confidence,
    },
    verification: {
      jordan_rating: row.jordan_rating,
      jordan_notes: row.jordan_notes || null,
      verified_at: row.verified_at || null,
    },
  });
}

function sortKeysDeep(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeysDeep(obj[key]);
  }
  return sorted;
}

function signPayload(payload, privateKeyPem, publicKeyPem) {
  const canonical = JSON.stringify(payload);
  const sign = crypto.sign(null, Buffer.from(canonical), privateKeyPem);

  const pubKeyDer = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });

  return {
    version: '1',
    artifact_type: 'myr',
    payload,
    signature: {
      algorithm: 'Ed25519',
      node_id: config.node_id,
      public_key: pubKeyDer.toString('base64'),
      signed_at: new Date().toISOString(),
      value: sign.toString('base64'),
    },
  };
}

function signRow(db, row, privateKeyPem, publicKeyPem) {
  const payload = rowToPayload(row);
  const artifact = signPayload(payload, privateKeyPem, publicKeyPem);
  const artifactJson = JSON.stringify(artifact);

  db.prepare(
    'UPDATE myr_reports SET signed_artifact = ?, signed_by = ?, updated_at = ? WHERE id = ?'
  ).run(artifactJson, config.node_id, new Date().toISOString(), row.id);

  return artifact;
}

function main() {
  if (!opts.id && !opts.all) {
    console.error('Provide --id <myr-id> or --all to sign MYRs.');
    process.exit(1);
  }

  const privateKeyPem = loadPrivateKey();
  const publicKeyPem = loadPublicKey();
  const db = getDb();

  if (opts.id) {
    const row = db.prepare('SELECT * FROM myr_reports WHERE id = ?').get(opts.id);
    if (!row) {
      console.error(`MYR not found: ${opts.id}`);
      db.close();
      process.exit(1);
    }
    const artifact = signRow(db, row, privateKeyPem, publicKeyPem);
    const output = JSON.stringify(artifact, null, 2);

    if (opts.out) {
      fs.writeFileSync(opts.out, output, 'utf8');
      console.log(`Signed artifact written to ${opts.out}`);
    } else {
      console.log(output);
    }
  } else {
    const rows = db.prepare(
      "SELECT * FROM myr_reports WHERE signed_artifact IS NULL AND (imported_from IS NULL OR imported_from = '')"
    ).all();

    if (rows.length === 0) {
      console.log('No unsigned local MYRs found.');
      db.close();
      return;
    }

    for (const row of rows) {
      signRow(db, row, privateKeyPem, publicKeyPem);
      console.log(`Signed: ${row.id}`);
    }
    console.log(`${rows.length} MYR(s) signed.`);
  }

  db.close();
}

main();
