# MYR Network Protocol Specification v0.3

**Status:** DRAFT  
**Author:** Polemarch  
**Date:** 2026-03-02  
**Review:** Requested  
**Changes from v0.2:** Fixed signature circularity, nonce cleanup, health endpoint, incremental sync, mutual approval

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
2. Reject if nonce seen before (query nonce table)
3. Verify signature against provided public key
4. Check if public key belongs to known peer (for peer-restricted endpoints)
5. Store nonce with expiry (timestamp + 10 minutes)
6. Clean up expired nonces (DELETE FROM myr_nonces WHERE expires_at < NOW())
```

**Nonce cleanup:** Runs **on every authenticated request** (not just sync), keeping the nonce table bounded.

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
  "protocol_version": "0.3.0",
  "node_url": "https://jordan.myr.network",
  "operator_name": "jordan",
  "public_key": "a1b2c3d4...",  // Hex-encoded Ed25519 public key (64 chars)
  "supported_features": ["report-sync", "peer-discovery", "incremental-sync"],
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

#### `GET /myr/health`

**Purpose:** Health check and node status

**Authentication:** Public endpoint (no auth required)

**Response:**
```json
{
  "status": "ok",
  "node_url": "https://jordan.myr.network",
  "operator_name": "jordan",
  "last_sync_at": "2026-03-02T10:30:00Z",
  "peers_active": 2,
  "peers_total": 3,
  "reports_total": 47,
  "reports_shared": 42,
  "uptime_seconds": 86400
}
```

**Use case:** Operators can check if peer nodes are alive and serving current data.

#### `GET /myr/reports`

**Purpose:** List available MYR reports from this node

**Authentication:** Required (must be known peer with `trust_level='trusted'`)

**Query params:**
- `since=<ISO8601>` - only return reports created/updated after this timestamp (incremental sync)
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
  "total": 42,
  "since": "2026-03-02T09:00:00Z"
}
```

**Incremental sync:**
- `since` parameter filters to reports with `created_at > since`
- Sync agent stores `last_sync_at` per peer, uses it for next sync
- Avoids re-fetching entire report list every sync

**Pagination:**
- If `total > limit`, client should increase `limit` or make multiple requests with updated `since`
- Results ordered by `created_at ASC`

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

