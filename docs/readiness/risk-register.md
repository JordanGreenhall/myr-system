# MYR Risk Register

**Date:** 2026-04-24
**Version:** v1.3.4
**Current cohort:** C0 (3 nodes)

---

## Risk Scoring

- **Likelihood:** Low / Medium / High
- **Impact:** Low / Medium / High / Critical
- **Residual risk:** the risk level remaining after current mitigations

---

## Technical Risks

### R01: Coordinator Single Point of Failure

| Field | Value |
|-------|-------|
| Category | Technical |
| Likelihood | High (at C3+) |
| Impact | Critical |
| Description | Coordinator is currently single-instance in-memory. No election protocol. If the coordinator node fails, domain routing stops. |
| Current mitigation | Fallback to subscription-filtered gossip when coordinator unavailable. Backward-compatible design means nodes degrade gracefully. |
| Residual risk | **High** — acceptable for C0-C2 (gossip alone works at small scale), blocks C3+ |
| Owner | La Forge (implementation), Number Two (prioritization) |
| Required by | C3 entry |

### R02: Gossip Convergence Under High Churn

| Field | Value |
|-------|-------|
| Category | Technical |
| Likelihood | Medium |
| Impact | High |
| Description | Peer sampling service has not been validated under > 5%/day node churn. High churn could fragment the gossip overlay, causing slow or incomplete dissemination. |
| Current mitigation | Active/passive view shuffle protocol with configurable fanout. Scale tests validate at N=200 with static membership. |
| Residual risk | **Medium** — untested failure mode; bounded by gossip TTL and anti-entropy repair |
| Owner | La Forge |
| Required by | C3 entry |

### R03: Data Integrity Under Concurrent Sync

| Field | Value |
|-------|-------|
| Category | Technical |
| Likelihood | Low |
| Impact | Critical |
| Description | SQLite WAL mode handles concurrent reads but write contention could cause data loss under high sync load from many peers simultaneously. |
| Current mitigation | SQLite WAL mode, signature verification on every sync pull, dedup by report hash. 5 recovery runbooks including corruption recovery. |
| Residual risk | **Low** — well-tested path, SQLite is battle-proven; monitor at C2+ |
| Owner | Data |
| Required by | Ongoing monitoring |

### R04: Bloom Filter False Positives at Scale

| Field | Value |
|-------|-------|
| Category | Technical |
| Likelihood | Medium (at C4+) |
| Impact | Medium |
| Description | Anti-entropy Bloom filters have increasing false positive rates as report counts grow. At 10,000+ reports per node, false positives could cause missed sync repairs. |
| Current mitigation | Bloom filter size is configurable. Unit tests validate at current scale. Full sync fallback exists. |
| Residual risk | **Medium** — needs measurement at C2+ with real report volumes |
| Owner | La Forge |
| Required by | C4 entry |

---

## Operational Risks

### R05: Operator Training Readiness

| Field | Value |
|-------|-------|
| Category | Operational |
| Likelihood | Medium |
| Impact | High |
| Description | Operators must understand revocation coordination (currently local-only), incident triage, and recovery procedures. No formal training program exists. |
| Current mitigation | OPERATOR-GUIDE.md, SUPPORT-OPERATIONS.md, RUNBOOKS.md all documented. PILOT-BRIEF.md provides executive context. |
| Residual risk | **Medium** — documentation exists but operator comprehension is unverified |
| Owner | Troi (briefing), Number Two (execution) |
| Required by | C1 entry |

### R06: Incident Response at Scale

| Field | Value |
|-------|-------|
| Category | Operational |
| Likelihood | Medium (at C2+) |
| Impact | High |
| Description | Support operations are designed for small-network incidents. At 50+ nodes, a network-wide incident could overwhelm current triage procedures. No automated alerting pipeline. |
| Current mitigation | Sev1/2/3 triage defined. 5 runbooks cover common failures. SLOs defined with scripts/slo-check.js. |
| Residual risk | **Medium** — manual triage scales poorly; automated alerting needed by C3 |
| Owner | Spock (procedures), Data (automation) |
| Required by | C3 entry |

### R07: Support Capacity

| Field | Value |
|-------|-------|
| Category | Operational |
| Likelihood | High (at C3+) |
| Impact | Medium |
| Description | No dedicated support capacity exists. All support is handled by the engineering crew. Beyond C2, support volume could consume engineering bandwidth. |
| Current mitigation | Self-serve onboarding docs, operator guide, pilot brief reduce support demand. |
| Residual risk | **High** — structural gap; acceptable for C0-C2 but must be addressed before C3 |
| Owner | Number Two |
| Required by | C3 entry |

