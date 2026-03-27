'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createApp } = require('../server/index');
const { generateKeypair, fingerprint: computeFingerprint, sign } = require('../lib/crypto');
const { syncPeer, makeSignedHeaders, fetchViaRelay } = require('../lib/sync');

// ── DB helper ────────────────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS myr_reports (
      id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, agent_id TEXT NOT NULL,
      node_id TEXT NOT NULL, session_ref TEXT, cycle_intent TEXT NOT NULL,
      domain_tags TEXT NOT NULL, yield_type TEXT NOT NULL,
      question_answered TEXT NOT NULL, evidence TEXT NOT NULL,
      what_changes_next TEXT NOT NULL, confidence REAL DEFAULT 0.7,
      operator_rating INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      share_network INTEGER DEFAULT 0, imported_from TEXT,
      import_verified INTEGER DEFAULT 0, signed_artifact TEXT
    );
    CREATE TABLE IF NOT EXISTS myr_peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, peer_url TEXT,
      operator_name TEXT, public_key TEXT UNIQUE NOT NULL,
      trust_level TEXT DEFAULT 'pending', added_at TEXT NOT NULL,
      approved_at TEXT, last_sync_at TEXT, auto_sync INTEGER DEFAULT 1,
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS myr_nonces (
      nonce TEXT PRIMARY KEY, seen_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nonces_expires ON myr_nonces(expires_at);
    CREATE TABLE IF NOT EXISTS myr_traces (
      trace_id TEXT PRIMARY KEY, timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL, actor_fingerprint TEXT NOT NULL,
      target_fingerprint TEXT, artifact_signature TEXT,
      outcome TEXT NOT NULL, rejection_reason TEXT, metadata TEXT DEFAULT '{}'
    );
  `);
  return db;
}

function addPeer(db, keys, url, trust = 'trusted') {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(url, 'test-operator', keys.publicKey, trust, now, trust === 'trusted' ? now : null);
}

// ── POST /myr/relay ───────────────────────────────────────────────────────────

describe('POST /myr/relay', () => {
  it('rejects request with missing fields (400)', async () => {
    const relayKeys = generateKeypair();
    const db = makeDb();
    const app = createApp({
      config: { operator_name: 'relay', node_url: 'http://relay.test', port: 3999 },
      db,
      publicKeyHex: relayKeys.publicKey,
      privateKeyHex: relayKeys.privateKey,
    });

    await new Promise((resolve, reject) => {
      const server = app.listen(0, async () => {
        const port = server.address().port;
        try {
          const res = await fetch(`http://localhost:${port}/myr/relay`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ from_fingerprint: 'abc' }), // missing fields
          });
          assert.equal(res.status, 400);
          const body = await res.json();
          assert.equal(body.error.code, 'invalid_request');
          resolve();
        } catch (err) { reject(err); } finally { server.close(); }
      });
    });
  });

  it('rejects sender not in peer list (403)', async () => {
    const relayKeys = generateKeypair();
    const senderKeys = generateKeypair();
    const recipientKeys = generateKeypair();
    const db = makeDb();
    // Only recipient in peer list, not sender
    addPeer(db, recipientKeys, 'http://recipient.test');

    const app = createApp({
      config: { operator_name: 'relay', node_url: 'http://relay.test', port: 3999 },
      db,
      publicKeyHex: relayKeys.publicKey,
      privateKeyHex: relayKeys.privateKey,
    });

    await new Promise((resolve, reject) => {
      const server = app.listen(0, async () => {
        const port = server.address().port;
        try {
          const payloadB64 = Buffer.from('{}').toString('base64');
          const signature = sign(payloadB64, senderKeys.privateKey);
          const res = await fetch(`http://localhost:${port}/myr/relay`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              from_fingerprint: computeFingerprint(senderKeys.publicKey),
              to_fingerprint: computeFingerprint(recipientKeys.publicKey),
              payload_b64: payloadB64,
              signature,
            }),
          });
          assert.equal(res.status, 403);
          const body = await res.json();
          assert.equal(body.error.code, 'forbidden');
          resolve();
        } catch (err) { reject(err); } finally { server.close(); }
      });
    });
  });

  it('rejects invalid signature (400)', async () => {
    const relayKeys = generateKeypair();
    const senderKeys = generateKeypair();
    const recipientKeys = generateKeypair();
    const db = makeDb();
    addPeer(db, senderKeys, 'http://sender.test');
    addPeer(db, recipientKeys, 'http://recipient.test');

    const app = createApp({
      config: { operator_name: 'relay', node_url: 'http://relay.test', port: 3999 },
      db,
      publicKeyHex: relayKeys.publicKey,
      privateKeyHex: relayKeys.privateKey,
    });

    await new Promise((resolve, reject) => {
      const server = app.listen(0, async () => {
        const port = server.address().port;
        try {
          const payloadB64 = Buffer.from('{}').toString('base64');
          // Sign with WRONG key
          const wrongKeys = generateKeypair();
          const badSignature = sign(payloadB64, wrongKeys.privateKey);

          const res = await fetch(`http://localhost:${port}/myr/relay`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              from_fingerprint: computeFingerprint(senderKeys.publicKey),
              to_fingerprint: computeFingerprint(recipientKeys.publicKey),
              payload_b64: payloadB64,
              signature: badSignature,
            }),
          });
          assert.equal(res.status, 400);
          const body = await res.json();
          assert.equal(body.error.code, 'invalid_signature');
          resolve();
        } catch (err) { reject(err); } finally { server.close(); }
      });
    });
  });

  it('forwards valid relay request to known peer and returns response', async () => {
    const relayKeys = generateKeypair();
    const senderKeys = generateKeypair();
    const recipientKeys = generateKeypair();
    const relayDb = makeDb();
    addPeer(relayDb, senderKeys, 'http://sender.test');

    // Start a mock recipient server
    const http = require('http');
    const recipientServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reports: [], total: 0 }));
    });

    await new Promise(r => recipientServer.listen(0, r));
    const recipientPort = recipientServer.address().port;
    const recipientUrl = `http://localhost:${recipientPort}`;

    addPeer(relayDb, recipientKeys, recipientUrl);

    const app = createApp({
      config: { operator_name: 'relay', node_url: 'http://relay.test', port: 3999 },
      db: relayDb,
      publicKeyHex: relayKeys.publicKey,
      privateKeyHex: relayKeys.privateKey,
    });

    await new Promise((resolve, reject) => {
      const server = app.listen(0, async () => {
        const port = server.address().port;
        try {
          const innerRequest = { method: 'GET', path: '/myr/reports?limit=500', headers: {}, body: null };
          const payloadB64 = Buffer.from(JSON.stringify(innerRequest)).toString('base64');
          const signature = sign(payloadB64, senderKeys.privateKey);

          const res = await fetch(`http://localhost:${port}/myr/relay`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              from_fingerprint: computeFingerprint(senderKeys.publicKey),
              to_fingerprint: computeFingerprint(recipientKeys.publicKey),
              payload_b64: payloadB64,
              signature,
            }),
          });
          assert.equal(res.status, 200);
          const body = await res.json();
          assert.equal(body.status, 200);
          assert.ok(body.body.reports !== undefined);
          resolve();
        } catch (err) { reject(err); } finally {
          server.close();
          recipientServer.close();
        }
      });
    });
  });

  it('enforces rate limiting (429 after 60 requests/min)', async () => {
    const relayKeys = generateKeypair();
    const senderKeys = generateKeypair();
    const db = makeDb();
    // Don't add sender to peer list — each request will get 403, not reach proxy
    // But rate limiting happens first. We need sender in peer list for rate limit to apply.
    addPeer(db, senderKeys, 'http://sender.test');

    const app = createApp({
      config: { operator_name: 'relay', node_url: 'http://relay.test', port: 3999 },
      db,
      publicKeyHex: relayKeys.publicKey,
      privateKeyHex: relayKeys.privateKey,
    });

    await new Promise((resolve, reject) => {
      const server = app.listen(0, async () => {
        const port = server.address().port;
        try {
          const fromFp = computeFingerprint(senderKeys.publicKey);
          // Make 61 requests — first 60 should not be 429, 61st should be
          let hitRateLimit = false;
          for (let i = 0; i < 61; i++) {
            const payloadB64 = Buffer.from('{}').toString('base64');
            const signature = sign(payloadB64, senderKeys.privateKey);
            const res = await fetch(`http://localhost:${port}/myr/relay`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                from_fingerprint: fromFp,
                to_fingerprint: 'SHA-256:00:00:00', // won't be found, but rate limit hits first
                payload_b64: payloadB64,
                signature,
              }),
            });
            if (res.status === 429) {
              hitRateLimit = true;
              const body = await res.json();
              assert.equal(body.error.code, 'rate_limit_exceeded');
              break;
            }
          }
          assert.ok(hitRateLimit, 'Should have hit rate limit after 60 requests');
          resolve();
        } catch (err) { reject(err); } finally { server.close(); }
      });
    });
  });
});

