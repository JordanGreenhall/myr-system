# MYR System Architecture

**Canonical reference for building and operating a thousands-node methodological intelligence network.**

Status: v1.0 — April 2026
Scope: From current 3-node operation to thousands of active participants

---

## 1. What MYR Is

MYR is a system that turns real work into compounding intelligence. Every meaningful cycle of work (observe, orient, decide, act) produces methodological yield — knowledge about what works, what fails, and what changes next. MYR captures that yield, makes it retrievable, signs it cryptographically, and distributes it to other nodes where it compounds.

The unit of value is the **MYR report**: a structured record of one finding from one real cycle of work. Not a summary. Not a log entry. A specific answer to a specific question, backed by observable evidence, with explicit consequences for the next cycle.

MYR is not a messaging system. It is a coupling system. Nodes that exchange yield form relationships with observable depth. The protocol makes those relationships visible through traces — signed records of every coupling event.

---

## 2. Core Definitions

### Node

A node is one operator's complete MYR installation. It has:

- **Identity**: an Ed25519 keypair. The public key is the permanent address. The fingerprint (first 16 bytes of SHA-256 of the public key, colon-delimited hex) is the short form. Identity is immutable — everything else about a node is mutable.
- **Local corpus**: a SQLite database of MYR reports, both self-authored and imported from peers.
- **Server**: an HTTP listener that exposes the node's identity document, health status, and reports to authenticated peers.
- **Peer registry**: records of other nodes this operator knows about, with trust levels and sync history.
- **Trace log**: signed audit trail of every coupling event — introductions, shares, syncs, verifications.

A node operates as a self-contained intelligence machine. It must be locally useful before it ever connects to the network.

### MYR Report

A MYR report captures one finding from one real work cycle:

| Field | Required | Purpose |
|-------|----------|---------|
| `cycle_intent` | yes | What was being attempted |
| `yield_type` | yes | technique, insight, falsification, or pattern |
| `question_answered` | yes | The specific question this cycle resolved |
| `evidence` | yes | Observable proof — not claimed, observed |
| `what_changes_next` | yes | What will be different in the next cycle |
| `confidence` | yes | 0–1 estimate of reliability |
| `domain_tags` | yes | Hierarchical classification (JSON array) |
| `what_was_falsified` | no | What was proven NOT to work |
| `operator_rating` | no | 1–5 operator verification score |

**Yield types:**
- **technique** — a method that works, reusable
- **insight** — a conceptual understanding that shifts orientation
- **falsification** — something proven not to work (prevents repeated failure)
- **pattern** — a recurring structure observed across multiple cycles

**ID format:** `{node_id}-{YYYYMMDD}-{seq}` (e.g., `n1-20260226-001`).

### Local Memory

The local corpus is the set of all MYR reports a node holds — both self-authored and imported. It is stored in SQLite with WAL journaling and includes:

- `myr_reports` — the primary yield table
- `myr_fts` — FTS5 full-text index over intent, question, evidence, changes, tags
- `myr_syntheses` — cross-node convergence/divergence analysis results
- `myr_peers` — peer trust registry
- `myr_nonces` — replay attack prevention
- `myr_traces` — coupling event audit log

Search results are ranked by FTS5 relevance and boosted by operator rating: verified 4–5 rated at 2.0x, 3 at 1.5x, unverified at 0.8x.

### Local Yield

Yield is what a single node produces from its own work. It becomes local yield when:

1. **Captured** via `myr-store.js` (interactive, flags, or stdin)
2. **Verified** via `myr-verify.js` — operator assigns a 1–5 rating
3. **Signed** via `myr-sign.js` — Ed25519 signature over RFC 8785 canonical JSON
4. **Exported** via `myr-export.js` — only reports with `operator_rating >= 3`

Unverified yield lives in local memory and is searchable, but cannot leave the node.

### Network Yield

Network yield is local yield that has crossed a node boundary. When a peer syncs a report:

- The receiving node verifies the Ed25519 signature against the sender's public key
- The report is stored with `imported_from` set to the peer's name
- It enters the receiving node's FTS index and becomes searchable
- It can participate in cross-node synthesis

Network yield compounds when a node applies received yield in its own work and captures a new MYR recording the outcome. This closes the loop: one node's technique becomes another node's evidence.

---

## 3. Network Protocol

### Identity Discovery

Every node exposes `GET /.well-known/myr-node` (unauthenticated):

```json
{
  "protocol_version": "1.2.0",
  "node_url": "https://example.com",
  "operator_name": "Alice",
  "public_key": "<hex Ed25519>",
  "fingerprint": "SHA-256:xx:xx:...",
  "capabilities": ["report-sync", "peer-discovery", "incremental-sync"],
  "network_eligibility": {
    "eligible": true,
    "myr_count": 15,
    "avg_rating": 3.8
  }
}
```

