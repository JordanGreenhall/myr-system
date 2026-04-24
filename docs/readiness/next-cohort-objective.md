# Next Cohort Objective: C1 (10 Nodes)

**Date:** 2026-04-24
**Current state:** C0 (3 nodes), v1.3.1 released
**Target:** C1 — expand from 3 to 10 nodes

---

## What Must Be True Before C1 Invitations Go Out

### Operational Prerequisites

1. **Reverse proxy deployed** on all C0 nodes with IP-based rate limiting for unauthenticated endpoints (/myr/health, /myr/discovery)
2. **All 3 C0 operators briefed** on:
   - Local-only revocation coordination (out-of-band notification required)
   - Incident triage procedure (Sev1/2/3 from SUPPORT-OPERATIONS.md)
   - At least 2 of 5 recovery runbooks (crash recovery, key compromise)
3. **SLO baseline established** — run scripts/slo-check.js against all C0 nodes, record baseline values
4. **Weekly metrics review cadence** started (PILOT-OPERATING-MODEL.md section 4)
5. **Invite list finalized** — 7 new nodes identified, operators committed

### Technical Prerequisites

1. **All 486 regression tests passing** (npm test)
2. **Release acceptance tests passing** (npm run test:release)
3. **Evidence collection script run** with GO or CONDITIONAL result (scripts/readiness/collect-evidence.sh)
4. **No Sev1 incidents unresolved** from C0 operation

---

## Success Metrics for C1 Operation

| Metric | Target | Measurement |
|--------|--------|-------------|
| Sync freshness | 95% of checks show lag <= 60s | GET /myr/metrics, weekly |
| Gossip health | 99% of checks show active view >= fanout-1 | GET /myr/metrics, weekly |
| Onboarding time | < 1 hour per new node (guided) | Manual timing |
| Uptime | 99.5% per node | External monitoring of /myr/health |
| Test pass rate | 100% on every release | npm test |
| Governance exercise | At least 1 revocation or quarantine action during C1 | Trace log audit |
| Participant retention | >= 8 of 10 nodes active at week 4 | Peer discovery check |
| Support incidents | < 3 Sev2+ per week | Manual tracking |

---

## What C1 Teaches Us That C0 Cannot

### 1. Multi-Peer Gossip Dynamics
C0 (3 nodes) is essentially a fully connected mesh. Gossip protocol behavior — peer sampling, IHAVE/IWANT negotiation, view shuffle — only becomes meaningful at 10+ nodes where not every peer talks to every other peer. C1 is the first test of gossip as a protocol rather than a formality.

### 2. Trust Chain Diversity
With 3 nodes, trust relationships are trivially simple. At 10 nodes, the participation model (local-only / provisional / bounded / trusted-full) produces real trust diversity. We learn whether the promotion/demotion criteria produce the intended trust gradient.

### 3. Subscription Filtering Under Real Domain Diversity
C0 operators likely share similar domain interests. C1 should deliberately include operators with diverse domain tags to test whether subscription filtering actually reduces irrelevant traffic.

### 4. Operational Support Load
C0 is self-supporting (the builders are the operators). C1 introduces operators who are not contributors. This reveals the actual support burden — onboarding friction, configuration questions, incident resolution time.

### 5. Revocation Coordination Reality
With 3 nodes, "call each other" is a revocation strategy. At 10 nodes, we learn whether local-only revocation with out-of-band coordination is actually workable or whether governance-gossip propagation must be mandatory before C2.

### 6. Value Perception
C0 operators evaluate MYR as builders. C1 operators evaluate it as users. Their perception of methodological yield and network value is the first real signal about product-market direction.

---

## What Must Be Prepared During C1 for C2 Readiness

### Technical Preparation (execute during C1's 4-week window)

1. **Subscription enforcement design** — decide whether subscriptions become mandatory at C2 or remain optional. Design document required.
2. **Coordinator election protocol design** — required before C3. Start design during C1, prototype during C2.
3. **Structured logging specification** — define JSON log format, request-level access logging schema. Implementation can follow.
4. **Bloom filter sizing model** — measure actual report volumes from C1 to project false positive rates at C2 (50 nodes).
5. **Self-serve onboarding flow** — C2 uses referral invites with self-serve onboarding. Build and test the flow.

### Operational Preparation

1. **Collect production SLO data** — 4 weeks of metrics from 10 nodes establishes real baselines for C2 go/no-go.
2. **Document C1 learnings** — operator feedback, incident reports, onboarding friction log.
3. **Refine support procedures** — update SUPPORT-OPERATIONS.md and RUNBOOKS.md based on real incidents.
4. **Identify C2 candidates** — begin referral pipeline for 40 additional nodes.
5. **Establish automated alerting** — at minimum, script-based SLO violation alerts for C2 operator count.

### Governance Preparation

1. **Exercise revocation** — intentionally revoke and re-admit a test node to validate the full governance lifecycle.
2. **Dispute resolution drill** — simulate a contradiction scenario and walk through the resolution path.
3. **Document governance gaps** — any governance weakness exposed during C1 must be logged for C2 gating.

---

## Timeline

```
Week 0:  Confirm operational prerequisites, send C1 invitations
Week 1:  Guided onboarding for 7 new nodes
Week 2:  First SLO measurement, first governance exercise
Week 3:  Subscription filtering assessment, operator feedback collection
Week 4:  C1 retrospective, C2 go/no-go evidence collection
```

---

## Decision Point

At the end of C1 (week 4), the readiness decision for C2 requires:
- All C1 success metrics met
- No unresolved Sev1 incidents
- Operator feedback reviewed and incorporated
- C2 technical and operational prerequisites in progress

If any C1 success metric is not met, extend C1 by 2 weeks and reassess. Do not proceed to C2 with unresolved issues from C1.
