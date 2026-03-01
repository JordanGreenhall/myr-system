# MYR Node Identity / Collision Fix Brief

**Date:** 2026-02-28  
**Priority:** High  
**Status:** Engineering brief — ready for implementation  
**Incident:** n1/n1 collision during Jared/Eitan cross-node exchange

---

## A. Root Cause Analysis

### Code-level

**`config.js` line 8:** `node_id` defaults to `'n1'`.  
Every fresh install that doesn't explicitly set `config.json` or `MYR_NODE_ID` gets the same identity. There is no enforcement anywhere that this default must be overridden before operating.

**`myr-import.js` lines 75–78:** Self-origin check is correct logic, wrong failure mode.
```js
if (peerNodeId === config.node_id) {
  counts.rejected++;
  reasons.push(`[${id}] node_id matches our own (${config.node_id})`);
  continue;
}
```
This fires *per artifact*, inside the loop, after processing has begun. There is no preflight that aborts cleanly before partial state is touched. It provides no remediation instructions.

**Artifact ID format:** IDs are `${node_id}-YYYYMMDD-NNN`. When both nodes are `n1`, the ID namespace is shared — `n1-20260227-001` exists on both nodes, so the duplicate check silently skips them instead of flagging the collision.

**`resolvePeerKey()`:** Falls back to loading `${nodeId}.public.pem` from the keys directory. When node_id collides, this loads *our own* public key and attempts to verify the peer's artifacts with it — failing cryptographically rather than surfacing the identity collision as root cause.

### Protocol-level

- Node identity is a mutable string with a dangerous default (`n1`) and no uniqueness enforcement
- No UUID or key-fingerprint anchor that survives node_id rename
- No preflight handshake asserting identity before exchange
- No binding between `node_id` string and public key fingerprint in peer registry
- Import is not atomic in failure mode — partial state (peer registration) can occur alongside rejections

---

## B. Fix Plan

### Fix 1: Block default node_id at operation boundaries (HIGH — prevents recurrence)

**In `config.js`:** Add a `validateConfig()` export. Call at top of every script.

```js
function validateConfig(config) {
  if (config.node_id === 'n1' && !process.env.MYR_NODE_ID) {
    console.error('ERROR: node_id is still the default "n1".');
    console.error('Set a unique node_id in config.json:');
    console.error('  { "node_id": "yourname-node", "node_name": "Your Name" }');
    console.error('Or: MYR_NODE_ID=yourname-node node scripts/myr-export.js ...');
    process.exit(1);
  }
}
```

### Fix 2: Add stable node_uuid at keygen (HIGH — future-proofs identity)

In `myr-keygen.js`: generate a UUID and write to `config.json`. This becomes the canonical identity anchor — immutable, globally unique.

Include `node_uuid` in `signature` block on export. On import: if `node_id` AND `node_uuid` both match local → definitive self-origin. If only `node_id` matches but `node_uuid` differs → label collision, two different nodes → explicit error.

### Fix 3: Import preflight — fail before loop, not inside it (HIGH — prevents partial corruption)

```js
function preflight(artifacts, localConfig) {
  const peerIds = new Set(artifacts.map(a => a.signature?.node_id).filter(Boolean));
  for (const peerId of peerIds) {
    if (peerId === localConfig.node_id) {
      console.error(`\nPREFLIGHT FAILED: Peer node_id "${peerId}" matches your local node_id.`);
      console.error('Identity collision. Resolve before importing.\n');
      console.error('Options:');
      console.error('  1. Ask peer to re-export with a unique node_id in their config.json');
      console.error('  2. Emergency override: MYR_NODE_ID=mynode node scripts/myr-import.js --file ...');
      console.error('     (override: verify peer key fingerprint manually)');
      process.exit(2);
    }
  }
}
```

Call before the artifact loop. No DB writes until preflight passes. Exit code 2 = identity failure.

### Fix 4: Peer registry key-binding check (MEDIUM)

