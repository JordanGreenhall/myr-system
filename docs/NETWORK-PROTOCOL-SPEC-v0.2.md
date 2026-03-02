# MYR Network Protocol Specification v0.2

**Status:** DRAFT  
**Author:** Polemarch  
**Date:** 2026-03-02  
**Review:** Requested  
**Changes from v0.1:** Security model, wire formats, terminology fix (mirror→report), Component 4 deferred

## Problem Statement

The current MYR system requires manual node handoff via email:
1. Exchange public keys manually
2. Email MYR report packages as attachments
3. Manually move files to appropriate directories
4. Repeat for every peer relationship

**This doesn't scale.** With 3 nodes (us, Gary, Jared) it barely works. At 10+ nodes it becomes unmanageable.

## Design Principles

1. **Zero manual email** - all node communication happens in-protocol
2. **Automatic peer discovery** - adding a peer should be one command
3. **Self-organizing trust network** - nodes sync reports from trusted peers automatically
4. **Security first** - authentication, signature verification, replay protection, rate limiting
5. **Fail-safe** - untrusted/unverified reports never auto-import

## Scope

This specification covers **protocol layer only**:
- Node discovery and capability negotiation
- Peer relationship management
- MYR report synchronization
- Trust model and security

**Out of scope for this spec:**
- How agents consume network intelligence (deferred to separate Operations Integration spec)
- Application-layer behavior
- Agent startup hooks or gateway integration

## Architecture Overview

```
┌─────────────────┐         ┌─────────────────┐
│   MYR Node A    │◄───────►│   MYR Node B    │
│                 │  HTTPS   │                 │
│ ┌─────────────┐ │         │ ┌─────────────┐ │
│ │ HTTP Server │ │         │ │ HTTP Server │ │
│ │  + Ed25519  │ │         │ │  + Ed25519  │ │
│ │  Auth       │ │         │ │  Auth       │ │
│ └─────────────┘ │         │ └─────────────┘ │
│ ┌─────────────┐ │         │ ┌─────────────┐ │
│ │  SQLite DB  │ │         │ │  SQLite DB  │ │
│ │  + Reports  │ │         │ │  + Reports  │ │
│ └─────────────┘ │         │ └─────────────┘ │
│ ┌─────────────┐ │         │ ┌─────────────┐ │
│ │ Sync Agent  │ │         │ │ Sync Agent  │ │
│ │  (cron)     │ │         │ │  (cron)     │ │
│ └─────────────┘ │         │ └─────────────┘ │
└─────────────────┘         └─────────────────┘
        │                           │
        └───────────┬───────────────┘
                    │
            ┌───────▼────────┐
            │  Trust Network │
            │   (peer list)  │
            └────────────────┘
```

## Component 1: MYR Node HTTP Server

Each MYR node runs a lightweight HTTPS server exposing the MYR protocol API.

### Configuration

```javascript
// myr-config.json
{
  "node_url": "https://jordan.myr.network",  // Public endpoint for this node
  "port": 3719,                              // Local server port (default: 3719)
  "operator_name": "jordan",                 // Human-readable operator ID
  "auto_sync_interval": "1h",                // How often to pull from peers (min: 15m)
  "keypair_path": "~/.myr/keys/node.key"     // Ed25519 keypair for signing/auth
}
```

### Authentication

**All endpoints require authenticated requests** using Ed25519 signature authentication.

**Request signing:**
```
1. Construct canonical request string:
   METHOD\n
   PATH\n
   TIMESTAMP\n
   NONCE\n
   BODY_SHA256

2. Sign with Ed25519 private key
3. Include headers:
   X-MYR-Timestamp: <ISO8601 timestamp>
   X-MYR-Nonce: <random 32-byte hex string>
   X-MYR-Signature: <hex-encoded Ed25519 signature>
   X-MYR-Public-Key: <hex-encoded Ed25519 public key>
```

**Server verification:**
```
1. Reject if timestamp is >5 minutes old (replay protection)
2. Reject if nonce seen before (within 10-minute window)
3. Verify signature against provided public key
4. Check if public key belongs to known peer (for peer-restricted endpoints)
```

**Rate limiting (enforced server-side):**
- 60 requests/minute per peer
- 429 Too Many Requests if exceeded

### API Endpoints

#### `GET /.well-known/myr-node`

**Purpose:** Node discovery and capability negotiation

**Authentication:** Public endpoint (no auth required)