### Peer Discovery

Two mechanisms:

1. **Manual**: `myr peer add --url <url>` fetches the identity document, stores the peer as `pending`, and sends an announce.
2. **DHT**: Hyperswarm announcements on topic `SHA-256("myr-network-v1")`. Nodes re-announce every 30 minutes. `myr peer discover --timeout 30000` listens and collects signed announcements.

### Trust and Verification

Peer trust has three states: `pending`, `trusted`, `rejected`.

**3-way fingerprint verification** on announce:
1. Compute fingerprint from announced public key — must match announced fingerprint
2. Fetch `/.well-known/myr-node` from announced URL — must be reachable and well-formed
3. Compare discovery document's key and fingerprint against announced values — must match

Sync only activates between mutually trusted peers (both sides `trust_level = 'trusted'`).

### Request Authentication

Authenticated endpoints require signed requests:

- `X-MYR-Timestamp`: ISO 8601 (rejected if >5 minutes old)
- `X-MYR-Nonce`: 32-byte random hex (rejected if seen before)
- `X-MYR-Signature`: Ed25519 over `METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_HASH`
- `X-MYR-Public-Key`: requestor's public key

### Report Synchronization

Pull-based incremental sync:

1. `GET /myr/reports?since={last_sync_at}&limit=500` — list new reports
2. Deduplicate by `signed_artifact` — skip reports already held locally
3. `GET /myr/reports/{id}` — fetch each new report
4. Verify SHA-256 hash and Ed25519 signature — reject on failure
5. Import to local DB with `imported_from` attribution
6. Log trace: `event_type=sync_pull`
7. Update `peer.last_sync_at`

Relay fallback exists for NAT-behind nodes via `POST /myr/relay`.

---

## 4. Participation Stages

### Stage 1: Local Only

**Entry:** Install MYR, generate keypair, configure node.

**Activity:** Capture yield from real work. Search local corpus. Run weekly synthesis. Verify reports.

**Value:** Immediate — the node is a personal intelligence machine. No network required.

**Exit criterion:** >=10 verified MYRs, average rating >=3.0.

### Stage 2: Provisional Participant

**Entry:** Exchange identity with one trusted peer. Complete 3-way fingerprint verification. Mutual approval.

**Activity:** Pull-based sync from trusted peers. Import verified yield. Search across local + imported corpus. Begin generating application reports (use received yield, record outcome).

**Value:** Access to peer yield. Cross-node synthesis becomes possible. Falsifications from peers prevent repeating their mistakes.

**Exit criterion:** >=3 application reports referencing imported yield.

### Stage 3: Bounded Contributor

**Entry:** Trusted by >=3 peers. Application reports demonstrate real use of network yield.

**Activity:** Full bidirectional sync with multiple peers. DHT discovery active. Begin receiving sync requests from newer nodes.

**Value:** Node becomes a net contributor. Domain-specific yield corpus attracts peers working in overlapping areas.

**Exit criterion:** Sustained contribution over >=4 weeks. Coupling traces show reciprocal application.

### Stage 4: Trusted Full Participant

**Entry:** Deep coupling history with multiple peers across domains. Traces show consistent calibration (confidence estimates match outcomes).

**Activity:** Bridge across domain clusters. Cross-cluster synthesis. Vouch for newer participants based on trace evidence.

**Value:** Node contributes to network-level intelligence that exceeds any single node's capability.

**This stage is not yet built.** It requires transitive trust computation and domain-specific reputation — see Section 6.

---

## 5. What Exists Today (v1.2.0)

### Fully Operational

**Local intelligence machine:**
- MYR capture: interactive, flag-based, stdin, auto-draft via LLM
- Full-text search with FTS5 relevance ranking and verification boost
- Operator verification (1–5 rating)
- Weekly synthesis (convergent/divergent analysis)
- Export gate: only `operator_rating >= 3` leaves the node

**Cryptography and identity:**
- Ed25519 keypair generation and management
- RFC 8785 JSON canonicalization
- Message signing and verification
- Fingerprint computation

**Network layer:**
- Identity document endpoint (`/.well-known/myr-node`)
- Health endpoint with signed liveness proof
- Report list and fetch endpoints (authenticated)
- Peer management CLI (add, approve, reject, list, discover)
- DHT discovery via Hyperswarm
- 3-way fingerprint verification
- Pull-based incremental sync with deduplication
- Request signing with nonce-based replay prevention
- Relay fallback for NAT/firewall traversal
- Trace logging for all coupling events

**Integration:**
- Agent memory system hook (fire-and-forget auto-draft from lessons/decisions)
- Python subprocess interface for non-Node.js agents
- Unified search across memory + MYR corpus