// ── fetchViaRelay ────────────────────────────────────────────────────────────

describe('fetchViaRelay', () => {
  it('sends correctly signed relay request and returns proxied response', async () => {
    const senderKeys = generateKeypair();
    const recipientKeys = generateKeypair();
    const recipient = {
      public_key: recipientKeys.publicKey,
      operator_name: 'recipient',
      peer_url: 'http://recipient.test:9999',
    };

    const capturedRequests = [];
    const mockFetch = async (url, options) => {
      capturedRequests.push({ url, options });
      return {
        status: 200,
        body: { status: 200, body: { reports: [], total: 0 }, headers: {} },
        rawBody: '{}',
        headers: {},
      };
    };

    const result = await fetchViaRelay({
      relayUrl: 'http://relay.test',
      targetPeer: recipient,
      keys: senderKeys,
      method: 'GET',
      urlPath: '/myr/reports?limit=500',
      headers: { 'x-myr-timestamp': 'ts', 'x-myr-nonce': 'nonce' },
      body: null,
      fetch: mockFetch,
    });

    assert.equal(capturedRequests.length, 1);
    assert.ok(capturedRequests[0].url.endsWith('/myr/relay'));

    const relayBody = capturedRequests[0].options.body;
    assert.equal(relayBody.from_fingerprint, computeFingerprint(senderKeys.publicKey));
    assert.equal(relayBody.to_fingerprint, computeFingerprint(recipientKeys.publicKey));
    assert.ok(relayBody.payload_b64);
    assert.ok(relayBody.signature);

    // Verify signature is valid
    const { verify } = require('../lib/crypto');
    assert.ok(verify(relayBody.payload_b64, relayBody.signature, senderKeys.publicKey));

    // Verify payload decodes correctly
    const decoded = JSON.parse(Buffer.from(relayBody.payload_b64, 'base64').toString('utf8'));
    assert.equal(decoded.method, 'GET');
    assert.equal(decoded.path, '/myr/reports?limit=500');

    assert.equal(result.status, 200);
    assert.ok(result.body.reports !== undefined);
  });

  it('throws when relay returns non-200', async () => {
    const senderKeys = generateKeypair();
    const recipientKeys = generateKeypair();
    const recipient = {
      public_key: recipientKeys.publicKey,
      operator_name: 'recipient',
      peer_url: 'http://recipient.test',
    };

    const mockFetch = async () => ({
      status: 503,
      body: { error: { code: 'relay_error', message: 'Relay unavailable' } },
      rawBody: '{}',
      headers: {},
    });

    await assert.rejects(
      () => fetchViaRelay({
        relayUrl: 'http://relay.test',
        targetPeer: recipient,
        keys: senderKeys,
        method: 'GET',
        urlPath: '/myr/reports',
        headers: {},
        body: null,
        fetch: mockFetch,
      }),
      /Relay returned HTTP 503/
    );
  });
});