**Response:**
```json
{
  "protocol_version": "0.2.0",
  "node_url": "https://jordan.myr.network",
  "operator_name": "jordan",
  "public_key": "a1b2c3d4...",  // Hex-encoded Ed25519 public key (64 chars)
  "supported_features": ["report-sync", "peer-discovery"],
  "created_at": "2026-03-01T10:00:00Z",
  "rate_limits": {
    "requests_per_minute": 60,
    "min_sync_interval_minutes": 15
  }
}
```

**Error responses:**
```json
// 500 Internal Server Error
{
  "error": {
    "code": "internal_error",
    "message": "Node configuration invalid",
    "details": "Missing operator_name in config"
  }
}
```

#### `GET /myr/reports`

**Purpose:** List available MYR reports from this node

**Authentication:** Required (must be known peer)

**Query params:**
- `cursor=<base64_cursor>` - pagination cursor (encodes `created_at` + `signature`)
- `limit=<int>` - max results (default 100, max 500)

**Response:**
```json
{
  "reports": [
    {
      "signature": "sha256:abc123...",
      "operator_name": "jordan",
      "created_at": "2026-03-02T09:00:00Z",
      "method_name": "myr-system node handoff",
      "operator_rating": 3,
      "size_bytes": 4523,
      "url": "/myr/reports/sha256:abc123..."
    }
  ],
  "next_cursor": "MjAyNi0wMy0wMlQwOTowMDowMFo6c2hhMjU2OmFiYzEyMy4uLg==",
  "has_more": true
}
```

**Pagination contract:**
- Cursor-based (not offset-based)
- Cursor encodes `created_at` + `signature` (lexicographically sortable)
- Results ordered by `created_at ASC, signature ASC`
- If `has_more: true`, use `next_cursor` for next page
- Cursor valid for 1 hour

**Error responses:**
```json
// 401 Unauthorized
{
  "error": {
    "code": "auth_required",
    "message": "Missing or invalid authentication headers"
  }
}

// 403 Forbidden
{
  "error": {
    "code": "unknown_peer",
    "message": "Your public key is not in our peer list"
  }
}

// 429 Too Many Requests
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "60 requests/minute limit exceeded",
    "retry_after_seconds": 42
  }
}
```

#### `GET /myr/reports/<signature>`

**Purpose:** Fetch a specific MYR report

**Authentication:** Required (must be known peer)

**Response:** MYR report object (see Wire Format section below)

**Headers:**
- `X-MYR-Signature: <hex>` - Ed25519 signature of response body (see Signature Verification)
- `Content-Type: application/json`

**Error responses:**
```json
// 404 Not Found
{
  "error": {
    "code": "report_not_found",
    "message": "No report with signature sha256:xyz789..."
  }
}
```

#### `POST /myr/peers/announce`

**Purpose:** Request peer relationship with this node

**Authentication:** Required (but public key need not be known peer)

**Request body:**
```json
{
  "peer_url": "https://gary.myr.network",
  "public_key": "e5f6g7h8...",  // Hex-encoded Ed25519 public key
  "operator_name": "gary",
  "timestamp": "2026-03-02T10:00:00Z",
  "nonce": "a1b2c3d4e5f6..."
}
```

**Replay protection:** Server MUST reject if:
- `timestamp` is >5 minutes old
- `nonce` seen before (within 10-minute window)

**Response:**
```json
{
  "status": "pending_approval",  // ALWAYS pending (no auto-accept)
  "our_public_key": "i9j0k1l2...",
  "message": "Peer request received. Awaiting operator approval.",
  "approval_required": true
}
```

**Note:** This endpoint ALWAYS returns `pending_approval`. There is no automatic trust establishment. The receiving node's operator must manually approve via `myr approve-peer <public_key>`.

**Error responses:**
```json
// 400 Bad Request
{
  "error": {
    "code": "invalid_request",
    "message": "Missing required field: peer_url"
  }
}

// 409 Conflict
{
  "error": {
    "code": "peer_exists",
    "message": "Peer relationship already exists with this public key"
  }
}
```

## Wire Formats

### MYR Report Object

**Complete JSON schema for a MYR report:**

