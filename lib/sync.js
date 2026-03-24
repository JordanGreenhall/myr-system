'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { sign, verify, fingerprint: computeFingerprint } = require('./crypto');
const { canonicalize } = require('./canonicalize');
const { writeTrace } = require('./trace');

function makeSignedHeaders({ method, urlPath, body, privateKey, publicKey }) {
  const ts = new Date().toISOString();
  const nonce = crypto.randomBytes(32).toString('hex');
  const rawBody = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const canonical = `${method}\n${urlPath}\n${ts}\n${nonce}\n${bodyHash}`;
  const sig = sign(canonical, privateKey);
  return {
    'x-myr-timestamp': ts,
    'x-myr-nonce': nonce,
    'x-myr-signature': sig,
    'x-myr-public-key': publicKey,
  };
}

function httpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    if (options.body) reqOptions.headers['content-type'] = 'application/json';

    const req = mod.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), rawBody: data, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, body: data, rawBody: data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

/**
 * Sync reports from a single peer.
 * @param {Object} params
 * @param {Object} params.db - better-sqlite3 database instance
 * @param {Object} params.peer - peer row from myr_peers table
 * @param {Object} params.keys - { publicKey, privateKey } hex-encoded
 * @param {Function} [params.fetch] - optional HTTP fetch function (for testing)
 * @returns {Promise<{ imported: number, skipped: number, failed: number, peerNotTrusted?: boolean, peerName: string }>}
 */
async function syncPeer({ db, peer, keys, fetch: fetchFn }) {
  fetchFn = fetchFn || httpFetch;

  let reportsUrl = peer.peer_url + '/myr/reports?limit=500';
  if (peer.last_sync_at) {
    reportsUrl += `&since=${encodeURIComponent(peer.last_sync_at)}`;
  }

  const listHeaders = makeSignedHeaders({
    method: 'GET',
    urlPath: '/myr/reports',
    body: null,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });

  let listRes;
  try {
    listRes = await fetchFn(reportsUrl, { headers: listHeaders });
  } catch (err) {
    throw new Error(`Network error fetching report list from ${peer.operator_name}: ${err.message}`);
  }

  if (listRes.status === 403 && listRes.body?.error?.code === 'peer_not_trusted') {
    return { imported: 0, skipped: 0, failed: 0, peerNotTrusted: true, peerName: peer.operator_name };
  }
  if (listRes.status !== 200) {
    throw new Error(`Failed to fetch reports from ${peer.operator_name}: HTTP ${listRes.status}`);
  }

  const { reports } = listRes.body;
  let imported = 0, skipped = 0, failed = 0;

  for (const reportMeta of reports) {
    // Dedup by signature (signed_artifact column)
    try {
      const existsBySig = db.prepare(
        'SELECT id FROM myr_reports WHERE signed_artifact = ?'
      ).get(reportMeta.signature);
      if (existsBySig) {
        skipped++;
        continue;
      }
    } catch {
      // signed_artifact column may not exist in older schemas
    }

    const fetchPath = reportMeta.url.split('?')[0];
    const fetchHeaders = makeSignedHeaders({
      method: 'GET',
      urlPath: fetchPath,
      body: null,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });

    let reportRes;
    try {
      reportRes = await fetchFn(peer.peer_url + reportMeta.url, { headers: fetchHeaders });
    } catch (err) {
      console.error(`  Failed to fetch report ${reportMeta.signature}: ${err.message}`);
      failed++;
      continue;
    }

    if (reportRes.status !== 200) {
      failed++;
      continue;
    }

    const report = reportRes.body;

    // Verify SHA-256 hash
    const reportCopy = { ...report };
    delete reportCopy.signature;
    delete reportCopy.operator_signature;
    const canonical = canonicalize(reportCopy);
    const hash = crypto.createHash('sha256').update(canonical).digest('hex');
    const computedSig = 'sha256:' + hash;

    if (report.signature && report.signature !== computedSig) {
      console.error(`  SECURITY WARNING: Hash mismatch for report ${reportMeta.signature}`);
      writeTrace(db, {
        eventType: 'reject',
        actorFingerprint: computeFingerprint(keys.publicKey),
        targetFingerprint: computeFingerprint(peer.public_key),
        artifactSignature: reportMeta.signature,
        outcome: 'rejected',
        rejectionReason: 'hash_mismatch',
        metadata: { peer: peer.operator_name },
      });
      failed++;
      continue;
    }

    // Verify operator signature (body field per spec, or X-MYR-Signature header)
    const operatorSig = report.operator_signature ||
      (reportRes.headers && reportRes.headers['x-myr-signature']);

    if (operatorSig) {
      const msgToVerify = report.operator_signature ? canonical : reportRes.rawBody;
      if (!verify(msgToVerify, operatorSig, peer.public_key)) {
        console.error(`  SECURITY WARNING: Invalid operator signature for report ${reportMeta.signature}`);
        writeTrace(db, {
          eventType: 'reject',
          actorFingerprint: computeFingerprint(keys.publicKey),
          targetFingerprint: computeFingerprint(peer.public_key),
          artifactSignature: reportMeta.signature,
          outcome: 'rejected',
          rejectionReason: 'invalid_operator_signature',
          metadata: { peer: peer.operator_name },
        });
        failed++;
        continue;
      }
    }

    // Dedup by id
    const existsById = db.prepare('SELECT id FROM myr_reports WHERE id = ?').get(report.id);
    if (existsById) {
      skipped++;
      continue;
    }

    // Import to local database
    try {
      db.prepare(`
        INSERT INTO myr_reports (id, timestamp, agent_id, node_id, session_ref,
          cycle_intent, domain_tags, yield_type, question_answered,
          evidence, what_changes_next, confidence, operator_rating,
          created_at, updated_at, share_network, imported_from, import_verified, signed_artifact)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        report.id, report.timestamp, report.agent_id, report.node_id,
        report.session_ref || null,
        report.cycle_intent, report.domain_tags,
        report.yield_type, report.question_answered,
        report.evidence, report.what_changes_next,
        report.confidence || 0.7, report.operator_rating || null,
        report.created_at, report.updated_at || report.created_at,
        0, peer.operator_name, 1, report.signature
      );
      imported++;
      writeTrace(db, {
        eventType: 'sync_pull',
        actorFingerprint: computeFingerprint(keys.publicKey),
        targetFingerprint: computeFingerprint(peer.public_key),
        artifactSignature: report.signature || null,
        outcome: 'success',
        metadata: { peer: peer.operator_name, reportId: report.id },
      });
    } catch {
      failed++;
    }
  }

  db.prepare('UPDATE myr_peers SET last_sync_at = ? WHERE public_key = ?')
    .run(new Date().toISOString(), peer.public_key);

  return { imported, skipped, failed, peerName: peer.operator_name };
}

/**
 * Remove expired nonces from the database.
 */
function cleanupNonces(db) {
  return db.prepare('DELETE FROM myr_nonces WHERE expires_at < ?')
    .run(new Date().toISOString());
}

module.exports = { syncPeer, cleanupNonces, makeSignedHeaders, httpFetch };
