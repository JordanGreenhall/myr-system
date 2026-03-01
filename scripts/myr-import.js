'use strict';

const { program } = require('commander');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { validateConfig } = require('./config');
const { getDb } = require('./db');

program
  .name('myr-import')
  .description('Verify and import signed MYR artifacts from a peer node')
  .option('--file <path>', 'Path to .myr.json export file')
  .option('--peer-key <path>', "Path to peer's public key PEM file");

program.parse();
const opts = program.opts();

function verifyArtifact(artifact, publicKeyPem) {
  if (!artifact || artifact.version !== '1' || artifact.artifact_type !== 'myr') {
    return { valid: false, reason: 'invalid artifact structure' };
  }

  if (!artifact.payload || !artifact.signature) {
    return { valid: false, reason: 'missing payload or signature' };
  }

  const sig = artifact.signature;
  if (sig.algorithm !== 'Ed25519' || !sig.value || !sig.node_id) {
    return { valid: false, reason: 'invalid signature metadata' };
  }

  try {
    const payload = sortKeysDeep(artifact.payload);
    const canonical = JSON.stringify(payload);
    const pubKey = crypto.createPublicKey(publicKeyPem);
    const valid = crypto.verify(null, Buffer.from(canonical), pubKey, Buffer.from(sig.value, 'base64'));
    if (!valid) return { valid: false, reason: 'Ed25519 signature verification failed' };
  } catch (err) {
    return { valid: false, reason: `signature check error: ${err.message}` };
  }

  return { valid: true };
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

function resolvePeerKey(db, artifact) {
  if (opts.peerKey) {
    return fs.readFileSync(opts.peerKey, 'utf8');
  }

  const nodeId = artifact.signature?.node_id;
  if (!nodeId) return null;

  const peer = db.prepare('SELECT public_key FROM myr_peers WHERE node_id = ?').get(nodeId);
  if (peer) return peer.public_key;

  // Try keys directory
  const keyPath = path.join(config.keys_path, `${nodeId}.public.pem`);
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath, 'utf8');

  return null;
}

function registerPeer(db, nodeId, publicKeyPem) {
  const existing = db.prepare('SELECT node_id, public_key FROM myr_peers WHERE node_id = ?').get(nodeId);
  if (existing) {
    // Key binding check: registered node_id must match known public key
    if (existing.public_key && existing.public_key.trim() !== publicKeyPem.trim()) {
      console.error(`\nKEY BINDING MISMATCH: node_id \${nodeId}\ is registered with a different public key.`);
      console.error('This may indicate key rotation or an impersonation attempt.');
      console.error('Resolve manually before importing from this node.');
      console.error('  - If legitimate key rotation: delete peer record from DB and re-import with --peer-key');
      process.exit(3);
    }
    db.prepare('UPDATE myr_peers SET last_import_at = ? WHERE node_id = ?')
      .run(new Date().toISOString(), nodeId);
    return;
  }

  db.prepare(`
    INSERT INTO myr_peers (node_id, node_name, public_key, public_key_format, added_at, last_import_at, myr_count)
    VALUES (?, ?, ?, 'pem', ?, ?, 0)
  `).run(nodeId, '', publicKeyPem, new Date().toISOString(), new Date().toISOString());
}


function preflight(artifacts, localConfig) {
  const peerIds = new Set(artifacts.map(a => a.signature?.node_id).filter(Boolean));
  const peerUuids = new Set(artifacts.map(a => a.signature?.node_uuid).filter(Boolean));

  for (const peerId of peerIds) {
    if (peerId === localConfig.node_id) {
      // Check if node_uuid also matches — definitive self-origin vs label collision
      const localUuid = localConfig.node_uuid;
      const hasPeerUuid = peerUuids.size > 0;
      if (localUuid && hasPeerUuid && peerUuids.has(localUuid)) {
        console.error(`\nPREFLIGHT FAILED: This package was exported from this node.`);
        console.error(`  node_id: ${peerId} | node_uuid: ${localUuid}`);
        console.error(`  You cannot import your own artifacts.`);
      } else {
        console.error(`\nPREFLIGHT FAILED: Peer node_id \${peerId}\ matches your local node_id.`);
        console.error(`  This is a label collision — two different nodes using the same node_id.`);
        console.error(`\nRemediation:`);
        console.error(`  1. Ask peer to set a unique node_id in their config.json and re-export.`);
        console.error(`  2. Emergency override: MYR_NODE_ID=mynode node scripts/myr-import.js --file ...`);
        console.error(`     (override mode: verify peer key fingerprint manually before trusting)`);
      }
      process.exit(2);
    }
  }
}