```json
{
  "schema_version": "1.0",
  "signature": "sha256:abc123...",  // SHA-256 of canonical JSON (see below)
  "operator_name": "jordan",
  "created_at": "2026-03-02T09:00:00Z",
  "method_name": "myr-system node handoff",
  "method_context": {
    "goal": "Add Gary as peer node",
    "approach": "Manual email + file exchange",
    "environment": "3-node network"
  },
  "observations": [
    "Key exchange fragile - lost public key twice",
    "Email attachments require manual file moves",
    "No confirmation of successful import"
  ],
  "decision": "Automate peer handoff via HTTP protocol",
  "actions_taken": [
    "Drafted network protocol specification",
    "Proposed HTTP API for key exchange and report sync"
  ],
  "operator_rating": 2,
  "operator_notes": "Manual process doesn't scale beyond 3 nodes",
  "metadata": {
    "session_id": "abc-123",
    "agent_name": "polemarch",
    "model_used": "claude-sonnet-4-5",
    "tokens_used": 45000
  },
  "operator_signature": "d1e2f3g4...",  // Ed25519 signature by operator
  "share_network": true  // Whether this report should be shared via HTTP API
}
```

**Field definitions:**

- `schema_version`: Wire format version (current: "1.0")
- `signature`: SHA-256 hash of canonical JSON (for deduplication and referencing)
- `operator_name`: Human-readable operator identifier
- `created_at`: ISO8601 timestamp
- `method_name`: Human-readable task/method name
- `method_context`: Structured context about the task
- `observations`: Array of observed facts/issues
- `decision`: What the operator decided
- `actions_taken`: Array of actions executed
- `operator_rating`: Integer 1-5 (1=failed badly, 5=worked excellently)
- `operator_notes`: Free-form operator commentary
- `metadata`: Optional structured metadata
- `operator_signature`: Ed25519 signature of this report by operator (proves authorship)
- `share_network`: Boolean - if false, not shared via `/myr/reports` endpoint

**Rating semantics:**
- **5**: Worked excellently, highly recommended
- **4**: Worked well, minor issues
- **3**: Worked acceptably, some concerns
- **2**: Worked poorly, significant issues
- **1**: Failed badly, do not repeat

### Canonical JSON Serialization

To ensure consistent signatures, all MYR reports MUST be serialized using **canonical JSON**:

1. **Key ordering:** Alphabetical (lexicographic) by key name at all nesting levels
2. **Whitespace:** None - no spaces, no newlines
3. **Encoding:** UTF-8

**Implementation:** Use RFC 8785 (JSON Canonicalization Scheme) or equivalent.

**Example:**
```javascript
// Before canonicalization (readable)
{
  "operator_name": "jordan",
  "created_at": "2026-03-02T09:00:00Z",
  "method_name": "test"
}

// After canonicalization (canonical form for hashing/signing)
{"created_at":"2026-03-02T09:00:00Z","method_name":"test","operator_name":"jordan"}
```

**Signature algorithm:**
```
1. Serialize report to canonical JSON
2. Compute SHA-256 hash → signature field
3. Sign canonical JSON with Ed25519 operator private key → operator_signature field
```

### Error Response Format

All error responses follow this structure:

```json
{
  "error": {
    "code": "machine_readable_code",
    "message": "Human-readable error message",
    "details": "Optional additional context",
    "retry_after_seconds": 60  // Optional, for rate limiting
  }
}
```

**Standard error codes:**
- `auth_required` (401): Missing or invalid authentication
- `forbidden` (403): Valid auth but action not permitted
- `unknown_peer` (403): Public key not in peer list
- `not_found` (404): Resource doesn't exist
- `invalid_request` (400): Malformed request body/params
- `conflict` (409): Resource already exists
- `rate_limit_exceeded` (429): Too many requests
- `internal_error` (500): Server-side failure

## Component 2: Peer Discovery and Trust

### Trust Model: TOFU (Trust On First Use)

When adding a peer via `myr add-peer <url>`:

1. **First contact:** Fetch `/.well-known/myr-node` over HTTPS
2. **Key binding:** Store the public key returned in that response
3. **Trust assumption:** Assume that public key belongs to the legitimate operator (TOFU)
4. **Persistent binding:** All future communication with that peer MUST use the same public key

**Security note:** This is vulnerable to MITM on first contact. Operators SHOULD verify key fingerprints out-of-band (e.g., via Signal message, phone call) after adding a peer.

**Key fingerprint format:**
```
SHA-256: a1b2:c3d4:e5f6:g7h8:i9j0:k1l2:m3n4:o5p6
```

**CLI for verification:**
```bash
# Show our key fingerprint (for sharing with peers)
myr fingerprint

# Compare peer's fingerprint
myr peer-fingerprint gary
```

### Adding a Peer (Manual Bootstrap)

