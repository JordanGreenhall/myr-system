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
 * Send a MYR request through a relay node when direct HTTPS fails.
 *
 * @param {Object} params
 * @param {string} params.relayUrl - URL of the relay node
 * @param {Object} params.targetPeer - peer row from myr_peers table
 * @param {Object} params.keys - { publicKey, privateKey } hex-encoded
 * @param {string} params.method - HTTP method
 * @param {string} params.urlPath - Path + query string (e.g. /myr/reports?limit=500)
 * @param {Object} params.headers - HTTP headers for the inner request
 * @param {*} [params.body] - Request body (for POST requests)
 * @param {Function} [params.fetch] - Override fetch function
 * @returns {Promise<{ status: number, body: *, rawBody: string, headers: Object }>}
 */
async function fetchViaRelay({ relayUrl, targetPeer, keys, method, urlPath, headers, body, fetch: fetchFn }) {
  const doFetch = fetchFn || httpFetch;

  const request = { method, path: urlPath, headers: headers || {}, body: body || null };
  const payloadB64 = Buffer.from(JSON.stringify(request)).toString('base64');
  const signature = sign(payloadB64, keys.privateKey);

  const relayBody = {
    from_fingerprint: computeFingerprint(keys.publicKey),
    to_fingerprint: computeFingerprint(targetPeer.public_key),
    payload_b64: payloadB64,
    signature,
  };

  const relayRes = await doFetch(relayUrl.replace(/\/$/, '') + '/myr/relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: relayBody,
  });

  if (relayRes.status !== 200) {
    throw new Error(`Relay returned HTTP ${relayRes.status}: ${JSON.stringify(relayRes.body)}`);
  }

  const { status, body: responseBody, headers: responseHeaders } = relayRes.body;
  return {
    status: status || 200,
    body: responseBody,
    rawBody: JSON.stringify(responseBody),
    headers: responseHeaders || {},
  };
}

/**
 * Sync reports from a single peer.
 * @param {Object} params
 * @param {Object} params.db - better-sqlite3 database instance
 * @param {Object} params.peer - peer row from myr_peers table
 * @param {Object} params.keys - { publicKey, privateKey } hex-encoded
 * @param {Function} [params.fetch] - optional HTTP fetch function (for testing)
 * @param {Object} [params.relayConfig] - Relay configuration { url, fallbackOnly }
 * @param {Object} [params.replay] - Optional replay window { from, until }
 * @param {Object} [params.recovery] - Recovery tuning
 * @returns {Promise<{ imported: number, skipped: number, failed: number, peerNotTrusted?: boolean, peerName: string, relayUsed?: boolean, recoveredRanges: number, replayedRanges: number, gapsDetected: number }>}
 */