// ── syncPeer relay fallback ──────────────────────────────────────────────────

describe('syncPeer relay fallback', () => {
  it('falls back to relay when direct HTTPS fails', async () => {
    const ourKeys = generateKeypair();
    const peerKeys = generateKeypair();
    const db = makeDb();
    const now = new Date().toISOString();

    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('http://peer.test', 'peer-op', peerKeys.publicKey, 'trusted', now, now);

    const peer = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(peerKeys.publicKey);

    let directAttempts = 0;
    let relayAttempts = 0;

    const mockFetch = async (url, options) => {
      if (url.includes('/myr/relay')) {
        relayAttempts++;
        // Return a valid relay response with empty reports
        return {
          status: 200,
          body: {
            status: 200,
            body: { reports: [], total: 0, sync_cursor: null },
            headers: {},
          },
          rawBody: '{}',
          headers: {},
        };
      }
      directAttempts++;
      throw new Error('ECONNREFUSED: connection refused');
    };

    const result = await syncPeer({
      db,
      peer,
      keys: ourKeys,
      fetch: mockFetch,
      relayConfig: { url: 'http://relay.test', fallbackOnly: true },
    });

    assert.ok(directAttempts >= 1, 'Should have attempted direct connection');
    assert.ok(relayAttempts >= 1, 'Should have fallen back to relay');
    assert.equal(result.relayUsed, true);
    assert.equal(result.peerName, 'peer-op');
  });

  it('throws without relay when direct HTTPS fails and no relay configured', async () => {
    const ourKeys = generateKeypair();
    const peerKeys = generateKeypair();
    const db = makeDb();
    const now = new Date().toISOString();

    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('http://peer.test', 'peer-op', peerKeys.publicKey, 'trusted', now, now);

    const peer = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(peerKeys.publicKey);

    const mockFetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    await assert.rejects(
      () => syncPeer({ db, peer, keys: ourKeys, fetch: mockFetch }),
      /Network error/
    );
  });

  it('records relay_sync trace when relay is used', async () => {
    const ourKeys = generateKeypair();
    const peerKeys = generateKeypair();
    const db = makeDb();
    const now = new Date().toISOString();

    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('http://peer.test', 'peer-op', peerKeys.publicKey, 'trusted', now, now);

    const peer = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(peerKeys.publicKey);

    const mockFetch = async (url) => {
      if (url.includes('/myr/relay')) {
        return {
          status: 200,
          body: {
            status: 200,
            body: { reports: [], total: 0, sync_cursor: null },
            headers: {},
          },
          rawBody: '{}',
          headers: {},
        };
      }
      throw new Error('ECONNREFUSED');
    };

    await syncPeer({
      db,
      peer,
      keys: ourKeys,
      fetch: mockFetch,
      relayConfig: { url: 'http://relay.test', fallbackOnly: true },
    });

    const traces = db.prepare(
      "SELECT * FROM myr_traces WHERE event_type = 'relay_sync'"
    ).all();
    assert.ok(traces.length >= 1);
    assert.equal(traces[0].outcome, 'success');
    const meta = JSON.parse(traces[0].metadata);
    assert.equal(meta.via, 'relay');
    assert.equal(meta.relay_url, 'http://relay.test');
  });

  it('relay fallback is transparent: sync succeeds when direct fails + relay available', async () => {
    const ourKeys = generateKeypair();
    const peerKeys = generateKeypair();
    const db = makeDb();
    const now = new Date().toISOString();

    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('http://peer.test', 'peer-op', peerKeys.publicKey, 'trusted', now, now);

    const peer = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(peerKeys.publicKey);

    // Build a real report to sync
    const { canonicalize } = require('../lib/canonicalize');
    const nodeCrypto = require('crypto');
    const report = {
      id: 'peer-20260326-001',
      timestamp: now,
      agent_id: 'agent-1',
      node_id: 'peer-node',
      cycle_intent: 'test intent',
      domain_tags: 'test',
      yield_type: 'insight',
      question_answered: 'test q',
      evidence: 'test evidence',
      what_changes_next: 'nothing',
      confidence: 0.8,
      created_at: now,
      updated_at: now,
      share_network: 1,
    };
    const reportCopy = { ...report };
    delete reportCopy.signature;
    delete reportCopy.operator_signature;
    const canonical = canonicalize(reportCopy);
    const hash = nodeCrypto.createHash('sha256').update(canonical).digest('hex');
    const sig = 'sha256:' + hash;
    report.signature = sig;

    // Single mock: direct connections always fail; relay routes based on inner request path
    const mockFetch = async (url, options) => {
      if (!url.includes('/myr/relay')) {
        throw new Error('ECONNREFUSED');
      }

      // Decode relay payload to determine which resource is being proxied
      const relayBody = options && options.body;
      const innerRequest = relayBody
        ? JSON.parse(Buffer.from(relayBody.payload_b64, 'base64').toString('utf8'))
        : {};

      if (innerRequest.path && innerRequest.path.includes('sha256:')) {
        // Report fetch
        return {
          status: 200,
          body: { status: 200, body: report, headers: {} },
          rawBody: '{}',
          headers: {},
        };
      }
      // Report list
      return {
        status: 200,
        body: {
          status: 200,
          body: {
            reports: [{ signature: sig, url: `/myr/reports/${sig}`, created_at: now }],
            total: 1,
            sync_cursor: now,
          },
          headers: {},
        },
        rawBody: '{}',
        headers: {},
      };
    };

    const result = await syncPeer({
      db,
      peer,
      keys: ourKeys,
      fetch: mockFetch,
      relayConfig: { url: 'http://relay.test', fallbackOnly: true },
    });

    assert.equal(result.imported, 1);
    assert.equal(result.relayUsed, true);
  });

  it('does not use relay when direct HTTPS succeeds (fallback_only: true)', async () => {
    const ourKeys = generateKeypair();
    const peerKeys = generateKeypair();
    const db = makeDb();
    const now = new Date().toISOString();

    db.prepare(
      'INSERT INTO myr_peers (peer_url, operator_name, public_key, trust_level, added_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('http://peer.test', 'peer-op', peerKeys.publicKey, 'trusted', now, now);

    const peer = db.prepare('SELECT * FROM myr_peers WHERE public_key = ?').get(peerKeys.publicKey);

    let relayAttempts = 0;
    const mockFetch = async (url) => {
      if (url.includes('/myr/relay')) relayAttempts++;
      return {
        status: 200,
        body: { reports: [], total: 0, sync_cursor: null },
        rawBody: '{}',
        headers: {},
      };
    };

    const result = await syncPeer({
      db,
      peer,
      keys: ourKeys,
      fetch: mockFetch,
      relayConfig: { url: 'http://relay.test', fallbackOnly: true },
    });

    assert.equal(relayAttempts, 0, 'Relay should not be used when direct succeeds');
    assert.equal(result.relayUsed, false);
  });
});

// ── relay_sync trace event type ───────────────────────────────────────────────

describe('relay_sync event type in myr_traces', () => {
  it('accepts relay_sync as a valid event_type', () => {
    const { writeTrace } = require('../lib/trace');
    const db = makeDb();
    const traceId = writeTrace(db, {
      eventType: 'relay_sync',
      actorFingerprint: 'SHA-256:aa:bb',
      targetFingerprint: 'SHA-256:cc:dd',
      outcome: 'success',
      metadata: { via: 'relay' },
    });
    assert.ok(traceId);
    const row = db.prepare('SELECT * FROM myr_traces WHERE trace_id = ?').get(traceId);
    assert.ok(row);
    assert.equal(row.event_type, 'relay_sync');
  });
});

// ── discover event type in myr_traces ────────────────────────────────────────

describe('discover event type in myr_traces', () => {
  it('accepts discover as a valid event_type', () => {
    const { writeTrace } = require('../lib/trace');
    const db = makeDb();
    const traceId = writeTrace(db, {
      eventType: 'discover',
      actorFingerprint: 'SHA-256:aa:bb',
      targetFingerprint: 'SHA-256:cc:dd',
      outcome: 'success',
      metadata: { via: 'dht' },
    });
    assert.ok(traceId);
    const row = db.prepare('SELECT * FROM myr_traces WHERE trace_id = ?').get(traceId);
    assert.ok(row);
    assert.equal(row.event_type, 'discover');
  });
});