```bash
# Add Gary's node as a peer
myr add-peer https://gary.myr.network

# What happens:
# 1. Fetch https://gary.myr.network/.well-known/myr-node (unauthenticated)
# 2. Store Gary's public key in peers table (trust_level='pending')
# 3. POST our info to Gary's /myr/peers/announce (authenticated with our key)
# 4. Gary's node receives our request → stores as pending approval
# 5. Both operators approve manually:
#    - We run: myr approve-peer <gary_public_key>
#    - Gary runs: myr approve-peer <our_public_key>
# 6. Sync becomes active after mutual approval
```

### Peer Database Schema

```sql
CREATE TABLE myr_peers (
  id INTEGER PRIMARY KEY,
  peer_url TEXT UNIQUE NOT NULL,
  operator_name TEXT NOT NULL,
  public_key TEXT UNIQUE NOT NULL,  -- Hex-encoded Ed25519 public key
  trust_level TEXT CHECK(trust_level IN ('trusted', 'pending', 'rejected')) DEFAULT 'pending',
  added_at TEXT NOT NULL,
  approved_at TEXT,  -- When operator approved this peer
  last_sync_at TEXT,
  auto_sync BOOLEAN DEFAULT 1,
  notes TEXT
);

-- Nonce tracking for replay protection
CREATE TABLE myr_nonces (
  nonce TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_nonces_expires ON myr_nonces(expires_at);
```

### Trust Levels

- **trusted** - operator has approved; automatically sync and import reports
- **pending** - peer relationship requested but not yet approved by operator
- **rejected** - operator explicitly rejected this peer; no sync

**Note:** There is no "provisional" level in v0.2. Either you trust a peer (import their reports) or you don't. Future versions may add granular trust levels.

## Component 3: Automatic Report Sync

### Sync Agent (Cron Job)

Runs every `auto_sync_interval` (default: 1 hour, minimum: 15 minutes)

**Algorithm:**
```
FOR EACH peer WHERE auto_sync=true AND trust_level='trusted':
  1. Authenticate request with our Ed25519 key
  2. GET /myr/reports (cursor-based pagination)
  3. FOR EACH report in response:
     a. Check if we already have this report (by signature)
     b. If new:
        i.   Verify operator_signature against peer's public key
        ii.  If valid: import to local database (mark source_peer=<peer_name>)
        iii. If invalid: log security warning, skip import
     c. Continue pagination if has_more=true
  4. Update peer.last_sync_at
  5. Clean up old nonces (DELETE FROM myr_nonces WHERE expires_at < NOW())
```

**Deduplication:** If the same report arrives from multiple peers (same `signature`), keep only one copy but record all source peers in metadata.