When a `node_id` is already registered, verify the public key matches. Mismatch = key rotation or impersonation → abort with explicit error (exit 3).

### Fix 5: Artifact ID includes key fingerprint (LOW — deferred)

Future IDs: `${node_id}-${keyFingerprintShort}-${timestamp}-${counter}`. Schema migration required. Implement after Fixes 1–4.

---

## C. Guardrails Against Recurrence

| Guardrail | Where | Blocks |
|---|---|---|
| Refuse default `n1` at operation | All scripts | Unset node_id reaching exchange |
| UUID at keygen, checked at import | keygen + import | Silent same-label collisions |
| Import preflight | myr-import.js | Partial imports on collision |
| Key-binding check in peer registry | myr-import.js | Key mismatch / impersonation |
| `myr-identity` ceremony command | New script | Skipping pre-exchange verification |

**New command: `myr-identity.js`**

Prints a human-readable identity card:
```
Node identity:
  ID:          jared-node
  UUID:        f47ac10b-58cc-4372-a567-0e02b2c3d479
  Key:         SHA256:a3f8...c291
  Fingerprint: jared-node / f47ac10b / a3f8c291
```

Ceremony: both operators run `myr-identity` and verbally confirm fingerprints before sending packages. Collision is caught before exchange, not after.

---

## D. Remediation for the n1/n1 Incident

### Their node (Jared/Eitan)
1. Set unique `node_id` in their `config.json` (e.g., `"jared-node"`)
2. Rename keys: `n1.private.pem` → `jared-node.private.pem`, same for public
3. Re-export: `node scripts/myr-export.js --all`
4. Send new package

### Our node
1. Set explicit `node_id` in our `config.json` (e.g., `"jordan-node"`)
2. Import their new package normally — no override needed

### The 2 skipped duplicates (`n1-20260227-001`, `n1-20260227-002`)
These are our local records. After Jared re-exports under `jared-node`, those artifacts will have new IDs and import cleanly. No data was corrupted.

The 8 already-imported artifacts (via `MYR_NODE_ID=n2` override) are valid. Their `imported_from` field reads `n1` which is now ambiguous. Optional repair after confirming Jared's new node_id:
```sql
UPDATE myr_reports SET imported_from = 'jared-node' 
WHERE imported_from = 'n1' AND import_verified = 1;
```

---

## E. Test Plan

**Test 1: Default node_id blocked**
```bash
# config.json has node_id = "n1" (default)
node scripts/myr-export.js --all
# Expected: error + instructions, exit 1
```

**Test 2: Preflight catches collision**
```bash
# Local node_id = "alice"; import package from node_id = "alice"
node scripts/myr-import.js --file alice-export.myr.json
# Expected: PREFLIGHT FAILED, exit 2, zero DB writes
```

**Test 3: Clean two-node exchange**
```bash
# alice-node exports → bob-node imports → 0 rejected, 0 skipped
# bob-node exports → alice-node imports → 0 rejected, 0 skipped
```

**Test 4: Key mismatch on re-import**
```bash
# "alice-node" registered with key K1; re-import with key K2
# Expected: WARNING + exit 3
```

**Test 5: Duplicate import is explicit, not silent**
```bash
# Import same package twice
# Expected: first = N accepted; second = N skipped with reasons listed
```

---

## Implementation Order

1. **Fix 1** — block default n1 — ~30 min, zero risk
2. **Fix 3** — preflight — ~1 hr
3. **Fix 4** — key binding — ~1 hr
4. **Fix 2** — node_uuid at keygen — ~2 hr (schema update)
5. **`myr-identity` command** — ~1 hr
6. **Fix 5** — ID namespace — deferred

**Total for 1–5: ~6 hours.**

---

## Summary

Root cause: `node_id = 'n1'` default with no enforcement. Fixes 1 and 3 together eliminate the incident class. Fixes 2 and 4 harden against future identity ambiguity. Cryptography (Ed25519) is working correctly — this is purely an identity namespace problem.
