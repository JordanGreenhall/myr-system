# MYR Readiness Decision Packet

**Date:** 2026-04-24
**Version:** v1.3.4
**Current cohort:** C0 (3 nodes)
**Assessment:** CONDITIONAL GO for C1 expansion

---

## Executive Summary

MYR is a distributed methodological intelligence network targeting 10,000+ participants. The system is currently operational at C0 (3 nodes) with v1.3.4 released and verified.

### Quantitative Position

| Metric | Value |
|--------|-------|
| Tests passing | 539 / 539 (100%) |
| Test suites | 166 |
| Scale acceptance tests | 4 files, 62 cases (N=50-10,000) |
| Security assessment | CONDITIONAL PASS (Worf, 2026-04-24) |
| Core modules | 25 (lib/) |
| Documentation files | 31 (docs/) |
| Recovery runbooks | 5 |
| SLOs defined | 5 |
| Known unacceptable risks | 0 |
| Coordinator endpoints | 3 (register, route, domains) |
| Gossip protocol | IHAVE/IWANT + Bloom anti-entropy |
| Message complexity | O(N*F) — 166x improvement over O(N^2) at N=1,000 |

### What Exists Today

**Proven and tested:**
- Ed25519 peer authentication with replay protection
- Incremental pull-based sync with dedup and signature verification
- Gossip transport (push-lazy IHAVE/IWANT, peer sampling, TTL decay)
- Bloom filter anti-entropy for bandwidth optimization
- Subscription-driven domain filtering
- 4-stage participation model (local-only / provisional / bounded / trusted-full)
- Trust-weighted yield scoring and recall
- Governance revocation + quarantine with audit trail
- Contradiction detection (observation vs. falsification)
- Key rotation mechanism
- Rate limiting (60 req/min per peer)
- NAT traversal via relay
- Domain coordinator routing with 10,000-peer validated economics
- Onboarding with 3-way fingerprint verification

**Not yet proven at scale:**
- Coordinator election protocol (single-instance in-memory)
- Cross-domain coordinator bridging
- Subscription enforcement as mandatory
- Structured logging (currently console-based)
- Automated partition detection and healing
- Field length validation on text inputs

---

## Cohort Expansion Timeline

```
C0 (3)  ──GO?──>  C1 (10)  ──GO?──>  C2 (50)  ──GO?──>  C3 (200)  ──GO?──>  C4 (1,000)  ──GO?──>  C5 (10,000+)
 NOW               +4 wks              +6 wks              +8 wks               +12 wks               continuous
```

---

## Transition: C0 (3 nodes) to C1 (10 nodes)

### Go Criteria (ALL must pass)

| # | Criterion | Current Status |
|---|-----------|---------------|
| 1 | All regression tests pass (539/539) | PASS |
| 2 | Scale acceptance tests pass at N >= 10 | PASS (tested to N=200) |
| 3 | Gossip transport operational (IHAVE/IWANT, peer sampling) | PASS (v1.3.3) |
| 4 | Governance signal propagation tested | PASS (v1.3.3) |
| 5 | Onboarding procedure documented | PASS (NODE-ONBOARDING.md) |
| 6 | Operator guide available | PASS (OPERATOR-GUIDE.md) |
| 7 | Support operations defined (Sev1/2/3 triage) | PASS (SUPPORT-OPERATIONS.md) |
| 8 | At least 3 recovery runbooks | PASS (5 runbooks) |
| 9 | SLOs defined and measurable | PASS (5 SLOs, scripts/slo-check.js) |
| 10 | Security assessment: no unacceptable risks | PASS (RELEASE-GATE.md) |
| 11 | Reverse proxy deployed for unauthenticated endpoint protection | **NOT YET VERIFIED** |
| 12 | Operators briefed on local-only revocation coordination | **NOT YET VERIFIED** |

### No-Go Criteria (ANY ONE blocks)

| # | Blocker | Status |
|---|---------|--------|
| 1 | Any regression test failure | Clear |
| 2 | Unacceptable security risk identified | Clear |
| 3 | Gossip dissemination fails above 5 peers | Clear (tested to N=200) |
| 4 | No incident response procedure | Clear |
| 5 | Data loss or corruption in sync under test | Clear |

### Conditions for GO