**Conflict resolution:** If same task/method but different reports from multiple peers:
- Store both
- Surface both to operator (don't auto-resolve)
- Trust the operator to evaluate which is more relevant

### CLI Commands

```bash
# Manual sync with specific peer
myr sync gary

# Manual sync with all trusted peers
myr sync --all

# Add peer (initiates bootstrap)
myr add-peer https://gary.myr.network

# Approve pending peer
myr approve-peer e5f6g7h8...  # public key

# Reject pending peer
myr reject-peer e5f6g7h8...

# List peers with status
myr peers

# Show our key fingerprint
myr fingerprint

# Show peer's key fingerprint
myr peer-fingerprint gary

# Check sync status
myr sync-status
```

## Security Considerations

### Signature Verification

All reports from network peers MUST be cryptographically signed and verified:

1. **Signing (origin node):**
   ```
   canonical_json = canonicalize(report)
   signature = SHA256(canonical_json)
   operator_signature = Ed25519.sign(canonical_json, operator_private_key)
   ```

2. **Verification (receiving node):**
   ```
   canonical_json = canonicalize(received_report)
   computed_sig = SHA256(canonical_json)
   
   IF computed_sig != received_report.signature:
     REJECT (integrity violation)
   
   IF NOT Ed25519.verify(canonical_json, received_report.operator_signature, peer_public_key):
     REJECT (authentication failure)
   
   IMPORT report
   ```

3. **Fail closed:** Invalid signatures → reject report, log security event, do NOT import

### Authentication

- **All endpoints** (except `/.well-known/myr-node`) require Ed25519 signed requests
- **Replay protection:** Timestamp must be <5 minutes old, nonce must be unique
- **Rate limiting:** 60 requests/minute per peer (server-enforced)
- **Unknown peers:** Requests from unknown public keys are rejected (except `/myr/peers/announce`)

### Privacy

- **Operator controls sharing:** Reports are only shared via HTTP endpoint if `share_network=true`
- **No automatic rebroadcast:** Nodes don't re-share other nodes' reports
- **Selective import:** Operators approve peers before any reports are imported
- **Trust is explicit:** No transitive trust, no web-of-trust, no auto-accept

### Revocation

**Note:** v0.2 does not include report revocation. Once a report is shared and imported, there's no mechanism to revoke it. This is a known limitation.

**Mitigation:** Operators can:
- Update a report with new information (new `signature`, references old report)
- Share a correcting report ("previous report about X was incorrect because Y")
- Manually delete reports from their local database

**Future:** v0.3+ may add `DELETE /myr/reports/<signature>` with propagation to peers.

## Migration Path

### Phase 1: HTTP Server (v0.2.0)
- Implement MYR node HTTP server with Ed25519 authentication
- `/.well-known/myr-node` endpoint
- `/myr/reports` listing endpoint (with pagination)
- `/myr/reports/<signature>` fetch endpoint
- `/myr/peers/announce` endpoint
- Canonical JSON serialization
- Signature verification
- Rate limiting

### Phase 2: Peer Management (v0.3.0)
- `myr add-peer` command
- Peer database schema
- `myr approve-peer` / `myr reject-peer` commands
- `myr fingerprint` verification
- Manual sync: `myr sync <peer>`

### Phase 3: Auto-Sync (v0.4.0)
- Sync agent cron job
- Automatic report import from trusted peers
- Nonce-based replay protection
- Deduplication and conflict detection

### Phase 4: Operations Integration (v0.5.0+)
- Deferred to separate specification
- How agents consume network intelligence
- Pre-execution warning hooks
- Memory search integration
- Gateway routing hints

## Open Questions

1. **NAT traversal:** How do home network nodes expose HTTP endpoints? (Cloudflare Tunnel recommended)
2. **TLS certificates:** Self-signed vs Let's Encrypt? How to bootstrap trust?
3. **Report TTL:** Should old reports be archived or deleted after N days? (Suggest: archive after 90 days, don't delete)
4. **Versioning strategy:** How to handle protocol version mismatches? (Suggest: major version must match)
5. **Discovery mechanism:** Beyond manual `add-peer`, do we need a registry/DHT? (Not for v0.2)

## Success Criteria

After Phase 3 implementation, the workflow should be:

```bash
# Add a peer (one-time setup, mutual approval required)
myr add-peer https://gary.myr.network
# (Wait for Gary to approve us on his side)
myr approve-peer <gary_public_key>

# Verify fingerprint out-of-band (via Signal/phone)
myr peer-fingerprint gary
# Compare with Gary's reported fingerprint

# That's it. System now:
# - Automatically syncs Gary's reports every hour
# - Verifies all signatures
# - Imports trusted reports to local database
# - Deduplicates across multiple peer paths
```

**Zero manual email. Zero file shuffling. Secure, authenticated, automatic sync.**

---

## Appendix A: Example Request/Response

### Adding a peer

```bash
# Step 1: Fetch node info (unauthenticated)
curl https://gary.myr.network/.well-known/myr-node

# Response:
{
  "protocol_version": "0.2.0",
  "node_url": "https://gary.myr.network",
  "operator_name": "gary",
  "public_key": "e5f6g7h8...",
  "supported_features": ["report-sync", "peer-discovery"],
  "created_at": "2026-02-28T12:00:00Z",
  "rate_limits": {
    "requests_per_minute": 60,
    "min_sync_interval_minutes": 15
  }
}

# Step 2: Announce ourselves (authenticated)
# (Client constructs canonical request, signs with our private key)
curl -X POST https://gary.myr.network/myr/peers/announce \
  -H "X-MYR-Timestamp: 2026-03-02T10:00:00Z" \
  -H "X-MYR-Nonce: a1b2c3d4..." \
  -H "X-MYR-Signature: d1e2f3g4..." \
  -H "X-MYR-Public-Key: i9j0k1l2..." \
  -d '{
    "peer_url": "https://jordan.myr.network",
    "public_key": "i9j0k1l2...",
    "operator_name": "jordan",
    "timestamp": "2026-03-02T10:00:00Z",
    "nonce": "a1b2c3d4..."
  }'

# Response:
{
  "status": "pending_approval",
  "our_public_key": "e5f6g7h8...",
  "message": "Peer request received. Awaiting operator approval.",
  "approval_required": true
}
```

---

**Next Steps:** Security review by Jordan, Gary, Jared. Revise based on feedback, then implement Phase 1.
