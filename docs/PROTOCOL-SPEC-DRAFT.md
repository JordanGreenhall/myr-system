# MYR Network Protocol — Draft Specification

**Status:** Design draft  
**Date:** 2026-02-26  
**Author:** Polemarch  

---

## Design Principles

1. **Protocol over transport.** The protocol is the permanent layer. Transports are disposable adapters.
2. **Envelope and identity are the hardest to change.** Get them right first.
3. **Works with 2 nodes today, scales to many.** Simple transports now, hardened transports later — same protocol.
4. **Self-authenticating messages.** Every message carries its own proof of origin and integrity. No trust in the transport.
5. **Evolvable.** Version fields everywhere. Unknown fields are ignored, not rejected.

---

## 1. Identity

### 1.1 Node Identity

A node is a keypair. Nothing else is required to exist.

```
node_id:        Short human-readable alias (e.g. "n1", "north-star")
public_key:     Ed25519 public key (base64)
private_key:    Ed25519 private key (never leaves the node)
created_at:     ISO 8601 timestamp
```

The `node_id` is a local convenience. The **public key is the canonical identity.** Two nodes could use the same `node_id` — the public key disambiguates. Protocol-level addressing uses key fingerprints, not node_ids.

### 1.2 Key Fingerprint

```
fingerprint = base64url(sha256(public_key_raw_bytes))
```

32 bytes, URL-safe base64. This is the stable identifier used in envelopes, peer lists, and addressing. Short enough to display, long enough to be collision-resistant.

### 1.3 Identity Document

A node publishes an **identity document** — a signed, self-certifying blob:

```json
{
  "v": 1,
  "type": "identity",
  "fingerprint": "<base64url sha256 of public key>",
  "node_id": "n1",
  "public_key": "<base64 Ed25519 public key>",
  "name": "Optional human-readable name",
  "created_at": "2026-02-26T10:00:00Z",
  "capabilities": ["myr-v1"],
  "signature": "<base64 Ed25519 signature of all fields above>"
}
```

**Capabilities** declare what protocol versions/extensions the node supports. Starts with `myr-v1`. Future extensions (encrypted messaging, relay, synthesis coordination) add capability tags.

The identity document is the first thing exchanged. It's not secret — it can be posted publicly, sent over any channel, embedded in a QR code.

---

## 2. Envelope

### 2.1 Cleartext Envelope (Phase 1 — now)

Every protocol message is wrapped in an envelope:

```json
{
  "v": 1,
  "type": "<message type>",
  "id": "<uuid v4>",
  "from": "<sender fingerprint>",
  "to": "<recipient fingerprint | '*' for broadcast>",
  "timestamp": "2026-02-26T15:00:00Z",
  "payload": { ... },
  "signature": "<base64 Ed25519 signature over canonical(v + type + id + from + to + timestamp + payload)>"
}
```

**Message types (Phase 1):**

| type | purpose |
|------|---------|
| `identity` | Node identity document (§1.3) |
| `yield` | One or more signed MYR artifacts |
| `ping` | Liveness check |
| `pong` | Liveness response |
| `peer-request` | Request to establish peer relationship |
| `peer-accept` | Accept peer relationship |
| `peer-list` | Share known peer fingerprints |

**Rules:**
- `v` is always present. Receivers ignore envelopes with `v` they don't understand.
- Unknown `type` values are ignored, not rejected.
- Unknown fields in `payload` are preserved, not stripped. (Forward compatibility.)
- `signature` covers the canonical JSON serialization (sorted keys, no whitespace) of all fields except `signature` itself.

### 2.2 Encrypted Envelope (Phase 2 — designed now, built later)

When non-monitorable properties are needed, the cleartext envelope is wrapped:

```json
{
  "v": 1,
  "type": "encrypted",
  "id": "<uuid v4>",
  "from": "<sender fingerprint | null for anonymous>",
  "to": "<recipient fingerprint>",
  "timestamp": "2026-02-26T15:00:00Z",
  "encryption": {
    "algorithm": "x25519-xsalsa20-poly1305",
    "ephemeral_public_key": "<base64>",
    "nonce": "<base64>"
  },
  "ciphertext": "<base64 encrypted inner envelope>",
  "signature": "<base64 — optional, omit for anonymous sends>"
}
```

**Key exchange:** Ed25519 keys are converted to X25519 for Diffie-Hellman. This is a standard, well-supported conversion (libsodium `crypto_sign_ed25519_pk_to_curve25519`).

**Anonymous sends:** `from` can be null. The inner envelope (decrypted by recipient) contains the real sender identity. Intermediaries see only the recipient fingerprint.

---

## 3. Trust Establishment

### 3.1 Peer Introduction

Two nodes become peers through a handshake:

```
Node A                          Node B
  |                               |
  |--- identity ----------------->|  (A sends identity doc)
  |<-- identity -------------------|  (B sends identity doc)
  |                               |
  |--- peer-request ------------->|  (A proposes peering)
  |    payload: {                 |
  |      "reason": "free text",  |
  |      "proof": [myr_ids...]   |  (optional: MYR IDs to prove yield)
  |    }                          |
  |                               |
  |<-- peer-accept ---------------|  (B accepts — or silence = reject)
  |    payload: {                 |
  |      "proof": [myr_ids...]   |
  |    }                          |
  |                               |
  [peers established]             |
```

**This handshake can happen over any transport.** Two people in a room exchanging QR codes. Two agents exchanging messages over Signal. A git commit. The protocol doesn't care.

### 3.2 Trust Gate

From DESIGN.md: a node must present ≥10 MYRs with Jordan-verified average rating ≥3.0 before receiving cross-node yield.

In protocol terms: the `peer-request` includes `proof` — a list of MYR IDs. The receiving node can request the actual MYR artifacts to verify. Trust is established by the **quality of yield**, not by identity alone.