Two operational items remain unverified (reverse proxy deployment, operator briefing on revocation). These are deployment/human process items, not code gaps. Once confirmed:

**Recommendation: CONDITIONAL GO for C1.**

The codebase is ready. The condition is operational: confirm deployment posture and operator readiness.

---

## Transition: C1 (10 nodes) to C2 (50 nodes)

### Go Criteria

| # | Criterion | Current Status |
|---|-----------|---------------|
| 1 | C1 operated for >= 4 weeks without Sev1 incident | Not yet started |
| 2 | Sync freshness SLO met (95% of checks <= 60s lag) | Not yet measured in production |
| 3 | Gossip health SLO met (99% active view >= fanout-1) | Not yet measured in production |
| 4 | Subscription filtering validated with real domain diversity | Not yet measured |
| 5 | At least 1 governance action (revoke or quarantine) exercised in production | Not yet exercised |
| 6 | Onboarding time < 1 hour for guided participants | Not yet measured |
| 7 | Bloom anti-entropy bandwidth savings confirmed | Tested in unit tests, not production |
| 8 | Operator feedback incorporated | Not yet collected |

### No-Go Criteria

| # | Blocker |
|---|---------|
| 1 | Any Sev1 incident unresolved from C1 |
| 2 | Sync freshness SLO consistently violated |
| 3 | Gossip partition detected and unresolved |
| 4 | Operator reports unmanageable support burden |

### Key Dependencies

- Self-serve onboarding flow (referral invite model)
- Subscription enforcement design finalized
- Metrics collection from production C1 nodes

---

## Transition: C2 (50 nodes) to C3 (200 nodes)

### Go Criteria

| # | Criterion |
|---|-----------|
| 1 | C2 operated for >= 6 weeks without Sev1 |
| 2 | All 5 SLOs met in production |
| 3 | Coordinator prototype design reviewed and validated |
| 4 | Anti-entropy Bloom filter performance confirmed at N=50 |
| 5 | Contradiction resolution workflow operational |
| 6 | Onboarding time < 30 minutes (self-serve) |
| 7 | Routing economics data collected: bandwidth/relay costs per peer |
| 8 | At least 1 dispute resolution drill completed |

### No-Go Criteria

| # | Blocker |
|---|---------|
| 1 | Bandwidth cost per peer unsustainable (> 2x expected model) |
| 2 | Governance propagation SLO violated (> 120s) |
| 3 | Coordinator prototype not validated |

### Key Dependencies

- Coordinator election protocol implemented
- Cross-domain bridging design
- Automated onboarding pipeline (< 30 min)

---

## Transition: C3 (200 nodes) to C4 (1,000 nodes)

### Go Criteria

| # | Criterion |
|---|-----------|
| 1 | C3 operated >= 8 weeks without Sev1 |
| 2 | Coordinator election protocol tested in production |
| 3 | Cross-domain coordinator bridging operational |
| 4 | Tiered governance implemented (coordinator > council > appeal) |
| 5 | Routing cost Gini coefficient < 0.6 across relay nodes |
| 6 | Self-healing peer sampling validated under > 5%/day churn |
| 7 | Structured logging operational |
| 8 | Network partition detection + automated healing tested |
| 9 | Onboarding time < 10 minutes |

### No-Go Criteria

| # | Blocker |
|---|---------|
| 1 | Coordinator single point of failure unresolved |
| 2 | Relay load distribution unfair (Gini > 0.8) |
| 3 | Governance latency > 5 minutes at N=200 |

### Key Dependencies

This is the **critical gate**. Everything aspirational must be production-ready here:
- Coordinator election and coordination
- Mandatory subscription enforcement
- Structured logging with request-level access logs
- Field length validation
- Automated partition healing

---

## Overall Recommendation

**C0 to C1: CONDITIONAL GO.** Two operational prerequisites remain (reverse proxy, operator briefing). No code blockers.

**C1 to C2: NOT YET ASSESSABLE.** Requires 4 weeks of C1 production data.

**C2+: Planning phase.** The technical foundations are strong. The critical-path risk is coordinator production-readiness before C4.

---

## Evidence

Run `scripts/readiness/collect-evidence.sh` to generate a machine-readable evidence report at `artifacts/readiness/evidence-report.json`.
