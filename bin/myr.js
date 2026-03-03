#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const nodeCrypto = require('crypto');
const http = require('http');
const https = require('https');
const { sign, fingerprint: computeFingerprint } = require('../lib/crypto');
const { canonicalize } = require('../lib/canonicalize');

// --- Key loading ---

function loadPublicKeyHex(keysPath, nodeId) {
  const pem = fs.readFileSync(path.join(keysPath, `${nodeId}.public.pem`), 'utf8');
  const der = nodeCrypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return der.slice(-32).toString('hex');
}

function loadPrivateKeyHex(keysPath, nodeId) {
  const pem = fs.readFileSync(path.join(keysPath, `${nodeId}.private.pem`), 'utf8');
  const der = nodeCrypto.createPrivateKey(pem).export({ type: 'pkcs8', format: 'der' });
  return der.slice(-32).toString('hex');
}

function loadKeypair(config) {
  return {
    publicKey: loadPublicKeyHex(config.keys_path, config.node_id),
    privateKey: loadPrivateKeyHex(config.keys_path, config.node_id),
  };
}

// --- HTTP helpers ---

function makeSignedHeaders({ method, urlPath, body, privateKey, publicKey }) {
  const ts = new Date().toISOString();
  const nonce = nodeCrypto.randomBytes(32).toString('hex');
  const rawBody = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
  const bodyHash = nodeCrypto.createHash('sha256').update(rawBody).digest('hex');
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

// --- Peer lookup ---

function findPeer(db, identifier) {
  const peer = db.prepare('SELECT * FROM myr_peers WHERE operator_name = ?').get(identifier);
  if (peer) return peer;

  const matches = db.prepare('SELECT * FROM myr_peers WHERE public_key LIKE ?').all(identifier + '%');
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Ambiguous: ${matches.length} peers match prefix "${identifier}". Use a longer prefix.`);
  }
  return null;
}

// --- Command implementations (exported for testing) ---

async function addPeer({ db, config, url, keys, fetch: fetchFn }) {
  fetchFn = fetchFn || httpFetch;
  const baseUrl = url.replace(/\/$/, '');

  const discovery = await fetchFn(baseUrl + '/.well-known/myr-node');
  if (discovery.status !== 200) {
    throw new Error(`Failed to fetch node info from ${url}: HTTP ${discovery.status}`);
  }

  const { public_key, operator_name, node_url } = discovery.body;
  if (!public_key || !operator_name) {
    throw new Error('Invalid discovery response: missing public_key or operator_name');
  }

  const existing = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(public_key);
  if (existing) {
    throw new Error(`Peer already exists: ${existing.operator_name} (${existing.peer_url})`);
  }

  const peerUrl = node_url || baseUrl;
  db.prepare(
    'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at) VALUES (?, ?, ?, ?, ?)'
  ).run(peerUrl, operator_name, public_key, 'pending', new Date().toISOString());

  const ourOperatorName = config.operator_name || config.node_name;
  const ourNodeUrl = config.node_url || `http://localhost:${config.port}`;
  const announceBody = {
    peer_url: ourNodeUrl,
    public_key: keys.publicKey,
    operator_name: ourOperatorName,
    timestamp: new Date().toISOString(),
    nonce: nodeCrypto.randomBytes(32).toString('hex'),
  };

  const signedHeaders = makeSignedHeaders({
    method: 'POST',
    urlPath: '/myr/peers/announce',
    body: announceBody,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });

  let announceStatus;
  try {
    const announceRes = await fetchFn(baseUrl + '/myr/peers/announce', {
      method: 'POST',
      headers: signedHeaders,
      body: announceBody,
    });
    announceStatus = announceRes.status;
  } catch {
    announceStatus = 0;
  }

  return {
    message: `Peer added (pending approval): ${operator_name} at ${peerUrl}`,
    peer: { operator_name, public_key, peer_url: peerUrl },
    announceStatus,
  };
}

function approvePeer({ db, identifier }) {
  const peer = findPeer(db, identifier);
  if (!peer) throw new Error(`No peer found matching "${identifier}"`);

  db.prepare('UPDATE myr_peers SET trust_level = ?, approved_at = ? WHERE public_key = ?')
    .run('trusted', new Date().toISOString(), peer.public_key);

  return { message: `Peer approved: ${peer.operator_name}`, peer };
}

function rejectPeer({ db, identifier }) {
  const peer = findPeer(db, identifier);
  if (!peer) throw new Error(`No peer found matching "${identifier}"`);

  db.prepare('UPDATE myr_peers SET trust_level = ? WHERE public_key = ?')
    .run('rejected', peer.public_key);

  return { message: `Peer rejected: ${peer.operator_name}`, peer };
}

function listPeers({ db }) {
  return db.prepare('SELECT * FROM myr_peers ORDER BY added_at DESC').all();
}

function getFingerprint({ publicKeyHex }) {
  return computeFingerprint(publicKeyHex);
}

function getPeerFingerprint({ db, name }) {
  const peer = findPeer(db, name);
  if (!peer) throw new Error(`No peer found matching "${name}"`);
  return { name: peer.operator_name, fingerprint: computeFingerprint(peer.public_key) };
}

async function syncPeer({ db, peerName, keys, fetch: fetchFn }) {
  fetchFn = fetchFn || httpFetch;
  const peer = findPeer(db, peerName);
  if (!peer) throw new Error(`No peer found matching "${peerName}"`);
  if (peer.trust_level !== 'trusted') {
    throw new Error(`Peer "${peer.operator_name}" is not trusted (status: ${peer.trust_level})`);
  }

  let reportsUrl = peer.peer_url + '/myr/reports';
  if (peer.last_sync_at) {
    reportsUrl += `?since=${encodeURIComponent(peer.last_sync_at)}`;
  }

  const listHeaders = makeSignedHeaders({
    method: 'GET',
    urlPath: '/myr/reports',
    body: null,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });

  const listRes = await fetchFn(reportsUrl, { headers: listHeaders });

  if (listRes.status === 403 && listRes.body?.error?.code === 'peer_not_trusted') {
    throw new Error(`Peer "${peer.operator_name}" has not approved us yet.`);
  }
  if (listRes.status !== 200) {
    throw new Error(`Failed to fetch reports: HTTP ${listRes.status}`);
  }

  const { reports } = listRes.body;
  let imported = 0;

  for (const reportMeta of reports) {
    const fetchPath = reportMeta.url.split('?')[0];
    const fetchHeaders = makeSignedHeaders({
      method: 'GET',
      urlPath: fetchPath,
      body: null,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });

    const reportRes = await fetchFn(peer.peer_url + reportMeta.url, { headers: fetchHeaders });
    if (reportRes.status !== 200) continue;

    const report = reportRes.body;

    const reportCopy = { ...report };
    delete reportCopy.signature;
    delete reportCopy.operator_signature;
    const canonical = canonicalize(reportCopy);
    const hash = nodeCrypto.createHash('sha256').update(canonical).digest('hex');
    if (report.signature && report.signature !== 'sha256:' + hash) continue;

    const exists = db.prepare('SELECT id FROM myr_reports WHERE id = ?').get(report.id);
    if (exists) continue;

    try {
      db.prepare(`
        INSERT INTO myr_reports (id, timestamp, agent_id, node_id, session_ref,
          cycle_intent, domain_tags, yield_type, question_answered,
          evidence, what_changes_next, confidence, operator_rating,
          created_at, updated_at, share_network, imported_from, import_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        report.id, report.timestamp, report.agent_id, report.node_id,
        report.session_ref || null,
        report.cycle_intent, report.domain_tags,
        report.yield_type, report.question_answered,
        report.evidence, report.what_changes_next,
        report.confidence || 0.7, report.operator_rating || null,
        report.created_at, report.updated_at || report.created_at,
        0, peer.operator_name, 1
      );
      imported++;
    } catch {
      // skip reports that fail to import
    }
  }

  db.prepare('UPDATE myr_peers SET last_sync_at = ? WHERE public_key = ?')
    .run(new Date().toISOString(), peer.public_key);

  return {
    message: `Synced ${imported} new report${imported !== 1 ? 's' : ''} from ${peer.operator_name}`,
    imported,
    peerName: peer.operator_name,
  };
}

// --- CLI wiring ---

if (require.main === module) {
  const config = require('../scripts/config');
  const { getDb } = require('../scripts/db');

  const program = new Command();
  program.name('myr').description('MYR network peer management CLI').version('0.4.0');

  program.command('add-peer <url>').description('Add a new peer by URL')
    .action(async (url) => {
      let db;
      try {
        db = getDb();
        const keys = loadKeypair(config);
        const result = await addPeer({ db, config, url, keys });
        console.log(result.message);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program.command('approve-peer <identifier>').description('Approve a pending peer')
    .action((identifier) => {
      let db;
      try {
        db = getDb();
        console.log(approvePeer({ db, identifier }).message);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program.command('reject-peer <identifier>').description('Reject a peer')
    .action((identifier) => {
      let db;
      try {
        db = getDb();
        console.log(rejectPeer({ db, identifier }).message);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program.command('peers').description('List all peers')
    .action(() => {
      let db;
      try {
        db = getDb();
        const peers = listPeers({ db });
        if (peers.length === 0) {
          console.log('No peers configured.');
          return;
        }

        const cols = { name: 16, url: 36, trust: 10, added: 20, synced: 20 };
        console.log(
          'OPERATOR'.padEnd(cols.name) + 'URL'.padEnd(cols.url) +
          'TRUST'.padEnd(cols.trust) + 'ADDED'.padEnd(cols.added) + 'LAST SYNC'
        );
        console.log('-'.repeat(cols.name + cols.url + cols.trust + cols.added + cols.synced));
        for (const p of peers) {
          console.log(
            (p.operator_name || '\u2014').padEnd(cols.name) +
            (p.peer_url || '\u2014').padEnd(cols.url) +
            (p.trust_level || 'pending').padEnd(cols.trust) +
            (p.added_at ? p.added_at.slice(0, 10) : '\u2014').padEnd(cols.added) +
            (p.last_sync_at ? p.last_sync_at.slice(0, 10) : 'never')
          );
        }
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program.command('fingerprint').description('Show our node fingerprint')
    .action(() => {
      try {
        const hex = loadPublicKeyHex(config.keys_path, config.node_id);
        console.log(`Your fingerprint: ${getFingerprint({ publicKeyHex: hex })}`);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
    });

  program.command('peer-fingerprint <name>').description("Show a peer's fingerprint")
    .action((name) => {
      let db;
      try {
        db = getDb();
        const result = getPeerFingerprint({ db, name });
        console.log(`${result.name} fingerprint: ${result.fingerprint}`);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program.command('sync <peer_name>').description('Sync reports from a trusted peer')
    .action(async (peerName) => {
      let db;
      try {
        db = getDb();
        const keys = loadKeypair(config);
        const result = await syncPeer({ db, peerName, keys });
        console.log(result.message);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      } finally {
        if (db) db.close();
      }
    });

  program.parse(process.argv);
}

module.exports = {
  findPeer, addPeer, approvePeer, rejectPeer, listPeers,
  getFingerprint, getPeerFingerprint, syncPeer,
  makeSignedHeaders, httpFetch, loadKeypair, loadPublicKeyHex, loadPrivateKeyHex,
};
