'use strict';

const crypto = require('crypto');

/**
 * Valid event types per MYR-DESIGN-SPEC-v1.0 Layer 2 trace schema.
 */
const EVENT_TYPES = new Set([
  'introduce', 'approve', 'share', 'sync_pull', 'sync_push', 'verify', 'reject',
]);

const OUTCOMES = new Set(['success', 'failure', 'rejected']);

/**
 * Write a trace entry to the myr_traces table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} params
 * @param {string} params.eventType - One of: introduce, approve, share, sync_pull, sync_push, verify, reject
 * @param {string} params.actorFingerprint - Fingerprint of the node initiating the action
 * @param {string} [params.targetFingerprint] - Fingerprint of the peer (if applicable)
 * @param {string} [params.artifactSignature] - SHA-256 of report/payload (if applicable)
 * @param {string} params.outcome - One of: success, failure, rejected
 * @param {string} [params.rejectionReason] - Reason for rejection (if outcome is 'rejected')
 * @param {Object} [params.metadata] - Additional context (stored as JSON)
 * @returns {string} The generated trace_id
 */
function writeTrace(db, {
  eventType,
  actorFingerprint,
  targetFingerprint = null,
  artifactSignature = null,
  outcome,
  rejectionReason = null,
  metadata = {},
}) {
  if (!EVENT_TYPES.has(eventType)) {
    throw new Error(`Invalid event_type: ${eventType}. Must be one of: ${[...EVENT_TYPES].join(', ')}`);
  }
  if (!OUTCOMES.has(outcome)) {
    throw new Error(`Invalid outcome: ${outcome}. Must be one of: ${[...OUTCOMES].join(', ')}`);
  }

  const traceId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const metadataJson = JSON.stringify(metadata);

  try {
    db.prepare(`
      INSERT INTO myr_traces (trace_id, timestamp, event_type, actor_fingerprint, target_fingerprint,
        artifact_signature, outcome, rejection_reason, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(traceId, timestamp, eventType, actorFingerprint, targetFingerprint,
      artifactSignature, outcome, rejectionReason, metadataJson);
  } catch (err) {
    // Gracefully handle missing myr_traces table (e.g. in legacy DBs or tests without migration)
    if (!err.message.includes('no such table')) throw err;
  }

  return traceId;
}

/**
 * Query traces by event type (for diagnostics/debugging).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} eventType
 * @param {number} [limit=100]
 * @returns {Array}
 */
function getTraces(db, eventType, limit = 100) {
  return db.prepare(
    'SELECT * FROM myr_traces WHERE event_type = ? ORDER BY timestamp DESC LIMIT ?'
  ).all(eventType, limit);
}

/**
 * Get all traces for a specific actor (peer fingerprint).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} actorFingerprint
 * @param {number} [limit=100]
 * @returns {Array}
 */
function getTracesByActor(db, actorFingerprint, limit = 100) {
  return db.prepare(
    'SELECT * FROM myr_traces WHERE actor_fingerprint = ? ORDER BY timestamp DESC LIMIT ?'
  ).all(actorFingerprint, limit);
}

module.exports = { writeTrace, getTraces, getTracesByActor, EVENT_TYPES, OUTCOMES };