---

## Governance Risks

### R08: Abuse Resistance — Revocation Propagation Latency

| Field | Value |
|-------|-------|
| Category | Governance |
| Likelihood | Medium |
| Impact | Critical |
| Description | Revocation propagates via gossip. SLO target is 120 seconds. If gossip overlay fragments or a malicious node ignores revocation, the abusive node continues operating in some network partitions. |
| Current mitigation | Governance-gossip module propagates revocation signals. Auth middleware blocks revoked peers at both client and server. Quarantine mechanism isolates disputed nodes. |
| Residual risk | **Medium** — propagation tested in unit tests, not in adversarial production conditions |
| Owner | Worf (security assessment), Data (implementation) |
| Required by | C2 entry |

### R09: Trust Model — Sybil Attack Surface

| Field | Value |
|-------|-------|
| Category | Governance |
| Likelihood | Low (C0-C2), Medium (C3+) |
| Impact | Critical |
| Description | At small scale, invite-only admission controls Sybil risk. At C3+ with open invites, a coordinated Sybil attack could overwhelm trust-weight voting and yield scoring. |
| Current mitigation | 4-stage participation model requires progressive trust accumulation. Invite/referral gating for C0-C2. Peer vouching required for C4. |
| Residual risk | **Low** for C0-C2 (invite-only), **High** for C4+ without additional Sybil resistance |
| Owner | Worf |
| Required by | C4 entry |

---

## Market Risks

### R10: Participant Retention

| Field | Value |
|-------|-------|
| Category | Market |
| Likelihood | Medium |
| Impact | High |
| Description | If early cohort participants do not experience tangible methodological value within the first 2-4 weeks, retention drops and word-of-mouth is negative. Network effects require sustained participation. |
| Current mitigation | Trust-weighted yield scoring surfaces relevant content. Local intelligence automation exists. Pilot brief sets expectations. |
| Residual risk | **Medium** — value delivery depends on content quality and network density, both unproven at C1 |
| Owner | Jordan (product direction), Troi (communication) |
| Required by | C1 success measurement |

### R11: Value Delivery Timeline

| Field | Value |
|-------|-------|
| Category | Market |
| Likelihood | Medium |
| Impact | High |
| Description | The path from C0 (3 nodes) to C4 (1,000 nodes) spans ~30 weeks of sequential cohort gates. If each gate takes longer than planned, the timeline to meaningful network scale extends significantly. |
| Current mitigation | Parallel execution of technical and operational work. Gate criteria are explicit and measurable. |
| Residual risk | **Medium** — timeline is aspirational; actual pace depends on C1 learnings |
| Owner | Number Two |
| Required by | Ongoing tracking |

### R12: Unauthenticated Endpoint Exposure

| Field | Value |
|-------|-------|
| Category | Technical / Governance |
| Likelihood | Medium |
| Impact | Medium |
| Description | Discovery and health endpoints lack IP-based rate limiting. A DDoS or scraping attack on these endpoints could degrade node performance. |
| Current mitigation | Security assessment recommends deployment behind reverse proxy. Per-peer rate limiting (60 req/min) exists for authenticated endpoints. |
| Residual risk | **Low** after reverse proxy deployment; **Medium** without it |
| Owner | La Forge (deployment guidance) |
| Required by | C1 entry (condition) |

---

## Risk Summary by Cohort Gate

| Risk | C0-C1 | C2 | C3 | C4+ |
|------|-------|----|----|-----|
| R01 Coordinator SPOF | Accept | Accept | **Block** | **Block** |
| R02 Gossip churn | Accept | Monitor | **Validate** | **Validate** |
| R03 Data integrity | Accept | Monitor | Monitor | Monitor |
| R04 Bloom false positives | Accept | Accept | Monitor | **Validate** |
| R05 Operator training | **Condition** | Monitor | Monitor | Monitor |
| R06 Incident response | Accept | Accept | **Address** | **Address** |
| R07 Support capacity | Accept | Accept | **Address** | **Block** |
| R08 Revocation latency | Accept | **Validate** | **Validate** | **Validate** |
| R09 Sybil attack | Accept | Accept | Monitor | **Block** |
| R10 Participant retention | **Monitor** | Monitor | Monitor | Monitor |
| R11 Value timeline | **Monitor** | Monitor | Monitor | Monitor |
| R12 Endpoint exposure | **Condition** | Accept | Accept | Accept |