### Operational Limits

The current system works for **3–100 nodes** operating on a weekly cadence. Beyond that:

- Every node reads every peer's yield directly — no filtering, no routing
- Trust is binary (trusted/not) — no domain specificity, no gradation
- No demand signaling — supply-push only
- No transitive trust — every trust relationship requires direct verification
- No synthesis beyond single-node aggregation
- No governance — operator approval is the only gate

---

## 6. What Must Be Built Next

The six tasks assigned to this project (STA-131 through STA-136) map to specific gaps. Here is the build order and dependency chain:

### Phase A: Strengthen the Local Machine (STA-131)

**Goal:** Make a single node automatically useful enough that joining creates immediate value.

**What's missing:**
- Auto-capture from agent work traces (currently requires explicit `myr-store` calls or memory hook)
- Relevance surfacing during active work (search exists but isn't triggered automatically)
- Feedback loop: did prior yield actually help the current cycle?

**Build:**
1. Pre-cycle hook: before starting work, automatically search MYR corpus for relevant prior yield and surface it
2. Post-cycle hook: after completing work, detect yield-worthy events and auto-draft MYR reports
3. Application tracking: when surfaced yield is used, capture an application trace linking the original MYR to the new outcome

**Depends on:** Nothing. Can start immediately.

### Phase B: Progressive Trust (STA-133)

**Goal:** Allow participation to deepen from evidence, not declaration.

**What's missing:**
- Participation stages are conceptual — not enforced by the protocol
- Trust is binary — no domain qualification
- Coupling depth is logged in traces but not computed or used

**Build:**
1. Coupling depth computation: derive depth (0–4) from trace history per peer per domain
2. Domain-qualified trust: trust summaries that are specific to domain tags, not global
3. Stage enforcement: gate capabilities by demonstrated coupling depth (e.g., relay access requires Stage 3+)
4. Containment: rate-limit sync volume for provisional participants; increase as trust deepens

**Depends on:** Trace logging (exists). Application tracking (Phase A).

### Phase C: The Yield Fabric (STA-132)

**Goal:** Make yield flow reliably across the network with provenance preserved.

**What's missing:**
- Publish is batch-oriented (export files) rather than continuous
- No structured provenance chain linking original → import → application → new yield
- Sync is pull-only with no priority or relevance filtering

**Build:**
1. Continuous publish: emit signed yield events as they are verified (not just batch export)
2. Provenance DAG: each MYR can reference parent MYRs it builds on (`references` field)
3. Priority sync: peers can request yield filtered by domain, yield_type, or minimum rating
4. Replay and recovery: given a provenance chain, reconstruct the reasoning path from origin to application

**Depends on:** Application tracking (Phase A). Domain-qualified trust (Phase B) for priority decisions.

### Phase D: Selective Routing and Flow (STA-135)

**Goal:** Route yield to the right nodes without overwhelming them.

**What's missing:**
- No subscription/demand signaling
- No routing based on domain or trust
- No suppression of duplicate or low-relevance yield

**Build:**
1. Domain subscriptions: nodes declare interest in specific domain hierarchies
2. Trust-weighted routing: route yield through peers with demonstrated domain competence
3. Synthesis summaries: when raw flow is too heavy, produce cluster-level digests
4. Demand signals: nodes signal what domains they need yield in, enabling targeted sharing

**Depends on:** Domain-qualified trust (Phase B). Provenance DAG (Phase C).

### Phase E: Operational Truth (STA-136)

**Goal:** Make failures visible and recovery real.

**What's missing:**
- No network-level health monitoring (only per-node health endpoint)
- No queue aging detection (stale unsynced yield)
- No contradiction detection across nodes
- No governance or intervention mechanisms

**Build:**
1. Network health aggregation: collect health from all trusted peers, surface degradation
2. Sync staleness detection: alert when peers fall behind sync windows
3. Contradiction detection: flag when two nodes' yield on the same domain/question diverge
4. Replay and recovery: rebuild corpus state from signed artifacts after data loss
5. Governance primitives: revocation lists, operator intervention for disputed yield

**Depends on:** Yield fabric (Phase C). Selective routing (Phase D) for contradiction detection at scale.

### Phase F: Scale Onboarding (STA-134)

**Goal:** Make joining simple enough that thousands of people actually do it.

**What's missing:**
- Setup requires technical knowledge (keypair generation, Cloudflare Tunnel, config editing)
- No guided onboarding flow
- No automatic progression through participation stages
- No "first value" experience within minutes of joining

**Build:**
1. One-command install: `curl ... | sh` that handles keygen, config, tunnel setup
2. Guided first capture: interactive tutorial that produces first MYR from real reflection
3. Automatic peer suggestion: DHT discovery surfaces compatible peers by domain overlap
4. Stage progression UI: show current stage, requirements for next stage, coupling depth per peer

**Depends on:** Progressive trust (Phase B) for stage enforcement. Local machine improvements (Phase A) for first-value experience.

### Build Order Summary

```
Phase A (Local Machine) ─────────────────────────────┐
                                                      │
Phase B (Progressive Trust) ← depends on A ───────────┤
                                                      │
Phase C (Yield Fabric) ← depends on A, B ─────────────┤
                                                      │
Phase D (Selective Routing) ← depends on B, C ────────┤
                                                      │
Phase E (Operational Truth) ← depends on C, D ────────┤
                                                      │
Phase F (Scale Onboarding) ← depends on A, B ─────────┘
```

Phases A and B can proceed in parallel. Phase F can begin once A and B are operational.

---

## 7. Architecture at Thousands of Nodes

At scale, the same primitives apply but consumption patterns change:

| Scale | Trust | Flow | Synthesis |
|-------|-------|------|-----------|
| 3 | Direct traces only | Read everything | Single-node |
| 30 | Direct traces + manual vouches | Pull from all trusted peers | Local cross-node |
| 300 | Domain-qualified trust summaries | Subscription-based routing | Cluster synthesis |
| 3,000 | Transitive trust via vouch chains | Demand-driven flow | Cross-cluster synthesis |
| 30,000 | Cluster-level reputation | Hierarchical routing + digests | Network-level patterns |

**What doesn't change:**
- Ed25519 identity and signing
- MYR report format and schema
- Trace logging for coupling events
- Pull-based sync between trusted peers
- Operator verification as quality gate

**What emerges:**
- Trust becomes transitive (vouch chains grounded in trace evidence)
- Flow becomes demand-driven (subscriptions replace broadcast)
- Synthesis becomes hierarchical (cluster → cross-cluster → network)
- Governance becomes explicit (domain-specific authority from coupling depth)

The protocol is designed so that lower layers don't change as higher layers are added. Layer 0 (identity) and Layer 1 (coupling) are frozen. Layers 3–6 (trust topology, flow, synthesis, governance) emerge from the same trace primitives.

---

## 8. Security Model

**Cryptographic foundation:** Ed25519 signing via @noble/ed25519. All yield and coupling events are signed. Provenance is structural — follow the signature chain to verify any claim.

**Authentication:** Signed HTTP requests with timestamp + nonce for replay prevention. Rate-limited per peer.

**Trust:** No global trust score. Each node computes its own trust assessment per peer per domain from trace evidence. Trust is domain-specific to prevent authority leakage.

**Known limitations at current scale:**
- No forward secrecy (key compromise exposes all past signatures)
- Fingerprint uses first 16 bytes of SHA-256 (~4M addresses before collision risk)
- Transport confidentiality relies on HTTPS/TLS, not protocol-level encryption
- No revocation mechanism for published yield

These are acceptable for hundreds of nodes and have defined upgrade paths for thousands.

---

## 9. File Map

```
myr-system/
├── bin/myr                    CLI entry point
├── lib/
│   ├── crypto.js              Ed25519 signing, verification, fingerprint
│   ├── canonicalize.js        RFC 8785 JSON canonicalization
│   ├── db.js                  SQLite schema, migrations, queries
│   ├── config.js              Config loading (project + ~/.myr/)
│   ├── sync.js                Peer sync: list, fetch, verify, import
│   ├── verify.js              3-way fingerprint verification
│   ├── discovery.js           Hyperswarm DHT announce/discover
│   ├── middleware.js           Express auth, rate limiting
│   └── traces.js              Coupling event logging
├── server/index.js            HTTP server (routes, startup, shutdown)
├── scripts/
│   ├── myr-store.js           Capture new MYR
│   ├── myr-search.js          Full-text search
│   ├── myr-verify.js          Operator verification
│   ├── myr-weekly.js          Weekly synthesis
│   ├── myr-synthesize.js      Cross-node convergence analysis
│   ├── myr-export.js          Signed batch export
│   ├── myr-import.js          Verified import from peer files
│   ├── myr-sign.js            Batch sign unexported MYRs
│   ├── myr-draft.js           LLM auto-draft from memory content
│   ├── myr-keygen.js          Generate Ed25519 keypair
│   └── myr-identity.js        Display node identity
├── schema/myr-report.json     JSON schema for validation
├── db/                        Runtime SQLite databases
├── keys/                      Ed25519 keypairs (0600)
├── exports/                   Signed export bundles
├── imports/                   Received peer yield files
├── network/                   Network state
├── docs/                      Specifications and design docs
└── test/                      Integration tests
```

---

*The intelligence machine is the product. Build toward live operation. Produce evidence, not vocabulary.*