This is evolvable. Today, Jordan manually verifies. Later, verification could be algorithmic, reputation-based, or vouched by trusted peers.

### 3.3 Peer State

Each node maintains a peer list:

```json
{
  "fingerprint": "<peer fingerprint>",
  "node_id": "n2",
  "public_key": "<base64>",
  "status": "active | pending | revoked",
  "established_at": "2026-02-26T15:00:00Z",
  "last_seen": "2026-02-26T16:00:00Z",
  "transports": ["signal", "git"]
}
```

`transports` records which transport bindings have worked with this peer. Used for fallback routing.

---

## 4. Yield Exchange

### 4.1 Yield Message

```json
{
  "v": 1,
  "type": "yield",
  "id": "<uuid>",
  "from": "<fingerprint>",
  "to": "<fingerprint | '*'>",
  "timestamp": "...",
  "payload": {
    "artifacts": [
      {
        "version": "1",
        "artifact_type": "myr",
        "payload": { ... },
        "signature": { ... }
      }
    ],
    "request_synthesis": false
  },
  "signature": "..."
}
```

The inner artifact signatures (Ed25519 over the MYR payload) are **independent** of the envelope signature. This means:

- An artifact can be re-enveloped and forwarded without losing its original proof of origin
- A relay node can carry artifacts it can't read (encrypted) or verify (unknown origin) — the recipient verifies
- Artifacts are the canonical unit; envelopes are disposable wrappers

### 4.2 Export Gate (unchanged)

Only Jordan-verified MYRs (rating ≥ 3) are included in yield messages. Auto-drafts never leave the node. This is enforced at the sender, not the protocol — the protocol will carry anything, but the node's export policy filters.

---

## 5. Transport Binding

### 5.1 Contract

A transport binding is a thin adapter with exactly three operations:

```
send(envelope_bytes, recipient_fingerprint) → success | failure
receive() → envelope_bytes
available() → boolean
```

That's it. The binding doesn't parse envelopes, validate signatures, or make routing decisions. It moves opaque bytes. The protocol layer does everything else.

### 5.2 Phase 1 Bindings (simple, sufficient for 2 nodes)

**Git binding:**
- `send`: write envelope JSON to `outbox/{recipient_fingerprint}/{uuid}.json`, commit, push
- `receive`: poll `inbox/` for new files, read, delete after processing
- `available`: `git remote -v` succeeds

**File binding:**
- `send`: write envelope JSON to a directory (USB drive, shared folder, airdrop)
- `receive`: watch directory for new files
- `available`: directory exists and is writable

**Signal/messaging binding:**
- `send`: send envelope JSON as a message (via Signal CLI, Telegram API, etc.)
- `receive`: poll for new messages, extract envelope JSON
- `available`: messaging CLI is configured

### 5.3 Phase 2+ Bindings (hardened, built later)

- **Tor hidden service** — node runs a hidden service, peers connect directly. Non-monitorable.
- **Nostr relays** — publish envelopes as nostr events. Multiple relays = uninterruptible.
- **Mixnet** — messages routed through mixing nodes with delay. Non-capturable timing.
- **Bluetooth/LAN** — local mesh for physically proximate nodes.

Each binding is <100 lines. The protocol never changes.

---

## 6. Addressing & Routing (designed now, built Phase 2+)

### 6.1 Direct Addressing

`to: "<fingerprint>"` — the sender knows the recipient and has a transport binding that can reach them.

Sufficient for Phase 1.

### 6.2 Relay Addressing (Phase 2+)

When direct transport isn't available, messages can be relayed:

```json
{
  "v": 1,
  "type": "relay",
  "id": "<uuid>",
  "from": "<sender fingerprint>",
  "to": "<relay node fingerprint>",
  "payload": {
    "inner": "<encrypted envelope, addressed to final recipient>",
    "ttl": 3
  },
  "signature": "..."
}
```

The relay node sees `from` (the sender) and the encrypted inner blob addressed to someone else. It forwards the inner blob using its own transport bindings. It cannot read the content (encrypted) or see who the final recipient is (if the inner envelope uses anonymous sending).

`ttl` decrements at each hop. Prevents infinite relay loops.

---

## 7. Versioning & Evolution

- Every message has `v: 1`. Increment on breaking changes.
- `capabilities` in identity documents declare supported extensions.
- Unknown fields are preserved, never stripped.
- New message types can be added without version bump (receivers ignore unknown types).
- Transport bindings are added/removed without protocol changes.

**What's frozen after Phase 1 ships:**
- Envelope structure (v, type, id, from, to, timestamp, payload, signature)
- Identity document structure
- Fingerprint derivation (sha256 of public key bytes, base64url)
- Signature scheme (Ed25519 over canonical JSON)

**What can evolve freely:**
- Message types
- Payload schemas within types
- Transport bindings
- Trust gate thresholds
- Encryption algorithms (negotiated via capabilities)

---

## Implementation Phases

### Phase 1 (now): 2 nodes, simple transport
- Identity document generation
- Envelope creation and verification
- Peer handshake (manual — exchange identity docs, send peer-request/accept)
- Yield exchange over git or file binding
- All cleartext (no encryption needed between 2 trusted nodes)

### Phase 2 (when 3+ nodes): encrypted envelopes, multiple transports
- X25519 encryption layer
- Signal and/or Nostr transport bindings
- Relay addressing
- Peer discovery via peer-list sharing

### Phase 3 (adversarial environment): full hardening
- Anonymous sending
- Mixnet or onion routing
- Tor hidden service binding
- Transport multiplexing (same message, multiple paths)
- Timing obfuscation

---

*The protocol is the permanent layer. Everything else is disposable.*
