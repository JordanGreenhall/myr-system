# MYR Pilot Operating Model

**Version:** 1.3.1
**Date:** April 2026
**Goal:** 10,000+ participant methodological intelligence network
**Status:** Executable plan — 1,000 is a hard intermediate rung, not the destination

---

## 1. Launch Procedure

### Cohort Strategy

Growth proceeds in discrete cohorts. Each cohort completes its gate before the next begins. No cohort is skipped.

| Cohort | Size | Entry Mode | Duration | Purpose |
|--------|------|-----------|----------|---------|
| C0 (current) | 3 nodes | Direct invite, manual onboarding | Ongoing | Protocol validation, operational shakedown |
| C1 | 10 nodes | Direct invite, guided onboarding | 4 weeks | Gossip transport validation, multi-peer trust chains |
| C2 | 50 nodes | Referral invite, self-serve onboarding | 6 weeks | Subscription filtering load, governance signal propagation |
| C3 | 200 nodes | Open invite with approval, self-serve | 8 weeks | Anti-entropy repair at scale, coordinator prototype validation |
| C4 | 1,000 nodes | Open registration with peer vouching | 12 weeks | Full coordinator operation, routing economics under load |
| C5 | 10,000+ nodes | Open registration, automated onboarding | Continuous | Full production operation |

### Invitation Flow

1. **C0–C1:** Operator generates invite token via `myr invite create`. New node joins with `myr join "<invite-url>"`. Operator manually verifies fingerprint out-of-band.
2. **C2–C3:** Existing participants refer new nodes. Referrer's trust level must be >= Bounded. Referred node completes 3-way cryptographic verification with referrer and one additional peer.
3. **C4+:** Peer vouching replaces manual referral. A node with Trusted status can vouch for a new participant. Vouching creates a provisional trust relationship that upgrades after evidence of participation.

### Onboarding SLA

| Metric | C0–C1 | C2–C3 | C4+ |
|--------|-------|-------|-----|
| Time from invite to first sync | < 1 hour (guided) | < 30 min (self-serve) | < 10 min (automated) |
| Time from join to first yield capture | < 24 hours | < 24 hours | < 24 hours |
| Support response for onboarding issues | < 2 hours | < 4 hours | < 8 hours |

---

## 2. Success Metrics per Rung

Each growth rung has measurable criteria. Metrics are collected from `/myr/metrics` and `/myr/health/network`.

### C0–C1 (3–10 nodes)

| Metric | Target | Source |
|--------|--------|--------|
| Sync freshness | All peers synced within 2 sync cycles | `sync_lag_seconds` |
| Participation rate | >= 80% of nodes produce yield weekly | `reports_created_last_7d` per node |
| Yield quality | >= 60% of reports rated 3/5+ | `yield_score` distribution |
| Gossip convergence | Reports reach all interested nodes within 5 hops | `gossip_hops` histogram |
| Peer churn | < 10% of nodes unreachable for > 48h | `peer_reachability` |

### C2 (50 nodes)

All C1 targets plus:

| Metric | Target | Source |
|--------|--------|--------|
| Subscription adoption | >= 50% of nodes declare subscriptions | `subscription_declared` count |
| Filtered push ratio | >= 30% of IHAVE messages filtered by subscription | `ihave_filtered_ratio` |
| Governance signal propagation | Revocation reaches 95% of network within 3 sync cycles | `governance_propagation_lag` |
| Onboarding success rate | >= 90% of invited nodes complete first sync | onboarding trace logs |

### C3 (200 nodes)

All C2 targets plus:

| Metric | Target | Source |
|--------|--------|--------|
| Anti-entropy repair rate | < 1% of reports missing after 2 repair rounds | Bloom filter diff counts |
| Contradiction detection rate | 100% of conflicting reports flagged | `contradictions_detected` |
| Mean sync cycle duration | < 30 seconds per node | `sync_cycle_duration_ms` |
| Relay utilization | < 20% of traffic through relay (NAT traversal only) | `relay_bytes / total_bytes` |

### C4 (1,000 nodes)

All C3 targets plus:

| Metric | Target | Source |
|--------|--------|--------|
| Coordinator coverage | >= 3 coordinators per active domain tag | coordinator registry |
| Coordinator-to-coordinator sync lag | < 2 sync cycles | `coordinator_sync_lag` |
| Per-peer bandwidth | < 50 KB/sync cycle mean | `bytes_sent` + `bytes_received` per peer |
| Routing cost distribution | Gini coefficient < 0.6 across relay nodes | routing economics tables |
| Key rotation success rate | 100% of rotations propagate within 5 cycles | `key_rotation_propagation` |

### C5 (10,000+ nodes)

All C4 targets plus:

