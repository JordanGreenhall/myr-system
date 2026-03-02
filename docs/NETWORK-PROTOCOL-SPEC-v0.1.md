# MYR Network Protocol Specification v0.1

**Status:** DRAFT  
**Author:** Polemarch  
**Date:** 2026-03-02  
**Review:** Requested

## Problem Statement

The current MYR system requires manual node handoff via email:
1. Exchange public keys manually
2. Email mirror packages as attachments
3. Manually move files to appropriate directories
4. Repeat for every peer relationship

**This doesn't scale.** With 3 nodes (us, Gary, Jared) it barely works. At 10+ nodes it becomes unmanageable.

Additionally, shared mirrors stored in the database don't actively inform agent operations - they're passive documentation rather than active intelligence.

## Design Principles

1. **Zero manual email** - all node communication happens in-protocol
2. **Automatic peer discovery** - adding a peer should be one command
3. **Self-organizing trust network** - nodes sync mirrors from trusted peers automatically
4. **Active intelligence** - mirrors inform agent behavior at runtime, not just documentation
5. **Fail-safe** - untrusted/unverified mirrors never execute, only inform with warnings

## Architecture Overview

```
┌─────────────────┐         ┌─────────────────┐
│   MYR Node A    │◄───────►│   MYR Node B    │
│                 │  HTTPS   │                 │
│ ┌─────────────┐ │         │ ┌─────────────┐ │
│ │ HTTP Server │ │         │ │ HTTP Server │ │
│ └─────────────┘ │         │ └─────────────┘ │
│ ┌─────────────┐ │         │ ┌─────────────┐ │
│ │  SQLite DB  │ │         │ │  SQLite DB  │ │
│ │  + Mirrors  │ │         │ │  + Mirrors  │ │
│ └─────────────┘ │         │ └─────────────┘ │
│ ┌─────────────┐ │         │ ┌─────────────┐ │
│ │ Sync Agent  │ │         │ │ Sync Agent  │ │
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

Each MYR node runs a lightweight HTTP server exposing the MYR protocol API.

### Configuration

```javascript
// myr-config.json
{
  "node_url": "https://jordan.myr.network",  // Public endpoint for this node
  "port": 3719,                              // Local server port
  "operator_name": "jordan",                 // Human-readable operator ID
  "auto_sync_interval": "1h",                // How often to pull from peers
  "trust_mode": "explicit"                   // explicit | web-of-trust | open
}
```

### API Endpoints

#### `GET /.well-known/myr-node`

**Purpose:** Node discovery and capability negotiation

**Response:**
```json
{
  "protocol_version": "0.1.0",
  "node_url": "https://jordan.myr.network",
  "operator_name": "jordan",
  "public_key": "-----BEGIN PUBLIC KEY-----\n...",
  "supported_features": ["mirror-sync", "peer-discovery"],
  "created_at": "2026-03-01T10:00:00Z"
}
```

#### `GET /myr/mirrors`

**Purpose:** List available mirrors from this node

**Query params:**
- `since=<ISO8601>` - only mirrors created/updated after this timestamp
- `limit=<int>` - max results (default 100)
- `offset=<int>` - pagination offset

**Response:**
```json
{
  "mirrors": [
    {
      "signature": "sha256:abc123...",
      "operator_name": "jordan",
      "created_at": "2026-03-02T09:00:00Z",
      "method_name": "myr-system node handoff",
      "operator_rating": 3,
      "size_bytes": 4523,
      "url": "/myr/mirrors/sha256:abc123..."
    }
  ],
  "total": 42,
  "next_offset": 100
}
```

#### `GET /myr/mirrors/<signature>`

**Purpose:** Fetch a specific mirror package

**Response:** JSON mirror object (same format as current MYR exports)

**Headers:**
- `X-MYR-Signature: <operator_signature>` - cryptographic signature of response body
- `Content-Type: application/json`

#### `POST /myr/peers/announce`

**Purpose:** Notify this node of a new peer wanting to connect

**Request body:**
```json
{
  "peer_url": "https://gary.myr.network",
  "public_key": "-----BEGIN PUBLIC KEY-----\n...",
  "operator_name": "gary",
  "timestamp": "2026-03-02T10:00:00Z",
  "signature": "<signed_payload>"
}
```

**Response:**
```json
{
  "status": "accepted" | "pending_approval" | "rejected",
  "our_public_key": "-----BEGIN PUBLIC KEY-----\n...",
  "message": "Peer relationship established"
}
```

## Component 2: Peer Discovery and Trust

### Adding a Peer (Manual Bootstrap)

```bash
# Add Gary's node as a trusted peer
myr add-peer https://gary.myr.network

# What happens:
# 1. Fetch https://gary.myr.network/.well-known/myr-node
# 2. Store Gary's public key in peers table
# 3. POST our info to Gary's /myr/peers/announce
# 4. If accepted, mark peer as active
```

### Peer Database Schema

```sql
CREATE TABLE myr_peers (
  id INTEGER PRIMARY KEY,
  peer_url TEXT UNIQUE NOT NULL,
  operator_name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  trust_level TEXT CHECK(trust_level IN ('trusted', 'provisional', 'untrusted')) DEFAULT 'provisional',
  added_at TEXT NOT NULL,
  last_sync_at TEXT,
  auto_sync BOOLEAN DEFAULT 1,
  notes TEXT
);
```

### Trust Levels

- **trusted** - automatically sync and import mirrors; operator has verified this peer
- **provisional** - sync mirrors but don't auto-import without review
- **untrusted** - don't sync; peer exists but not trusted

## Component 3: Automatic Mirror Sync

### Sync Agent (Cron Job)

Runs every `auto_sync_interval` (default: 1 hour)

**Algorithm:**
```
FOR EACH peer WHERE auto_sync=true AND trust_level IN ('trusted', 'provisional'):
  1. GET /myr/mirrors?since=<last_sync_at>
  2. FOR EACH new mirror:
     a. Verify signature against peer's public_key
     b. If valid AND trust_level='trusted':
        - Import to local database
        - Mark operator_verified=false (came from network)
     c. If valid AND trust_level='provisional':
        - Store in staging area for manual review
     d. If invalid:
        - Log security warning
        - Do NOT import
  3. Update peer.last_sync_at
