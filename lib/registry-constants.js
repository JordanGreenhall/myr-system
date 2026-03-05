'use strict';

/**
 * MYR Network Registry Constants
 *
 * NETWORK_SIGNING_KEY_HEX: last 32 bytes (raw Ed25519 public key) of the
 * SPKI DER-encoded network signing public key. Nodes use this to verify
 * the signature on every registry and revocation file they fetch.
 *
 * To rotate: generate a new keypair with `node scripts/myr-registry-keygen.js`,
 * update this constant, and re-sign all registry files.
 */
const NETWORK_SIGNING_KEY_HEX = '8a4d163da50dcbdbc4e5b1f207ec3448ffa80071c7ced25f635b26cfe4a27bf0';

/**
 * GitHub raw URL for the signed node registry.
 */
const REGISTRY_URL = 'https://raw.githubusercontent.com/JordanGreenhall/myr-system/main/network/nodes.json';

/**
 * GitHub raw URL for the signed revocation list.
 */
const REVOCATION_URL = 'https://raw.githubusercontent.com/JordanGreenhall/myr-system/main/network/revoked.json';

module.exports = { NETWORK_SIGNING_KEY_HEX, REGISTRY_URL, REVOCATION_URL };