function main() {
  validateConfig();

  if (!opts.file) {
    program.help();
    return;
  }

  if (!fs.existsSync(opts.file)) {
    console.error(`File not found: ${opts.file}`);
    process.exit(1);
  }

  let artifacts;
  try {
    const raw = fs.readFileSync(opts.file, 'utf8');
    artifacts = JSON.parse(raw);
    if (!Array.isArray(artifacts)) artifacts = [artifacts];
  } catch (err) {
    console.error(`Failed to parse ${opts.file}: ${err.message}`);
    process.exit(1);
  }

  preflight(artifacts, config);

  const db = getDb();
  const counts = { accepted: 0, rejected: 0, skipped: 0 };
  const reasons = [];

  for (const artifact of artifacts) {
    const id = artifact.payload?.id;
    const peerNodeId = artifact.signature?.node_id;

    if (!id) {
      counts.rejected++;
      reasons.push(`[unknown] missing payload.id`);
      continue;
    }

    if (peerNodeId === config.node_id) {
      // Preflight should have caught this, but guard here too
      counts.rejected++;
      reasons.push(`[${id}] rejected: node_id collision with local node (${config.node_id})`);
      continue;
    }

    const existing = db.prepare('SELECT id FROM myr_reports WHERE id = ?').get(id);
    if (existing) {
      counts.skipped++;
      reasons.push(`[${id}] duplicate — already exists`);
      continue;
    }

    const publicKeyPem = resolvePeerKey(db, artifact);
    if (!publicKeyPem) {
      counts.rejected++;
      reasons.push(`[${id}] no public key found for node ${peerNodeId} — use --peer-key`);
      continue;
    }

    const result = verifyArtifact(artifact, publicKeyPem);
    if (!result.valid) {
      counts.rejected++;
      reasons.push(`[${id}] ${result.reason}`);
      continue;
    }

    const p = artifact.payload;
    const cycle = p.cycle || {};
    const y = p.yield || {};
    const v = p.verification || {};
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO myr_reports (
        id, timestamp, agent_id, node_id, session_ref,
        cycle_intent, domain_tags, cycle_context,
        yield_type, question_answered, evidence, what_changes_next,
        what_was_falsified, transferable_to, confidence,
        jordan_rating, jordan_notes, verified_at,
        signed_by, shared_with, synthesis_id,
        imported_from, signed_artifact, import_verified,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, '[]', NULL,
        ?, ?, 1,
        ?, ?
      )
    `).run(
      p.id, p.timestamp, p.agent_id, p.node_id, p.session_ref || null,
      cycle.intent, JSON.stringify(cycle.domain_tags || []), cycle.context || null,
      y.type, y.question_answered, y.evidence, y.what_changes_next,
      y.what_was_falsified || null, JSON.stringify(y.transferable_to || []), y.confidence || 0.7,
      v.jordan_rating || null, v.jordan_notes || null, v.verified_at || null,
      peerNodeId,
      peerNodeId, JSON.stringify(artifact),
      now, now
    );

    registerPeer(db, peerNodeId, publicKeyPem);
    db.prepare('UPDATE myr_peers SET myr_count = myr_count + 1 WHERE node_id = ?').run(peerNodeId);

    counts.accepted++;
  }

  db.close();

  console.log(`\nImport summary:`);
  console.log(`  Accepted: ${counts.accepted}`);
  console.log(`  Rejected: ${counts.rejected}`);
  console.log(`  Skipped:  ${counts.skipped}`);
  if (reasons.length > 0) {
    console.log(`\nDetails:`);
    reasons.forEach(r => console.log(`  ${r}`));
  }
}

main();
