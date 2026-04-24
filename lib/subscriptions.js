'use strict';

const crypto = require('crypto');
const { sign, verify, fingerprint: computeFingerprint } = require('./crypto');
const { canonicalize } = require('./canonicalize');

const DEFAULT_PROPAGATION_HOPS = 2;

function normalizeTags(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || '')
      .split(',');

  const deduped = new Set();
  for (const tag of raw) {
    const normalized = String(tag || '').trim().toLowerCase();
    if (normalized) deduped.add(normalized);
  }
  return Array.from(deduped).sort();
}

function parseTagsField(raw) {
  if (Array.isArray(raw)) return normalizeTags(raw);
  if (raw == null) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalizeTags(parsed);
    } catch {
      return normalizeTags(raw);
    }
  }
  return [];
}

function computeSignalId(ownerPublicKey, tags) {
  const normalizedTags = normalizeTags(tags);
  const digest = crypto.createHash('sha256')
    .update(`${ownerPublicKey}|${normalizedTags.join(',')}`)
    .digest('hex')
    .slice(0, 24);
  return `sub-${digest}`;
}

function buildSignalPayload(signal) {
  return canonicalize({
    signal_id: signal.signal_id,
    owner_public_key: signal.owner_public_key,
    owner_fingerprint: signal.owner_fingerprint || computeFingerprint(signal.owner_public_key),
    owner_operator_name: signal.owner_operator_name || null,
    tags: normalizeTags(signal.tags),
    intent_description: signal.intent_description || null,
    status: signal.status,
    created_at: signal.created_at,
    updated_at: signal.updated_at,
  });
}

function createSignedSignal({
  ownerPublicKey,
  ownerOperatorName,
  tags,
  intentDescription,
  status = 'active',
  privateKey,
  createdAt,
  updatedAt,
  signalId,
}) {
  const normalizedTags = normalizeTags(tags);
  if (normalizedTags.length === 0) {
    throw new Error('At least one tag is required');
  }
  const nowIso = new Date().toISOString();
  const created = createdAt || nowIso;
  const updated = updatedAt || nowIso;

  const signal = {
    signal_id: signalId || computeSignalId(ownerPublicKey, normalizedTags),
    owner_public_key: ownerPublicKey,
    owner_fingerprint: computeFingerprint(ownerPublicKey),
    owner_operator_name: ownerOperatorName || null,
    tags: normalizedTags,
    intent_description: intentDescription || null,
    status: status === 'inactive' ? 'inactive' : 'active',
    created_at: created,
    updated_at: updated,
  };
  signal.signal_signature = sign(buildSignalPayload(signal), privateKey);
  return signal;
}

function verifySignalSignature(signal) {
  if (!signal || !signal.signal_signature || !signal.owner_public_key) return false;
  return verify(buildSignalPayload(signal), signal.signal_signature, signal.owner_public_key);
}

function ensureSubscriptionsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS myr_subscriptions (
      signal_id TEXT PRIMARY KEY,
      owner_public_key TEXT NOT NULL,
      owner_fingerprint TEXT NOT NULL,
      owner_operator_name TEXT,
      tags_json TEXT NOT NULL,
      intent_description TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','inactive')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local','remote')),
      signal_signature TEXT NOT NULL,
      last_received_from TEXT,
      hops_remaining INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_owner_status
      ON myr_subscriptions(owner_public_key, status);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_updated
      ON myr_subscriptions(updated_at DESC);
  `);
}

function decodeSubscriptionRow(row) {
  if (!row) return null;
  return {
    signal_id: row.signal_id,
    owner_public_key: row.owner_public_key,
    owner_fingerprint: row.owner_fingerprint,
    owner_operator_name: row.owner_operator_name,
    tags: parseTagsField(row.tags_json),
    intent_description: row.intent_description,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source: row.source,
    signal_signature: row.signal_signature,
    last_received_from: row.last_received_from,
    hops_remaining: Number.isFinite(Number(row.hops_remaining)) ? Number(row.hops_remaining) : 0,
  };
}

function upsertSubscriptionSignal(db, signal, { source = 'local', receivedFrom = null, hopsRemaining = 0 } = {}) {
  ensureSubscriptionsSchema(db);

  const normalizedTags = normalizeTags(signal.tags);
  if (normalizedTags.length === 0) {
    throw new Error('Signal must include at least one tag');
  }
  if (!signal.signal_id || !signal.owner_public_key || !signal.signal_signature) {
    throw new Error('Signal missing required fields');
  }

  const nowIso = new Date().toISOString();
  const createdAt = signal.created_at || nowIso;
  const updatedAt = signal.updated_at || nowIso;
  const status = signal.status === 'inactive' ? 'inactive' : 'active';
  const ownerFingerprint = signal.owner_fingerprint || computeFingerprint(signal.owner_public_key);
  const sourceValue = source === 'remote' ? 'remote' : 'local';
  const hops = Math.max(0, parseInt(hopsRemaining, 10) || 0);

  db.prepare(`
    INSERT INTO myr_subscriptions (
      signal_id, owner_public_key, owner_fingerprint, owner_operator_name,
      tags_json, intent_description, status, created_at, updated_at, source,
      signal_signature, last_received_from, hops_remaining
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(signal_id) DO UPDATE SET
      owner_public_key = excluded.owner_public_key,
      owner_fingerprint = excluded.owner_fingerprint,
      owner_operator_name = excluded.owner_operator_name,
      tags_json = excluded.tags_json,
      intent_description = excluded.intent_description,
      status = excluded.status,
      updated_at = excluded.updated_at,
      source = excluded.source,
      signal_signature = excluded.signal_signature,
      last_received_from = excluded.last_received_from,
      hops_remaining = excluded.hops_remaining
    WHERE excluded.updated_at >= myr_subscriptions.updated_at
  `).run(
    signal.signal_id,
    signal.owner_public_key,
    ownerFingerprint,
    signal.owner_operator_name || null,
    JSON.stringify(normalizedTags),
    signal.intent_description || null,
    status,
    createdAt,
    updatedAt,
    sourceValue,
    signal.signal_signature,
    receivedFrom,
    hops
  );

  const row = db.prepare('SELECT * FROM myr_subscriptions WHERE signal_id = ?').get(signal.signal_id);
  return decodeSubscriptionRow(row);
}

function listSubscriptions(db, { ownerPublicKey = null, includeInactive = false } = {}) {
  ensureSubscriptionsSchema(db);
  const where = [];
  const params = [];
  if (ownerPublicKey) {
    where.push('owner_public_key = ?');
    params.push(ownerPublicKey);
  }
  if (!includeInactive) {
    where.push("status = 'active'");
  }
  const sql = `
    SELECT *
    FROM myr_subscriptions
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC
  `;
  return db.prepare(sql).all(...params).map(decodeSubscriptionRow);
}

function getActiveSubscriptionsForOwner(db, ownerPublicKey) {
  return listSubscriptions(db, { ownerPublicKey, includeInactive: false });
}

function parseReportTags(raw) {
  return parseTagsField(raw);
}

function reportMatchesSubscriptions(reportTagsRaw, subscriptions) {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return true;
  const reportTags = new Set(parseReportTags(reportTagsRaw));
  if (reportTags.size === 0) return false;

  for (const sub of subscriptions) {
    const tags = normalizeTags(sub.tags);
    for (const tag of tags) {
      if (reportTags.has(tag)) return true;
    }
  }
  return false;
}

module.exports = {
  DEFAULT_PROPAGATION_HOPS,
  normalizeTags,
  parseTagsField,
  parseReportTags,
  computeSignalId,
  buildSignalPayload,
  createSignedSignal,
  verifySignalSignature,
  ensureSubscriptionsSchema,
  upsertSubscriptionSignal,
  decodeSubscriptionRow,
  listSubscriptions,
  getActiveSubscriptionsForOwner,
  reportMatchesSubscriptions,
};