```

### CLI Commands

```bash
# Manual sync with specific peer
myr sync gary

# Manual sync with all peers
myr sync --all

# Review provisional mirrors
myr review-pending

# Approve a pending mirror
myr approve-mirror <signature>

# Check sync status
myr peers --status
```

## Component 4: Operations Integration

### Agent Startup Integration

**Modification to agent AGENTS.md startup sequence:**

```bash
# After memory search, before reading SOUL.md:
node $MYR_HOME/scripts/myr-context.js --agent <agent_name> --query "current task domain"

# Returns relevant mirrors as additional context
```

**Example output:**
```
=== MYR Network Intelligence ===
Found 3 relevant mirrors:

1. [gary] myr-system node handoff (rating: 2/5)
   "Manual key exchange is fragile - lost Jared's key twice"
   
2. [jordan] OpenClaw config changes (rating: 3/5)
   "Always test in isolation first - broke main session"
   
3. [jared] SQLite schema migrations (rating: 4/5)
   "Use transactions - rollback on failure critical"
```

### Pre-Execution Hooks

**Before spawning sub-agents or running deterministic plans:**

```bash
# Check for relevant network intelligence
myr query --context "deploying HTTP server" --format warnings

# Output if relevant:
# ⚠️  Gary's mirror: HTTP server crashed without rate limiting (rating: 2/5)
# ⚠️  Jared's mirror: Port binding failed - check firewall first (rating: 3/5)
```

### Memory Search Integration

**Extend memory-search.js to include network mirrors:**

```bash
node memory-search.js --agent polemarch --include-shared --include-network --query "HTTP deployment"

# Returns:
# - Local memories (agent + shared)
# - Network mirrors from trusted peers (marked with [network:<peer>])
```

### Gateway Model Selection

**Use mirror metadata to inform routing:**

```javascript
// Before model selection, check network intelligence
const mirrors = await queryMirrors({ 
  method: currentTask.method,
  model: proposedModel 
});

if (mirrors.some(m => m.operator_rating < 3 && m.model === proposedModel)) {
  // Network intelligence suggests this model struggled with this task
  // Consider alternate model or surface warning
}
```

## Security Considerations

### Signature Verification

All mirrors from network peers MUST be cryptographically signed and verified:

1. **Signing (origin node):**
   ```bash
   signature = sign(mirror_json, operator_private_key)
   ```

2. **Verification (receiving node):**
   ```bash
   is_valid = verify(mirror_json, signature, peer_public_key)
   ```

3. **Fail closed:** Invalid signatures → reject mirror, log security event

### Trust Boundaries

- **Trusted peers:** Mirrors auto-import, can influence operations (with warnings)
- **Provisional peers:** Mirrors stage for review, don't influence operations
- **Untrusted peers:** No sync, no influence

### Privacy

- **Operators control sharing:** Mirrors are only shared via HTTP endpoint if `share_network=true`
- **No automatic broadcast:** Nodes don't re-share other nodes' mirrors without explicit permission
- **Selective sync:** Operators can filter what they import (`myr sync gary --only-rating>=3`)

## Migration Path

### Phase 1: HTTP Server (v0.2.0)
- Implement MYR node HTTP server
- `/.well-known/myr-node` endpoint
- `/myr/mirrors` listing endpoint
- `/myr/mirrors/<signature>` fetch endpoint

### Phase 2: Peer Management (v0.3.0)
- `myr add-peer` command
- Peer database schema
- `/myr/peers/announce` endpoint
- Manual sync: `myr sync <peer>`

### Phase 3: Auto-Sync (v0.4.0)
- Sync agent cron job
- Signature verification
- Trust level management
- `myr review-pending` workflow

### Phase 4: Operations Integration (v0.5.0)
- `myr-context.js` for agent startup
- Pre-execution warning hooks
- Memory search network integration
- Gateway model selection hints

## Open Questions

1. **Port allocation:** Should MYR nodes use standard port (e.g., 3719) or configurable?
2. **NAT traversal:** How do home network nodes expose HTTP endpoints? (ngrok? Cloudflare tunnel?)
3. **Web of trust:** Should we implement transitive trust (Gary trusts Jared → auto-trust at lower level)?
4. **Rate limiting:** What's reasonable sync frequency? Should nodes respect rate limits?
5. **Mirror TTL:** Should old mirrors expire? Archive after N days?
6. **Conflict resolution:** Two peers share mirrors about same task with conflicting advice - how to surface?

## Success Criteria

After implementation, the workflow should be:

```bash
# Add a peer (one-time setup)
myr add-peer https://gary.myr.network

# That's it. System now:
# - Automatically syncs Gary's mirrors every hour
# - Surfaces Gary's learnings in memory search
# - Warns agents before repeating Gary's mistakes
# - Shows network intelligence in agent startup context
```

**Zero manual email. Zero file shuffling. Network intelligence flows automatically.**

---

**Next Steps:** Review by Gary, Jared, and technical reviewers. Revise based on feedback, then implement Phase 1.
