'use strict';

/**
 * Layer 2 persistence — MYR v1.0 spec
 *
 * Provides:
 * - ensureV1Schema(db)        — create/migrate all v1 tables
 * - writeTrace(db, event)     — append a trace record
 * - upsertPeer(db, identityDoc) — create/update peer from identity document
 * - approvePeer(db, fp)       — set trust_level = 'trusted'
 * - revokePeer(db, fp)        — set trust_level = 'revoked'
 * - getPeer(db, fp)           — fetch peer by fingerprint
 * - getPeerByPublicKey(db, k) — fetch peer by hex public key
 * - listPeers(db)             — list all peers
 * - updateSyncCursor(db, fp, ts) — record last successful sync timestamp
 * - importReport(db, doc, sourceFp) — validate + store network report
 * - cleanExpiredNonces(db)    — delete stale nonces
 * - hasNonce(db, nonce)       — replay-protection check
 * - storeNonce(db, nonce, expiresAt) — record seen nonce
 */

const { randomUUID, createHash } = require('crypto');
const { canonicalize } = require('./canonicalize');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Ensure all Layer 2 v1.0 tables and indexes exist on an open db connection.
 * Safe to call multiple times (CREATE IF NOT EXISTS throughout).
 */
function ensureV1Schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS myr_traces (
      trace_id         TEXT PRIMARY KEY,
      timestamp        TEXT NOT NULL,
      event_type       TEXT NOT NULL CHECK(event_type IN (
                         'introduce','approve','share','sync_pull',
                         'sync_push','verify','reject'
                       )),
      actor_fingerprint  TEXT NOT NULL,
      target_fingerprint TEXT,
      artifact_signature TEXT,
      outcome          TEXT NOT NULL CHECK(outcome IN ('success','failure','rejected')),
      rejection_reason TEXT,
      metadata         TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_traces_actor
      ON myr_traces(actor_fingerprint);
    CREATE INDEX IF NOT EXISTS idx_traces_timestamp
      ON myr_traces(timestamp);
    CREATE INDEX IF NOT EXISTS idx_traces_event_type
      ON myr_traces(event_type);

    CREATE TABLE IF NOT EXISTS myr_v1_peers (
      fingerprint       TEXT PRIMARY KEY,
      public_key        TEXT NOT NULL,
      node_url          TEXT,
      operator_name     TEXT,
      trust_level       TEXT NOT NULL
                          CHECK(trust_level IN ('introduced','trusted','revoked'))
                          DEFAULT 'introduced',
      introduced_at     TEXT NOT NULL,
      approved_at       TEXT,
      last_sync_at      TEXT,
      identity_document TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_v1_peers_pubkey
      ON myr_v1_peers(public_key);

    CREATE TABLE IF NOT EXISTS myr_network_reports (
      signature          TEXT PRIMARY KEY,
      operator_name      TEXT,
      created_at         TEXT,
      updated_at         TEXT,
      week_label         TEXT,
      size_bytes         INTEGER,
      content            TEXT NOT NULL,
      source_fingerprint TEXT,
      imported_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_network_reports_created
      ON myr_network_reports(created_at);
    CREATE INDEX IF NOT EXISTS idx_network_reports_source
      ON myr_network_reports(source_fingerprint);

    CREATE TABLE IF NOT EXISTS myr_nonces (
      nonce      TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nonces_expires
      ON myr_nonces(expires_at);
  `);
}

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

/**
 * Append a trace record. Every protocol operation must call this.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} event
 * @param {string} event.event_type       - one of the allowed event types
 * @param {string} event.actor_fingerprint
 * @param {string} [event.target_fingerprint]
 * @param {string} [event.artifact_signature]
 * @param {string} event.outcome          - 'success' | 'failure' | 'rejected'
 * @param {string} [event.rejection_reason]
 * @param {object} [event.metadata]
 * @returns {string} trace_id (UUID)
 */
function writeTrace(db, {
  event_type,
  actor_fingerprint,
  target_fingerprint = null,
  artifact_signature = null,
  outcome,
  rejection_reason = null,
  metadata = {},
} = {}) {
  const trace_id = randomUUID();
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO myr_traces
      (trace_id, timestamp, event_type, actor_fingerprint,
       target_fingerprint, artifact_signature, outcome,
       rejection_reason, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trace_id, timestamp, event_type, actor_fingerprint,
    target_fingerprint, artifact_signature, outcome,
    rejection_reason, JSON.stringify(metadata),
  );
  return trace_id;
}

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------

/**
 * Create or update a peer from their identity document.
 * On re-introduction, URL/name are updated but trust_level is preserved.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} identityDoc — must include fingerprint, public_key, node_url, operator_name
 * @returns {boolean} true if newly created, false if updated
 */
function upsertPeer(db, identityDoc) {
  const now = new Date().toISOString();
  const { fingerprint, public_key, node_url, operator_name } = identityDoc;
  const docJson = JSON.stringify(identityDoc);

  const existing = db.prepare(
    'SELECT fingerprint FROM myr_v1_peers WHERE fingerprint = ?',
  ).get(fingerprint);

  if (existing) {
    db.prepare(`
      UPDATE myr_v1_peers
      SET public_key=?, node_url=?, operator_name=?, identity_document=?
      WHERE fingerprint=?
    `).run(public_key, node_url, operator_name, docJson, fingerprint);
    return false;
  }

  db.prepare(`
    INSERT INTO myr_v1_peers
      (fingerprint, public_key, node_url, operator_name,
       trust_level, introduced_at, identity_document)
    VALUES (?, ?, ?, ?, 'introduced', ?, ?)
  `).run(fingerprint, public_key, node_url, operator_name, now, docJson);
  return true;
}

/**
 * Approve a peer: set trust_level = 'trusted'.
 * @param {import('better-sqlite3').Database} db
 * @param {string} fingerprint
 */
function approvePeer(db, fingerprint) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE myr_v1_peers SET trust_level='trusted', approved_at=?
    WHERE fingerprint=?
  `).run(now, fingerprint);
}

/**
 * Revoke a peer: set trust_level = 'revoked'.
 * @param {import('better-sqlite3').Database} db
 * @param {string} fingerprint
 */
function revokePeer(db, fingerprint) {
  db.prepare(
    "UPDATE myr_v1_peers SET trust_level='revoked' WHERE fingerprint=?",
  ).run(fingerprint);
}

/**
 * Get a peer by fingerprint. Returns null if not found.
 * @param {import('better-sqlite3').Database} db
 * @param {string} fingerprint
 * @returns {object|null}
 */
function getPeer(db, fingerprint) {
  return db.prepare(
    'SELECT * FROM myr_v1_peers WHERE fingerprint = ?',
  ).get(fingerprint) ?? null;
}

/**
 * Get a peer by hex public key. Returns null if not found.
 * @param {import('better-sqlite3').Database} db
 * @param {string} publicKey — hex-encoded Ed25519 public key
 * @returns {object|null}
 */
function getPeerByPublicKey(db, publicKey) {
  return db.prepare(
    'SELECT * FROM myr_v1_peers WHERE public_key = ?',
  ).get(publicKey) ?? null;
}

/**
 * List all peers ordered by introduction time.
 * @param {import('better-sqlite3').Database} db
 * @returns {object[]}
 */
function listPeers(db) {
  return db.prepare(
    'SELECT * FROM myr_v1_peers ORDER BY introduced_at ASC',
  ).all();
}

/**
 * Record the last successful sync timestamp for a peer.
 * @param {import('better-sqlite3').Database} db
 * @param {string} fingerprint
 * @param {string} timestamp — ISO8601
 */
function updateSyncCursor(db, fingerprint, timestamp) {
  db.prepare(
    'UPDATE myr_v1_peers SET last_sync_at=? WHERE fingerprint=?',
  ).run(timestamp, fingerprint);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * Import a network report after validating its embedded sha256 signature.
 * Idempotent: importing the same signature twice = one record, no error.
 *
 * The report's `signature` field must be "sha256:<hex>" where <hex> is the
 * SHA-256 of the canonicalized report object (excluding the `signature` field
 * itself). Invalid or missing signatures are silently rejected; a 'reject'
 * trace is written.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} reportDoc        — full report JSON as received
 * @param {string} sourceFp         — fingerprint of the peer who sent it
 * @returns {boolean} true if stored, false if rejected
 */
function importReport(db, reportDoc, sourceFp) {
  if (!reportDoc || typeof reportDoc !== 'object') {
    writeTrace(db, {
      event_type: 'reject',
      actor_fingerprint: sourceFp || 'unknown',
      outcome: 'rejected',
      rejection_reason: 'report is null or not an object',
    });
    return false;
  }

  const { signature } = reportDoc;

  if (!signature || typeof signature !== 'string' || !signature.startsWith('sha256:')) {
    writeTrace(db, {
      event_type: 'reject',
      actor_fingerprint: sourceFp || 'unknown',
      artifact_signature: signature || null,
      outcome: 'rejected',
      rejection_reason: 'missing or malformed signature field',
    });
    return false;
  }

  // Verify sha256 content hash
  const expectedHex = signature.slice(7); // strip "sha256:"
  const { signature: _omit, ...rest } = reportDoc;
  const canonical = canonicalize(rest);
  const computedHex = createHash('sha256').update(canonical).digest('hex');

  if (computedHex !== expectedHex) {
    writeTrace(db, {
      event_type: 'reject',
      actor_fingerprint: sourceFp || 'unknown',
      artifact_signature: signature,
      outcome: 'rejected',
      rejection_reason: 'sha256 signature does not match content',
    });
    return false;
  }

  const content = JSON.stringify(reportDoc);
  const size_bytes = Buffer.byteLength(content, 'utf8');
  const imported_at = new Date().toISOString();

  // INSERT OR REPLACE ensures deduplication on signature (idempotent)
  db.prepare(`
    INSERT OR REPLACE INTO myr_network_reports
      (signature, operator_name, created_at, updated_at,
       week_label, size_bytes, content, source_fingerprint, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    signature,
    reportDoc.operator_name ?? null,
    reportDoc.created_at ?? imported_at,
    reportDoc.updated_at ?? imported_at,
    reportDoc.week_label ?? null,
    size_bytes,
    content,
    sourceFp,
    imported_at,
  );

  writeTrace(db, {
    event_type: 'share',
    actor_fingerprint: sourceFp || 'unknown',
    artifact_signature: signature,
    outcome: 'success',
  });

  return true;
}

// ---------------------------------------------------------------------------
// Nonces
// ---------------------------------------------------------------------------

/**
 * Delete all nonces whose expires_at is in the past.
 * Call at the start of each authenticated request.
 * @param {import('better-sqlite3').Database} db
 */
function cleanExpiredNonces(db) {
  db.prepare('DELETE FROM myr_nonces WHERE expires_at < ?')
    .run(new Date().toISOString());
}

/**
 * Check whether a nonce has been seen before (replay protection).
 * @param {import('better-sqlite3').Database} db
 * @param {string} nonce
 * @returns {boolean}
 */
function hasNonce(db, nonce) {
  return !!db.prepare('SELECT nonce FROM myr_nonces WHERE nonce = ?').get(nonce);
}

/**
 * Record a nonce with its expiry timestamp.
 * @param {import('better-sqlite3').Database} db
 * @param {string} nonce
 * @param {string} expiresAt — ISO8601
 */
function storeNonce(db, nonce, expiresAt) {
  db.prepare('INSERT INTO myr_nonces (nonce, expires_at) VALUES (?, ?)')
    .run(nonce, expiresAt);
}

module.exports = {
  ensureV1Schema,
  writeTrace,
  upsertPeer,
  approvePeer,
  revokePeer,
  getPeer,
  getPeerByPublicKey,
  listPeers,
  updateSyncCursor,
  importReport,
  cleanExpiredNonces,
  hasNonce,
  storeNonce,
};
