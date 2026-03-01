'use strict';

const { program } = require('commander');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { validateConfig } = require('./config');
const { getDb } = require('./db');

program
  .name('myr-export')
  .description('Export verified MYRs as signed artifact JSON')
  .option('--all', 'Export all verified MYRs (rating >= 3)')
  .option('--since <date>', 'Export MYRs since YYYY-MM-DD')
  .option('--ids <ids>', 'Comma-separated list of MYR IDs to export');

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

function sortKeysDeep(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeysDeep(obj[key]);
  }
  return sorted;
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

function signPayload(payload, privateKeyPem, publicKeyPem) {
  const canonical = JSON.stringify(payload);
  const sig = crypto.sign(null, Buffer.from(canonical), privateKeyPem);
  const pubKeyDer = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });

  return {
    version: '1',
    artifact_type: 'myr',
    payload,
    signature: {
      algorithm: 'Ed25519',
      node_id: config.node_id,
      node_uuid: config.node_uuid || null,
      public_key: pubKeyDer.toString('base64'),
      signed_at: new Date().toISOString(),
      value: sig.toString('base64'),
    },
  };
}

function main() {
  validateConfig();

  if (!opts.all && !opts.since && !opts.ids) {
    console.error('Provide --all, --since <date>, or --ids "id1,id2"');
    process.exit(1);
  }

  const db = getDb();
  let rows;

  if (opts.ids) {
    const ids = opts.ids.split(',').map(s => s.trim());
    const placeholders = ids.map(() => '?').join(',');
    rows = db.prepare(
      `SELECT * FROM myr_reports WHERE id IN (${placeholders}) AND (imported_from IS NULL OR imported_from = '')`
    ).all(...ids);
  } else if (opts.since) {
    const since = new Date(opts.since + 'T00:00:00Z').toISOString();
    rows = db.prepare(
      "SELECT * FROM myr_reports WHERE jordan_rating >= 3 AND created_at >= ? AND (imported_from IS NULL OR imported_from = '')"
    ).all(since);
  } else {
    rows = db.prepare(
      "SELECT * FROM myr_reports WHERE jordan_rating >= 3 AND (imported_from IS NULL OR imported_from = '')"
    ).all();
  }

  if (rows.length === 0) {
    console.log('No exportable MYRs found (must have jordan_rating >= 3).');
    db.close();
    return;
  }

  const privateKeyPem = loadPrivateKey();
  const publicKeyPem = loadPublicKey();
  const artifacts = [];

  for (const row of rows) {
    let artifact;
    if (row.signed_artifact) {
      artifact = JSON.parse(row.signed_artifact);
    } else {
      artifact = signPayload(rowToPayload(row), privateKeyPem, publicKeyPem);
      db.prepare(
        'UPDATE myr_reports SET signed_artifact = ?, signed_by = ?, updated_at = ? WHERE id = ?'
      ).run(JSON.stringify(artifact), config.node_id, new Date().toISOString(), row.id);
    }
    artifacts.push(artifact);
  }

  if (!fs.existsSync(config.export_path)) {
    fs.mkdirSync(config.export_path, { recursive: true });
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const filename = `${ts}-${config.node_id}.myr.json`;
  const outPath = path.join(config.export_path, filename);

  fs.writeFileSync(outPath, JSON.stringify(artifacts, null, 2), 'utf8');
  db.close();

  console.log(`Exported ${artifacts.length} MYR(s) to ${outPath}`);
}

main();