// 403 Forbidden
{
  "error": {
    "code": "peer_not_trusted",
    "message": "Peer relationship exists but trust_level != 'trusted'"
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

**Authentication:** Required (must be known peer with `trust_level='trusted'`)

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

// 403 Forbidden
{
  "error": {
    "code": "report_not_shared",
    "message": "Report exists but share_network=false"
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

**Validation:**
- `public_key` in request body MUST match `X-MYR-Public-Key` header
- Server MUST reject if they differ (prevents key confusion attacks)

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

// 400 Bad Request
{
  "error": {
    "code": "key_mismatch",
    "message": "public_key in body does not match X-MYR-Public-Key header"
  }
}

// 409 Conflict
{
  "error": {
    "code": "peer_exists",
    "message": "Peer relationship already exists with this public_key"
  }
}
```

## Wire Formats

### MYR Report Object

**Complete JSON schema for a MYR report:**

```json
{
  "schema_version": "1.0",
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
  "share_network": true,
  "signature": "sha256:abc123...",
  "operator_signature": "d1e2f3g4..."
}
```

**Field definitions:**

- `schema_version`: Wire format version (current: "1.0")
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
- `share_network`: Boolean - if false, not shared via `/myr/reports` endpoint
- `signature`: SHA-256 hash of canonical JSON (excluding this field and `operator_signature`)
- `operator_signature`: Ed25519 signature of canonical JSON (excluding this field and `signature`)

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

### Signature Computation (IMPORTANT)

**Problem:** Can't compute SHA-256 of an object if the SHA-256 is inside the object.

**Solution:** Exclude `signature` and `operator_signature` fields from canonicalization.

**Algorithm:**

```javascript
// 1. Create report object WITHOUT signature fields
const report = {
  schema_version: "1.0",
  operator_name: "jordan",
  created_at: "2026-03-02T09:00:00Z",
  // ... all other fields
  share_network: true
  // NOTE: no signature, no operator_signature
};

// 2. Canonicalize (alphabetical keys, no whitespace)
const canonical = canonicalize(report);
// Result: {"actions_taken":[...],"created_at":"2026-03-02T09:00:00Z",...}

// 3. Compute SHA-256 hash
const hash = SHA256(canonical);
const signature = "sha256:" + hash;

// 4. Compute Ed25519 signature
const operator_signature = Ed25519.sign(canonical, operator_private_key);

// 5. Add signature fields to report
report.signature = signature;
report.operator_signature = operator_signature;

// 6. Store/transmit full report (now includes both signatures)
```

**Verification:**

```javascript
// 1. Receive report (includes signature and operator_signature)
const received_report = JSON.parse(response_body);

// 2. Extract signature fields
const claimed_signature = received_report.signature;
const claimed_operator_sig = received_report.operator_signature;

// 3. Remove signature fields
delete received_report.signature;
delete received_report.operator_signature;

// 4. Canonicalize
const canonical = canonicalize(received_report);

// 5. Verify SHA-256 hash
const computed_hash = "sha256:" + SHA256(canonical);
if (computed_hash !== claimed_signature) {
  REJECT("Integrity violation: hash mismatch");
}

// 6. Verify Ed25519 signature
if (!Ed25519.verify(canonical, claimed_operator_sig, peer_public_key)) {
  REJECT("Authentication failure: invalid operator signature");
}

// 7. Accept report
IMPORT(received_report);
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
- `peer_not_trusted` (403): Peer exists but not trusted
- `not_found` (404): Resource doesn't exist
- `invalid_request` (400): Malformed request body/params
- `key_mismatch` (400): Public key in body doesn't match header
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
# 6. Sync becomes active ONLY after BOTH sides have trust_level='trusted'
```

### Mutual Approval Requirement

**Sync activation rule:** Automatic sync only occurs when **BOTH** peers have set each other to `trust_level='trusted'`.

**Example scenarios:**

| Jordan's view of Gary | Gary's view of Jordan | Sync active? |
|-----------------------|----------------------|--------------|
| `pending`             | `pending`            | No           |
| `trusted`             | `pending`            | No           |
| `pending`             | `trusted`            | No           |
| `trusted`             | `trusted`            | **Yes**      |

**Implementation:** Before syncing from a peer, verify:
1. Local database has `trust_level='trusted'` for this peer
2. Attempt to fetch `/myr/reports` - if peer returns `403 peer_not_trusted`, they haven't approved us yet

### Peer Database Schema

```sql
CREATE TABLE myr_peers (
  id INTEGER PRIMARY KEY,
  peer_url TEXT UNIQUE NOT NULL,
  operator_name TEXT NOT NULL,
  public_key TEXT UNIQUE NOT NULL,  -- Hex-encoded Ed25519 public key
  trust_level TEXT CHECK(trust_level IN ('trusted', 'pending', 'rejected')) DEFAULT 'pending',
  added_at TEXT NOT NULL,
  approved_at TEXT,  -- When operator approved this peer (set trust_level='trusted')
  last_sync_at TEXT,  -- ISO8601 timestamp of last successful sync
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

-- Cleaned up on every authenticated request: DELETE FROM myr_nonces WHERE expires_at < NOW()
```

### Trust Levels

- **trusted** - operator has approved; automatically sync and import reports (if peer also trusts us)
- **pending** - peer relationship requested but not yet approved by operator
- **rejected** - operator explicitly rejected this peer; no sync

**Note:** There is no "provisional" level in v0.3. Either you trust a peer (import their reports) or you don't. Future versions may add granular trust levels.

## Component 3: Automatic Report Sync

### Sync Agent (Cron Job)

Runs every `auto_sync_interval` (default: 1 hour, minimum: 15 minutes)

**Algorithm:**
```
FOR EACH peer WHERE auto_sync=true AND trust_level='trusted':
  1. Authenticate request with our Ed25519 key
  2. GET /myr/reports?since=<peer.last_sync_at>&limit=500
  3. If response is 403 peer_not_trusted:
     - Log: "Peer has not approved us yet, skipping sync"
     - CONTINUE to next peer
  4. FOR EACH report in response:
     a. Check if we already have this report (by signature)
     b. If new:
        i.   Verify operator_signature against peer's public_key (see Signature Verification)
        ii.  If valid: import to local database (mark source_peer=<peer_name>)
        iii. If invalid: log security warning, skip import
  5. Update peer.last_sync_at = NOW()
  6. Clean up old nonces (DELETE FROM myr_nonces WHERE expires_at < NOW())
```

**Incremental sync:** Uses `since` parameter with stored `last_sync_at` timestamp to fetch only new/updated reports since last sync.

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

# Check peer node health
myr health gary
```

## Security Considerations

### Signature Verification

All reports from network peers MUST be cryptographically signed and verified:

1. **Signing (origin node):**
   ```
   report_without_sigs = {all fields except signature and operator_signature}
   canonical_json = canonicalize(report_without_sigs)
   
   signature = "sha256:" + SHA256(canonical_json)
   operator_signature = Ed25519.sign(canonical_json, operator_private_key)
   
   final_report = report_without_sigs + {signature, operator_signature}
   ```

2. **Verification (receiving node):**
   ```
   received_report = parse(response_body)
   claimed_sig = received_report.signature
   claimed_op_sig = received_report.operator_signature
   
   report_without_sigs = received_report MINUS {signature, operator_signature}
   canonical_json = canonicalize(report_without_sigs)
   
   computed_sig = "sha256:" + SHA256(canonical_json)
   IF computed_sig != claimed_sig:
     REJECT (integrity violation)
   
   IF NOT Ed25519.verify(canonical_json, claimed_op_sig, peer_public_key):
     REJECT (authentication failure)
   
   IMPORT received_report
   ```

3. **Fail closed:** Invalid signatures → reject report, log security event, do NOT import

### Authentication

- **All endpoints** (except `/.well-known/myr-node` and `/myr/health`) require Ed25519 signed requests
- **Replay protection:** Timestamp must be <5 minutes old, nonce must be unique
- **Nonce cleanup:** Runs on every authenticated request (keeps table bounded)
- **Rate limiting:** 60 requests/minute per peer (server-enforced)
- **Unknown peers:** Requests from unknown public keys are rejected (except `/myr/peers/announce`)
- **Untrusted peers:** Requests from `trust_level != 'trusted'` peers are rejected with `403 peer_not_trusted`

### Privacy

- **Operator controls sharing:** Reports are only shared via HTTP endpoint if `share_network=true`
- **No automatic rebroadcast:** Nodes don't re-share other nodes' reports
- **Selective import:** Operators approve peers before any reports are imported
- **Trust is explicit and mutual:** Sync only works when both sides approve each other

### Revocation

**Note:** v0.3 does not include report revocation. Once a report is shared and imported, there's no mechanism to revoke it. This is a known limitation acceptable for v0.3 with three trusted nodes.

**Mitigation:** Operators can:
- Update a report with new information (new `signature`, references old report in `operator_notes`)
- Share a correcting report ("previous report about X was incorrect because Y")
- Manually delete reports from their local database

**Future:** v0.4+ may add `DELETE /myr/reports/<signature>` with propagation to peers.

## Migration Path

### Phase 1: HTTP Server (v0.3.0)
- Implement MYR node HTTP server with Ed25519 authentication
- `/.well-known/myr-node` endpoint
- `/myr/health` endpoint
- `/myr/reports` listing endpoint (with `since` parameter for incremental sync)
- `/myr/reports/<signature>` fetch endpoint
- `/myr/peers/announce` endpoint (with key matching validation)
- Canonical JSON serialization (excluding signature fields)
- Signature verification
- Rate limiting
- Nonce cleanup on every auth request

### Phase 2: Peer Management (v0.4.0)
- `myr add-peer` command
- Peer database schema
- `myr approve-peer` / `myr reject-peer` commands
- `myr fingerprint` verification
- Manual sync: `myr sync <peer>`
- Mutual approval enforcement

### Phase 3: Auto-Sync (v0.5.0)
- Sync agent cron job
- Automatic report import from trusted peers (mutual approval required)
- Incremental sync using `since` parameter
- Deduplication and conflict detection

### Phase 4: Operations Integration (v0.6.0+)
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
5. **Discovery mechanism:** Beyond manual `add-peer`, do we need a registry/DHT? (Not for v0.3)

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

# Check peer health
myr health gary
# Response: ok, last_sync: 2 minutes ago, peers_active: 2

# That's it. System now:
# - Automatically syncs Gary's reports every hour (incremental, using 'since')
# - Verifies all signatures (excluding signature fields from canonicalization)
# - Imports trusted reports to local database (only if mutual approval)
# - Deduplicates across multiple peer paths
# - Cleans up nonces on every request
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
  "protocol_version": "0.3.0",
  "node_url": "https://gary.myr.network",
  "operator_name": "gary",
  "public_key": "e5f6g7h8...",
  "supported_features": ["report-sync", "peer-discovery", "incremental-sync"],
  "created_at": "2026-02-28T12:00:00Z",
  "rate_limits": {
    "requests_per_minute": 60,
    "min_sync_interval_minutes": 15
  }
}

# Step 2: Check health (unauthenticated)
curl https://gary.myr.network/myr/health

# Response:
{
  "status": "ok",
  "node_url": "https://gary.myr.network",
  "operator_name": "gary",
  "last_sync_at": "2026-03-02T11:15:00Z",
  "peers_active": 1,
  "peers_total": 2,
  "reports_total": 38,
  "reports_shared": 35,
  "uptime_seconds": 432000
}

# Step 3: Announce ourselves (authenticated)
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

# Step 4: After mutual approval, sync (authenticated, incremental)
curl https://gary.myr.network/myr/reports?since=2026-03-01T00:00:00Z&limit=100 \
  -H "X-MYR-Timestamp: 2026-03-02T11:00:00Z" \
  -H "X-MYR-Nonce: x9y8z7w6..." \
  -H "X-MYR-Signature: p5q6r7s8..." \
  -H "X-MYR-Public-Key: i9j0k1l2..."

# Response:
{
  "reports": [
    {
      "signature": "sha256:abc123...",
      "operator_name": "gary",
      "created_at": "2026-03-02T09:30:00Z",
      "method_name": "HTTP rate limiting implementation",
      "operator_rating": 4,
      "size_bytes": 3821,
      "url": "/myr/reports/sha256:abc123..."
    }
  ],
  "total": 1,
  "since": "2026-03-01T00:00:00Z"
}
```

---

## Appendix B: Changes from v0.2

1. **Fixed signature circularity** - `signature` and `operator_signature` fields excluded from canonicalization before hashing/signing
2. **Nonce cleanup runs on every request** - prevents unbounded table growth
3. **Added `/myr/health` endpoint** - health check and status
4. **Incremental sync via `since` parameter** - replaced cursor pagination, uses `last_sync_at` timestamp
5. **Mutual approval requirement specified** - sync only when both peers have `trust_level='trusted'`
6. **Public key matching validation** - announce endpoint requires body and header to match
7. **Added `peer_not_trusted` error** - 403 when peer exists but not approved

---

**Next Steps:** Review by Jordan, Gary, Jared. Revise based on feedback, then implement Phase 1.
