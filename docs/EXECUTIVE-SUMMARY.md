# MYR v1.2.0 — Executive Summary

**Date:** April 2026
**For:** Release decision

---

## What MYR Can Do Now

MYR is a working intelligence compounding system. A single node captures, searches, verifies, and synthesizes methodological yield from real work cycles. Multiple nodes exchange cryptographically signed yield over authenticated HTTP, with pull-based incremental sync, DHT peer discovery, relay fallback for NAT traversal, and 3-way fingerprint verification.

**Concrete capabilities at v1.2.0:**
- Structured capture of four yield types (technique, insight, falsification, pattern)
- Full-text search with verification-weighted relevance ranking
- Operator verification with quality gate (only rating >= 3 exports)
- Ed25519 signing of all artifacts and coupling events
- Peer management with invite-link onboarding (`myr join "<url>"`)
- Cross-node synthesis identifying convergent and divergent findings
- One-step install (`curl | bash`)
- 507 automated tests across 26 test files

**Current deployment:** 3 nodes operational.

---

## What MYR Cannot Do Yet

- **Scale beyond ~100 nodes.** Sync is O(N^2) — every node reads every peer's yield. The six-phase architecture roadmap addresses this.
- **Route yield by relevance.** No demand signaling or domain-filtered sync. All trusted peers receive everything.
- **Support transitive trust.** Every trust relationship requires direct 3-way verification. No vouch chains.
- **Revoke published yield.** Once signed and exported, a report cannot be recalled.
- **Enforce participation stages.** Stage definitions and capability maps exist in code but are not enforced across all protocol endpoints.
- **Govern at network level.** Contradiction detection exists. Operator-driven revocation and cross-node governance do not.

---

## Post-Release Path: 10,000+ Participant Network

**Project goal:** A 10,000+ participant methodological intelligence network.

**1,000 participants** is a hard market-significant intermediate rung — not the destination and not a reason to defer 10,000-readiness work. By the time MYR reaches 1,000, the architecture, governance, and operational posture for 10,000+ must already be validated.

**Pre-1,000 work for the 10,000+ goal (must begin now):**
- Coordinator/domain routing architecture — design and prototype before 1,000 nodes, not after
- Governance and abuse resistance framework
- Network-wide observability and support operations
- Routing economics model (bandwidth, storage, relay costs)
- Trust-weighted retrieval at scale
- Onboarding resilience under sustained load
- Launch/pilot operating procedures and recovery/failure runbooks

**Critical path (in dependency order):**
1. **Phase A — Local Machine:** Auto-capture from work traces, pre-cycle yield surfacing, application feedback loop. (No dependencies — can start immediately.)
2. **Phase B — Progressive Trust:** Domain-qualified trust enforcement, stage-gated capabilities, rate-limiting by trust depth. (Depends on A.)
3. **Phase C — Yield Fabric:** Continuous publish, provenance DAG, priority sync by domain/type/rating. (Depends on A+B.)
4. **Phase D — Selective Routing:** Domain coordinators, subscription-driven filtering at scale. (Depends on C; must be prototyped before 1,000 nodes.)
5. **Phase E — Operational Truth/Governance:** Abuse resistance, contradiction resolution, revocation, network-level governance.
6. **Phase F — Scale Onboarding:** Resilient onboarding under load, pilot operations, recovery procedures.

Full roadmap in `docs/ARCHITECTURE.md`.

---

## Release Decision Inputs

**Ship:** The local intelligence machine works. Network exchange works at small scale. Onboarding is simple. The protocol is cryptographically sound. Test coverage is comprehensive.

**Hold:** Scale limits are real and documented. Governance is minimal. The network is 3 nodes — cross-node value is thin at this size.

**Recommendation from materials:** MYR is release-ready as a controlled early-access tool for small networks (3–100 nodes) with honest documentation of its limits. It is not ready for unsupported mass onboarding. The project goal is 10,000+ participants; substantial architecture, governance, and operational work remains between the current state and that goal. 1,000 participants is an intermediate milestone, not the final target.