| Metric | Target | Source |
|--------|--------|--------|
| End-to-end report latency | < 5 minutes from creation to 99% interested nodes | `report_propagation_p99` |
| Network partition detection | Detected within 1 sync cycle, healed within 3 | `partition_events` |
| Automated onboarding success | >= 95% complete without human intervention | onboarding pipeline metrics |
| Cross-domain synthesis availability | >= 90% of domain pairs have coordinator bridge | coordinator topology |

---

## 3. Governance Posture

### Trust Policy Authority by Scale Tier

| Tier | Trust Policy Owner | Revocation Authority | Dispute Resolution |
|------|-------------------|---------------------|-------------------|
| C0–C1 (3–10) | Network founder (single operator) | Any node operator for their own peers | Direct operator communication |
| C2 (50) | Founding operators (quorum of 3) | Any operator; network-wide propagation via gossip | Founding operator mediation |
| C3 (200) | Governance council (5 elected operators) | Council + any operator for local peers | Council vote (simple majority) |
| C4 (1,000) | Governance council (7–11 elected) | Council for network-wide; operators for local | Formal dispute process with evidence review |
| C5 (10,000+) | Governance council + domain coordinators | Council for network-wide; coordinators for domain-level | Tiered: domain coordinator -> council -> appeal |

### Revocation Propagation

- **v1.3.0 (current):** Revocation signals propagate via governance gossip (`lib/governance-gossip.js`). Revocations are epidemically disseminated through the peer sampling overlay with the same convergence guarantees as report gossip.
- **Expected propagation time:** O(log_F(N)) sync cycles where F is fanout (default 5).
- **At 1,000 nodes:** ~4 sync cycles (~2 minutes at 30s intervals).
- **At 10,000 nodes:** ~6 sync cycles (~3 minutes).

### Dispute Resolution Process

1. Complainant submits signed dispute record to their local node.
2. Dispute propagates to governance council via gossip.
3. Council reviews evidence (yield traces, sync logs, trust history).
4. Council issues resolution record (signed by quorum).
5. Resolution propagates network-wide via governance gossip.
6. Affected parties can appeal within 7 days by submitting additional evidence.

---

## 4. Operational Cadence

### Monitoring Schedule

| Frequency | Action | Owner |
|-----------|--------|-------|
| Continuous | `/myr/metrics` and `/myr/health` endpoint monitoring | Automated (each node) |
| Every sync cycle | Gossip view health check (active/passive view sizes, IHAVE/IWANT ratios) | Automated |
| Daily | Review structured logs for error patterns, auth failures, governance events | Operations lead |
| Daily | Check sync freshness across all known peers | Operations lead |

### Incident Response

Follows `docs/SUPPORT-OPERATIONS.md` triage and escalation procedures:

1. **Sev1** (network-wide outage, data integrity breach): Page on-call immediately. Freeze all changes. Target resolution: < 1 hour.
2. **Sev2** (partial degradation, peer subset affected): Notify operations lead within 15 minutes. Target resolution: < 4 hours.
3. **Sev3** (single node issue, no network impact): Respond within 8 hours. Target resolution: < 24 hours.

Recovery procedures are in `docs/RUNBOOKS.md` covering: node crash recovery, key compromise, network partition healing, data corruption, and gossip view contamination.

### Weekly Review Checklist

- [ ] All nodes synced within target freshness window
- [ ] No unresolved governance events (revocations, disputes)
- [ ] Participation rate meets current cohort target
- [ ] Gossip convergence within expected hop count
- [ ] Relay utilization within bounds
- [ ] Routing economics balanced (no single node bearing > 20% of relay load)
- [ ] No new contradiction clusters unresolved for > 7 days
- [ ] Key rotation schedule current (no keys > 90 days without rotation)
- [ ] Onboarding pipeline clear (no stuck invites > 48 hours)

---

## 5. Growth Gates

A cohort advances to the next rung only when ALL gates for the current rung are met. Gates are evaluated weekly during the review.

### Gate: C0 -> C1 (3 -> 10)

- [ ] All C0 success metrics met for 2 consecutive weeks
- [ ] Gossip transport validated (IHAVE/IWANT + bloom anti-entropy operational) — **done in v1.3.0**
- [ ] Governance signal propagation tested across all 3 nodes — **done in v1.3.0**
- [ ] Onboarding procedure documented and tested with at least 1 new node
- [ ] Structured logging operational on all nodes — **done in v1.3.0**

### Gate: C1 -> C2 (10 -> 50)

- [ ] All C1 success metrics met for 3 consecutive weeks
- [ ] Subscription enforcement operational (ADR Phase 2)
- [ ] At least 3 domain tags actively used across the network
- [ ] Peer sampling shuffle validated at N=10 with view rotation
- [ ] No Sev1 incidents unresolved in prior 4 weeks

### Gate: C2 -> C3 (50 -> 200)

