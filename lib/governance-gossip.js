'use strict';

const crypto = require('crypto');
const { sign, verify } = require('./crypto');

const DEFAULT_GOVERNANCE_TTL = 5;

function ensureGovernanceGossipSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS myr_governance_signals (
      signal_id TEXT PRIMARY KEY,
      action_type TEXT NOT NULL CHECK(action_type IN ('revoke','quarantine','key_rotation','resolve_contradiction')),
      target_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      signer_public_key TEXT NOT NULL,
      signature TEXT NOT NULL,
      ttl INTEGER NOT NULL,
      hop_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_governance_signals_updated ON myr_governance_signals(updated_at DESC);
  `);
}

function canonicalSignal(signal) {
  return JSON.stringify({
    action_type: signal.action_type,
    target_id: signal.target_id,
    payload: signal.payload || {},
    signer_public_key: signal.signer_public_key,
    created_at: signal.created_at,
  });
}

function createGovernanceSignal({
  actionType,
  targetId,
  payload = {},
  signerPublicKey,
  signerPrivateKey,
  ttl = DEFAULT_GOVERNANCE_TTL,
  createdAt = null,
}) {
  if (!actionType || !targetId || !signerPublicKey || !signerPrivateKey) {
    throw new Error('actionType, targetId, signerPublicKey, signerPrivateKey are required');
  }

  const signal = {
    action_type: actionType,
    target_id: String(targetId),
    payload,
    signer_public_key: signerPublicKey,
    ttl: Math.max(0, Number(ttl) || 0),
    hop_count: 0,
    created_at: createdAt || new Date().toISOString(),
  };

  const canonical = canonicalSignal(signal);
  const signalId = crypto.createHash('sha256').update(canonical).digest('hex');
  const signature = sign(canonical, signerPrivateKey);

  return {
    signal_id: signalId,
    ...signal,
    signature,
    updated_at: signal.created_at,
  };
}

function verifyGovernanceSignal(signal) {
  if (!signal || !signal.signature || !signal.signer_public_key) return false;
  return verify(canonicalSignal(signal), signal.signature, signal.signer_public_key);
}

function forwardGovernanceSignal(signal, { forwardedAt = null } = {}) {
  const ttl = Math.max(0, Number(signal.ttl) - 1);
  return {
    ...signal,
    ttl,
    hop_count: Number(signal.hop_count || 0) + 1,
    updated_at: forwardedAt || new Date().toISOString(),
  };
}

function applyGovernanceSignal(db, signal) {
  if (signal.action_type === 'revoke') {
    db.prepare('UPDATE myr_peers SET trust_level = ? WHERE public_key = ?').run('revoked', signal.target_id);
    return { applied: true, action: 'revoke' };
  }

  if (signal.action_type === 'quarantine') {
    const now = new Date().toISOString();
    const payload = signal.payload || {};
    db.prepare(`
      INSERT INTO myr_quarantined_yields (
        yield_id, quarantined_at, quarantined_by, operator_signature, reason, status, metadata
      ) VALUES (?, ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(yield_id) DO UPDATE SET
        quarantined_at = excluded.quarantined_at,
        quarantined_by = excluded.quarantined_by,
        operator_signature = excluded.operator_signature,
        reason = excluded.reason,
        status = 'active',
        metadata = excluded.metadata
    `).run(
      signal.target_id,
      now,
      payload.quarantined_by || 'governance_gossip',
      signal.signature,
      payload.reason || null,
      JSON.stringify({ source: 'governance_gossip' })
    );
    return { applied: true, action: 'quarantine' };
  }

  return { applied: false, action: signal.action_type };
}

function ingestGovernanceSignal(db, signal, { applySignal = true } = {}) {
  ensureGovernanceGossipSchema(db);

  if (!verifyGovernanceSignal(signal)) {
    return { accepted: false, reason: 'invalid_signature' };
  }

  if (Number(signal.ttl) <= 0) {
    return { accepted: false, reason: 'ttl_expired' };
  }

  const existing = db.prepare('SELECT signal_id FROM myr_governance_signals WHERE signal_id = ?').get(signal.signal_id);
  if (existing) {
    return { accepted: false, reason: 'duplicate' };
  }

  db.prepare(`
    INSERT INTO myr_governance_signals (
      signal_id, action_type, target_id, payload, signer_public_key, signature,
      ttl, hop_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    signal.signal_id,
    signal.action_type,
    signal.target_id,
    JSON.stringify(signal.payload || {}),
    signal.signer_public_key,
    signal.signature,
    Number(signal.ttl),
    Number(signal.hop_count || 0),
    signal.created_at,
    signal.updated_at || signal.created_at
  );

  const applied = applySignal ? applyGovernanceSignal(db, signal) : { applied: false };
  const forward = Number(signal.ttl) > 1 ? forwardGovernanceSignal(signal) : null;
  return { accepted: true, applied, forward };
}

function listGovernanceSignals(db, { limit = 200 } = {}) {
  ensureGovernanceGossipSchema(db);
  const bounded = Math.max(1, Math.min(Number(limit) || 200, 2000));
  return db.prepare(`
    SELECT signal_id, action_type, target_id, payload, signer_public_key, signature, ttl, hop_count, created_at, updated_at
    FROM myr_governance_signals
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(bounded).map((row) => ({
    ...row,
    payload: JSON.parse(row.payload || '{}'),
  }));
}

module.exports = {
  DEFAULT_GOVERNANCE_TTL,
  ensureGovernanceGossipSchema,
  canonicalSignal,
  createGovernanceSignal,
  verifyGovernanceSignal,
  forwardGovernanceSignal,
  applyGovernanceSignal,
  ingestGovernanceSignal,
  listGovernanceSignals,
};