async function syncPeer({ db, peer, keys, fetch: fetchFn, relayConfig, replay, recovery = {} }) {
  const baseFetch = fetchFn || httpFetch;
  let relayUsed = false;
  const pageLimit = Math.min(Math.max(parseInt(recovery.pageLimit, 10) || 500, 1), 500);
  const maxGapMs = Math.max(parseInt(recovery.maxGapMs, 10) || (6 * 60 * 60 * 1000), 60 * 1000);
  const maxReplayRanges = Math.max(parseInt(recovery.maxReplayRanges, 10) || 10, 1);

  // Wrap fetch with relay fallback when direct HTTPS fails
  async function fetchWithFallback(url, options) {
    try {
      return await baseFetch(url, options);
    } catch (err) {
      if (!relayConfig || !relayConfig.url) throw err;
      relayUsed = true;
      const parsed = new URL(url);
      const urlPath = parsed.pathname + parsed.search;
      return fetchViaRelay({
        relayUrl: relayConfig.url,
        targetPeer: peer,
        keys,
        method: options.method || 'GET',
        urlPath,
        headers: options.headers || {},
        body: options.body || null,
        fetch: baseFetch,
      });
    }
  }

  function buildReportsUrl({ since, from, until }) {
    const params = new URLSearchParams();
    params.set('limit', String(pageLimit));
    if (since) {
      params.set('since', since);
    } else if (from) {
      params.set('from', from);
    }
    if (until) params.set('until', until);
    return peer.peer_url + '/myr/reports?' + params.toString();
  }

  async function fetchListingOrThrow(url) {
    const listHeaders = makeSignedHeaders({
      method: 'GET',
      urlPath: '/myr/reports',
      body: null,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });

    try {
      return await fetchWithFallback(url, { headers: listHeaders });
    } catch (err) {
      throw new Error(`Network error fetching report list from ${peer.operator_name}: ${err.message}`);
    }
  }

  function detectTimelineGaps() {
    if (replay && (replay.from || replay.until)) return [];

    let rows = [];
    try {
      rows = db.prepare(`
        SELECT created_at
        FROM myr_reports
        WHERE imported_from = ?
        ORDER BY created_at ASC
      `).all(peer.operator_name);
    } catch {
      return [];
    }

    const ranges = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1].created_at;
      const curr = rows[i].created_at;
      const gap = new Date(curr).getTime() - new Date(prev).getTime();
      if (Number.isFinite(gap) && gap > maxGapMs) {
        ranges.push({ from: prev, until: curr });
        if (ranges.length >= maxReplayRanges) break;
      }
    }
    return ranges;
  }

  async function importReportMeta(reportMeta) {
    // Dedup by signature (signed_artifact column)
    try {
      const existsBySig = db.prepare(
        'SELECT id FROM myr_reports WHERE signed_artifact = ?'
      ).get(reportMeta.signature);
      if (existsBySig) {
        return { imported: 0, skipped: 1, failed: 0 };
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
      reportRes = await fetchWithFallback(peer.peer_url + reportMeta.url, { headers: fetchHeaders });
    } catch (err) {
      console.error(`  Failed to fetch report ${reportMeta.signature}: ${err.message}`);
      return { imported: 0, skipped: 0, failed: 1 };
    }

    if (reportRes.status !== 200) {
      return { imported: 0, skipped: 0, failed: 1 };
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
      return { imported: 0, skipped: 0, failed: 1 };
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
        return { imported: 0, skipped: 0, failed: 1 };
      }
    }

    // Dedup by id
    const existsById = db.prepare('SELECT id FROM myr_reports WHERE id = ?').get(report.id);
    if (existsById) {
      return { imported: 0, skipped: 1, failed: 0 };
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
      writeTrace(db, {
        eventType: 'sync_pull',
        actorFingerprint: computeFingerprint(keys.publicKey),
        targetFingerprint: computeFingerprint(peer.public_key),
        artifactSignature: report.signature || null,
        outcome: 'success',
        metadata: { peer: peer.operator_name, reportId: report.id },
      });
      return { imported: 1, skipped: 0, failed: 0 };
    } catch {
      return { imported: 0, skipped: 0, failed: 1 };
    }
  }

  async function pullWindow({ from, until, since }) {
    let cursor = since || null;
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    let recoveredRanges = 0;
    let page = 0;

    while (true) {
      const reportsUrl = buildReportsUrl({ since: cursor, from, until });
      const listRes = await fetchListingOrThrow(reportsUrl);

      if (listRes.status === 403 && listRes.body?.error?.code === 'peer_not_trusted') {
        return {
          peerNotTrusted: true,
          imported,
          skipped,
          failed,
          recoveredRanges,
        };
      }
      if (listRes.status !== 200) {
        throw new Error(`Failed to fetch reports from ${peer.operator_name}: HTTP ${listRes.status}`);
      }

      const reports = Array.isArray(listRes.body?.reports) ? listRes.body.reports : [];
      const total = Number.isFinite(Number(listRes.body?.total))
        ? Number(listRes.body.total)
        : reports.length;
      const syncCursor = listRes.body?.sync_cursor || null;

      for (const reportMeta of reports) {
        const outcome = await importReportMeta(reportMeta);
        imported += outcome.imported;
        skipped += outcome.skipped;
        failed += outcome.failed;
      }

      const pageTruncated = total > reports.length;
      const needsMorePages = pageTruncated && syncCursor && syncCursor !== cursor;
      if (!needsMorePages) break;

      recoveredRanges++;
      cursor = syncCursor;
      page++;
      if (page > 2000) {
        throw new Error(`Sync pagination guard triggered for ${peer.operator_name}`);
      }
    }

    return { imported, skipped, failed, recoveredRanges };
  }

  const defaultSince = replay && replay.from ? null : (peer.last_sync_at || null);
  const initialWindow = await pullWindow({
    from: replay?.from || null,
    until: replay?.until || null,
    since: defaultSince,
  });

  if (initialWindow.peerNotTrusted) {
    return {
      imported: 0,
      skipped: 0,
      failed: 0,
      peerNotTrusted: true,
      peerName: peer.operator_name,
      relayUsed,
      recoveredRanges: 0,
      replayedRanges: 0,
      gapsDetected: 0,
    };
  }

  const gaps = detectTimelineGaps();
  let replayedRanges = 0;
  let recoveredRanges = initialWindow.recoveredRanges;
  let imported = initialWindow.imported;
  let skipped = initialWindow.skipped;
  let failed = initialWindow.failed;

  for (const gap of gaps) {
    const replayResult = await pullWindow({ from: gap.from, until: gap.until, since: null });
    imported += replayResult.imported;
    skipped += replayResult.skipped;
    failed += replayResult.failed;
    recoveredRanges += replayResult.recoveredRanges;
    replayedRanges++;
  }

  db.prepare('UPDATE myr_peers SET last_sync_at = ? WHERE public_key = ?')
    .run(new Date().toISOString(), peer.public_key);

  // Log relay usage if it occurred during this sync
  if (relayUsed && relayConfig && relayConfig.url) {
    writeTrace(db, {
      eventType: 'relay_sync',
      actorFingerprint: computeFingerprint(keys.publicKey),
      targetFingerprint: computeFingerprint(peer.public_key),
      outcome: 'success',
      metadata: { via: 'relay', relay_url: relayConfig.url, peer: peer.operator_name },
    });
  }

  return {
    imported,
    skipped,
    failed,
    peerName: peer.operator_name,
    relayUsed,
    recoveredRanges,
    replayedRanges,
    gapsDetected: gaps.length,
  };
}

/**
 * Remove expired nonces from the database.
 */
function cleanupNonces(db) {
  return db.prepare('DELETE FROM myr_nonces WHERE expires_at < ?')
    .run(new Date().toISOString());
}

module.exports = { syncPeer, cleanupNonces, makeSignedHeaders, httpFetch, fetchViaRelay };
