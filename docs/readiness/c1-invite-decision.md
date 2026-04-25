# C1 Invite Decision

**Date:** 2026-04-24
**Version:** v1.3.6
**Assessor:** Number Two (XO)
**Decision:** CONDITIONAL GO WITH EXTERNAL ACTION

---

## Decision Summary

MYR is ready for C1 (10-node) expansion pending two operator-level actions. No code blockers exist. No technical no-go criteria are triggered. The condition is entirely operational.

---

## Evidence

### Technical Readiness (ALL PASS)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Regression tests (539/539) | PASS | `npm test` — 0 failures |
| 2 | Scale acceptance tests (N >= 10) | PASS | Tested to N=200 |
| 3 | Gossip transport (IHAVE/IWANT, peer sampling) | PASS | v1.3.3+ |
| 4 | Governance signal propagation | PASS | v1.3.3+ |
| 5 | Onboarding procedure documented | PASS | `docs/pilot-packet/checklist-cohort-onboarding.md` |
| 6 | Operator guide | PASS | `docs/OPERATOR-GUIDE.md` |
| 7 | Support operations (Sev1/2/3) | PASS | `docs/SUPPORT-OPERATIONS.md` |
| 8 | Recovery runbooks (>= 3) | PASS | 5 runbooks in `docs/RUNBOOKS.md` |
| 9 | SLOs defined and measurable | PASS | 5 SLOs, `scripts/slo-check.js` |
| 10 | Security assessment | PASS | No unacceptable risks |
| 11 | Reverse proxy deployed | **GATED** | See below |
| 12 | Operators briefed on revocation | **GATED** | See below |

### No-Go Criteria (ALL CLEAR)

| # | Blocker | Status |
|---|---------|--------|
| 1 | Any regression test failure | Clear |
| 2 | Unacceptable security risk | Clear |
| 3 | Gossip dissemination fails above 5 peers | Clear (tested to N=200) |
| 4 | No incident response procedure | Clear |
| 5 | Data loss or corruption in sync under test | Clear |

### Evidence Report

`artifacts/readiness/evidence-report.json`: 9 pass, 0 fail, 1 warn (no live endpoint — expected in dev environment).

---

## External Actions Required Before Invitations

### Action 1: Reverse Proxy Deployment

- **What:** Each C0 operator deploys nginx or Caddy with TLS termination and IP-based rate limiting (30 req/min) on unauthenticated endpoints.
- **Artifact:** `docs/readiness/c1-launch-environment-gate.md` — contains exact commands, verification steps, and signoff table.
- **Owner:** Each C0 operator (n1, n2, n3).
- **Verifier:** Escalation Contact.
- **Deadline:** 7 days from gate issuance (2026-05-01).

### Action 2: Operator Briefing

- **What:** Single 60-minute briefing session covering revocation coordination, incident triage, recovery runbooks, and launch-day rehearsal.
- **Artifact:** `docs/readiness/c1-operator-briefing-checklist.md` — contains agenda, comprehension checks, and signoff table.
- **Owner:** Escalation Contact (facilitator).
- **Attendees:** All C0 operators.
- **Deadline:** Within 3 days of reverse proxy signoff.

---

## Rehearsal Gate

An executable rehearsal script validates all automated checks and names the exact external gates:

```bash
bash scripts/pilot/c1-rehearsal-gate.sh http://localhost:3719
```

This script runs regression tests, release acceptance, evidence collection, node health, documentation checks, and SLO tooling verification. It outputs a `CONDITIONAL GO WITH EXTERNAL ACTION` decision with the remaining operator actions listed.

---

## Decision Logic

```
IF all regression tests pass
AND all no-go criteria are clear
AND evidence report shows 0 failures
AND reverse proxy evidence is submitted and signed off (Action 1)
AND operator briefing is completed with signoff (Action 2)
THEN → GO: Send C1 invitations

IF any automated check fails
THEN → NO-GO: Fix the failure, re-run rehearsal gate

IF automated checks pass but external actions are incomplete
THEN → CONDITIONAL GO WITH EXTERNAL ACTION: Complete the named actions, then GO
```

---

## Current State

**CONDITIONAL GO WITH EXTERNAL ACTION.**

All automated/technical checks pass. Two external operator actions must be completed before C1 invitations can be sent:

1. Reverse proxy deployment with evidence (`c1-launch-environment-gate.md`)
2. Operator briefing with signoff (`c1-operator-briefing-checklist.md`)

---

## Next Forced Move

The Escalation Contact must:

1. Distribute `c1-launch-environment-gate.md` to all C0 operators immediately.
2. Set a deadline for reverse proxy evidence submission (recommended: 2026-05-01).
3. Schedule the operator briefing session within 3 days of evidence submission.
4. After both are signed off, re-run `bash scripts/pilot/c1-rehearsal-gate.sh` against each node's live URL.
5. If the script outputs `GO`, send C1 invitations.

---

## Artifact Paths

| Artifact | Path |
|----------|------|
| Decision packet | `docs/readiness/decision-packet.md` |
| Risk register | `docs/readiness/risk-register.md` |
| Next cohort objective | `docs/readiness/next-cohort-objective.md` |
| Evidence report | `artifacts/readiness/evidence-report.json` |
| Launch environment gate | `docs/readiness/c1-launch-environment-gate.md` |
| Operator briefing checklist | `docs/readiness/c1-operator-briefing-checklist.md` |
| Rehearsal gate script | `scripts/pilot/c1-rehearsal-gate.sh` |
| C1 invite decision | `docs/readiness/c1-invite-decision.md` (this file) |
