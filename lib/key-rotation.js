'use strict';

const crypto = require('crypto');
const { generateKeypair, sign, verify } = require('./crypto');

function canonicalRotation(announcement) {
  return JSON.stringify({
    node_id: announcement.node_id,
    old_public_key: announcement.old_public_key,
    new_public_key: announcement.new_public_key,
    rotated_at: announcement.rotated_at,
  });
}

function createKeyRotationAnnouncement({ nodeId, oldPublicKey, oldPrivateKey, newPublicKey, rotatedAt = null }) {
  if (!nodeId || !oldPublicKey || !oldPrivateKey || !newPublicKey) {
    throw new Error('nodeId, oldPublicKey, oldPrivateKey, and newPublicKey are required');
  }

  const announcement = {
    id: crypto.randomUUID(),
    node_id: nodeId,
    old_public_key: oldPublicKey,
    new_public_key: newPublicKey,
    rotated_at: rotatedAt || new Date().toISOString(),
  };

  const endorsement = sign(canonicalRotation(announcement), oldPrivateKey);
  return {
    ...announcement,
    endorsement_signature: endorsement,
  };
}

function verifyKeyRotationAnnouncement(announcement) {
  if (!announcement || !announcement.endorsement_signature || !announcement.old_public_key) {
    return false;
  }
  return verify(
    canonicalRotation(announcement),
    announcement.endorsement_signature,
    announcement.old_public_key
  );
}

function applyKeyRotation({ registry, announcement }) {
  if (!verifyKeyRotationAnnouncement(announcement)) {
    throw new Error('Invalid key rotation announcement signature');
  }

  if (!Array.isArray(registry)) {
    throw new Error('registry must be an array of node records');
  }

  const idx = registry.findIndex((entry) => entry.node_id === announcement.node_id);
  if (idx === -1) {
    throw new Error(`Node not found in registry: ${announcement.node_id}`);
  }

  const current = registry[idx];
  if (current.public_key !== announcement.old_public_key) {
    throw new Error('Old key does not match registry record');
  }

  const updated = {
    ...current,
    public_key: announcement.new_public_key,
    rotated_at: announcement.rotated_at,
    previous_public_key: announcement.old_public_key,
  };
  registry[idx] = updated;

  return updated;
}

function rotateNodeKeypair({ nodeId, oldPublicKey, oldPrivateKey }) {
  const next = generateKeypair();
  const announcement = createKeyRotationAnnouncement({
    nodeId,
    oldPublicKey,
    oldPrivateKey,
    newPublicKey: next.publicKey,
  });

  return {
    newKeypair: next,
    announcement,
  };
}

module.exports = {
  canonicalRotation,
  createKeyRotationAnnouncement,
  verifyKeyRotationAnnouncement,
  applyKeyRotation,
  rotateNodeKeypair,
};