- [ ] All C2 success metrics met for 4 consecutive weeks
- [ ] Anti-entropy Bloom filter exchange operational (ADR Phase 3)
- [ ] Coordinator prototype validated in test environment
- [ ] Governance council elected and operational
- [ ] Self-serve onboarding success rate >= 85%
- [ ] Routing economics model validated with real traffic data

### Gate: C3 -> C4 (200 -> 1,000)

- [ ] All C3 success metrics met for 4 consecutive weeks
- [ ] Domain coordinators operational in production (ADR Phase 4)
- [ ] Coordinator-to-coordinator gossip ring validated
- [ ] Governance council scaled to 7+ members
- [ ] Dispute resolution process tested with at least 2 real disputes
- [ ] Key rotation completed successfully across >= 90% of nodes
- [ ] Per-node bandwidth within target at N=200

### Gate: C4 -> C5 (1,000 -> 10,000+)

- [ ] All C4 success metrics met for 6 consecutive weeks
- [ ] Coordinator coverage: >= 3 coordinators per active domain
- [ ] Automated onboarding pipeline operational (< 10 min join-to-sync)
- [ ] Governance tiered resolution operational (domain coordinator -> council -> appeal)
- [ ] Network partition detection and healing validated
- [ ] Cross-domain synthesis available for >= 80% of domain pairs
- [ ] Relay architecture validated for NAT-heavy populations (> 40% behind NAT)
- [ ] Routing economics sustainable (no operator subsidizing > 10% of total relay cost)

---

## 6. 10,000+ Preparation

Infrastructure and process work that must start at each rung BEFORE it is needed at the next rung.

### At C0–C1 (now): Prepare for 50

- [x] Gossip transport implemented (v1.3.0)
- [x] Governance gossip and revocation propagation (v1.3.0)
- [x] Structured logging and metrics endpoint (v1.3.0)
- [x] Support operations playbook and recovery runbooks
- [x] Routing economics model and instrumentation
- [ ] Subscription enforcement design finalized

### At C2 (50): Prepare for 200

- [ ] Anti-entropy Bloom filter prototype validated
- [ ] Coordinator architecture design reviewed and finalized
- [ ] Governance council election process defined
- [ ] Automated onboarding pipeline design started
- [ ] Load testing infrastructure for N=200 simulation

### At C3 (200): Prepare for 1,000

- [ ] Coordinator prototype deployed to test environment
- [ ] Coordinator-to-coordinator gossip validated
- [ ] Dispute resolution process documented and drilled
- [ ] Key rotation automation operational
- [ ] Relay capacity planning for NAT-heavy populations
- [ ] Onboarding SLA automation (monitoring, alerting)

### At C4 (1,000): Prepare for 10,000+

- [ ] Coordinator election protocol production-ready
- [ ] Cross-domain coordinator bridging validated
- [ ] Automated partition detection and healing
- [ ] Tiered governance operational
- [ ] Self-healing peer sampling under churn > 5%/day
- [ ] Routing cost redistribution mechanisms

---

## Cross-References

- **Technical migration phases:** `docs/ADR-scale-architecture.md` — Phase 1 (bounded fanout, v1.3.0), Phase 2 (subscription enforcement, v1.3.x), Phase 3 (anti-entropy + Bloom, v1.4.0), Phase 4 (coordinators, v1.5.0)
- **Incident triage and escalation:** `docs/SUPPORT-OPERATIONS.md`
- **Recovery procedures:** `docs/RUNBOOKS.md`
- **Routing economics:** `docs/ROUTING-ECONOMICS.md`
- **Operator onboarding:** `docs/OPERATOR-GUIDE.md`
- **Pilot participant brief:** `docs/PILOT-BRIEF.md`
- **Release notes:** `docs/RELEASE-NOTES-v1.3.1.md`

---

## Alignment with ADR Scale Architecture

| ADR Phase | Operating Model Cohort | What Must Be True |
|-----------|----------------------|-------------------|
| Phase 1: Bounded fanout (v1.3.0) | C0–C1 | Gossip transport operational, push-lazy dissemination working |
| Phase 2: Subscription enforcement (v1.3.x) | C2 | Subscriptions mandatory for gossip peers, filtered push active |
| Phase 3: Anti-entropy + Bloom (v1.4.0) | C3 | Bloom filter exchange replaces full pull, repair cycle validated |
| Phase 4: Coordinators (v1.5.0) | C4 | Domain coordinators elected and operational, pre-10,000+ validated |
| Full production | C5 (10,000+) | All phases complete, tiered governance, automated onboarding |

The operating model and technical migration are synchronized: no cohort advances past the capabilities of the current protocol phase. Coordinator architecture must be validated before C4 (1,000 nodes), not after — 1,000 is the hard intermediate rung where 10,000+ readiness is proven, not where it begins.
