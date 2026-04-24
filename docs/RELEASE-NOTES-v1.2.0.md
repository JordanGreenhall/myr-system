# MYR v1.2.0 Release Notes

**Date:** March 29, 2026
**Protocol version:** 1.2.0
**Status:** Operational for 3–100 nodes on weekly cadence

---

## What's New in v1.2.0

### 3-Way Fingerprint Verification
Peer announce now performs three independent checks before trust is granted:
1. Announced fingerprint matches the one computed from the announced public key
2. Peer's `/.well-known/myr-node` endpoint is reachable and well-formed
3. Discovery document's key and fingerprint match the announced values

Peers passing all three checks are marked `verified-pending-approval`. Peers failing any check are rejected with auditable `verification_evidence` stored in the peer record.

### DHT Peer Discovery
Nodes announce on Hyperswarm topic `SHA-256("myr-network-v1")` every 30 minutes. `myr peer discover --timeout 30000` listens for signed announcements. Optional `--auto-introduce` sends introduce messages to discovered peers automatically.

### Relay Fallback
Nodes behind NAT/firewall can sync via `POST /myr/relay` when direct HTTPS fails. The setup flow (`myr setup`) detects NAT and configures relay fallback automatically through the reachability cascade: Tailscale funnel, Cloudflare tunnel, bootstrap relay.

### Signed Health Checks
`GET /myr/health` now returns a `liveness_proof` block containing a signed timestamp + nonce. Peers can verify node liveness cryptographically, not just by HTTP response.

### Auto-Approve Verified Peers
New config options `auto_approve_verified_peers` and `auto_approve_min_protocol_version` allow nodes to automatically trust peers that pass 3-way verification. Recommended only for trusted network environments.

### Invite-Link Onboarding
`myr invite create` generates a `myr://invite/<token>` URL. New nodes join with `myr join "<url>"`. The flow handles peer introduction, fingerprint verification, and invite signature validation in a single step.

---

## What Works (Full Capability List)

### Local Intelligence Machine
- Capture MYR reports: interactive, flag-based, stdin, or LLM auto-draft
- Full-text search (FTS5) with relevance ranking and verification boost
- Operator verification with 1–5 rating scale
- Export gate: only rating >= 3 leaves the node
- Weekly synthesis with convergent/divergent analysis
- Cross-node synthesis across imported corpus

### Cryptography and Identity
- Ed25519 keypair generation via @noble/ed25519
- RFC 8785 JSON canonicalization for deterministic signing
- Message signing, verification, and fingerprint computation
- Node UUID generation and persistence

### Network Layer
- Identity document: `GET /.well-known/myr-node`
- Health check with signed liveness proof: `GET /myr/health`
- Authenticated report endpoints: `GET /myr/reports`, `GET /myr/reports/{id}`
- Peer management: add, approve, reject, list, discover (CLI + API)
- Pull-based incremental sync with deduplication
- Request signing with nonce-based replay prevention
- Trace logging for all coupling events

### Integration
- Agent memory system hook (fire-and-forget auto-draft)
- Python subprocess interface for non-Node.js agents
- Unified search across memory + MYR corpus

---

## What Does Not Work Yet

### Not built
- **Transitive trust / vouch chains** — trust requires direct verification between each pair of nodes. No delegation or transitivity.
- **Network-level health aggregation** — each node knows its own health, but no cross-network health view exists.
- **Yield revocation** — once a report is exported and signed, there is no mechanism to recall or invalidate it.
- **Hierarchical synthesis** — synthesis works within a single node's corpus. No cluster-level or network-level pattern detection.
- **Forward secrecy** — key compromise exposes all historical signatures.

### Partially built
- **Application tracking** — `myr_applications` table exists in schema but the feedback loop (auto-surfacing prior yield before work, auto-capturing "did this help?") is not wired.
- **Domain-qualified trust** — computed by `lib/participation.js` but not enforced as differential permissions.
- **Stage enforcement** — stage definitions and capability maps exist but are not enforced across all endpoints.
- **Subscription/demand signaling** — signals can be created, stored, and matched, but yield is not yet routed based on demand.
- **Governance** — contradiction detection and quarantine storage exist, but operator-driven revocation lists and cross-node governance coordination do not.

---

## Operational Limits

v1.2.0 is designed and tested for **3–100 nodes** on a **weekly exchange cadence**.

Beyond that scale:
- Every node reads every peer's yield directly — no filtering or routing
- Trust is binary (trusted/not) — no domain-specific gradation in practice
- No demand signaling — supply-push only
- Sync is O(N^2) at network level

The architecture document (`docs/ARCHITECTURE.md`) defines the six-phase roadmap to thousands of nodes.

---

## What's Next (Post-Release Milestones)

**Phase A — Strengthen the Local Machine:** Auto-capture from work traces. Pre-cycle yield surfacing. Application feedback loop.

**Phase B — Progressive Trust:** Domain-qualified trust enforcement. Stage-gated capabilities. Rate-limit by trust depth.

**Phase C — Yield Fabric:** Continuous publish (not batch). Provenance DAG. Priority sync by domain/type/rating.

**Phase D — Selective Routing:** Domain subscriptions. Trust-weighted routing. Synthesis summaries. Demand signals.

**Phase E — Operational Truth:** Network health aggregation. Sync staleness detection. Governance primitives. Yield revocation.

**Phase F — Scale Onboarding:** Guided first capture. Automatic peer suggestion. Stage progression visibility.

Build order: A and B can proceed in parallel. C requires A+B. D requires B+C. E requires C+D. F requires A+B.

---

## Known Security Limitations

- No forward secrecy (Ed25519 key compromise exposes all past signatures)
- Fingerprint space: first 16 bytes of SHA-256 (~4M addresses before collision risk)
- Transport confidentiality relies on HTTPS/TLS, not protocol-level encryption
- No published yield revocation mechanism
- Auto-approve should only be enabled in trusted networks

These are acceptable for the current scale and have defined upgrade paths.

---

## Version History

| Version | Date | Summary |
|---------|------|---------|
| 1.0.0 | 2026-02-27 | Local capture, search, verify, sign, export, import, synthesize |
| 1.1.0 | 2026-03-15 | HTTP server, peer management, auto-sync agent |
| 1.2.0 | 2026-03-29 | 3-way verification, DHT discovery, relay fallback, signed liveness, invite onboarding |
