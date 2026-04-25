# C1 Operator Briefing Checklist

**Date:** 2026-04-24
**Version:** v1.3.6
**Gate status:** BLOCKED — requires briefing session completion

---

## Purpose

This checklist converts the pilot packet into a one-session operator briefing. All C0 operators must complete this briefing before C1 invitations are sent. This is decision-packet criterion #12.

## Briefing Format

- **Duration:** 60 minutes (30 min walkthrough, 15 min rehearsal, 15 min Q&A)
- **Facilitator:** Escalation Contact or Observer
- **Attendees:** All C0 operators (3 minimum)
- **Prerequisites:** Each operator has a running node with reverse proxy deployed (see `c1-launch-environment-gate.md`)

---

## Agenda and Signoff

### Section 1: Revocation Coordination (15 min)

**Key points to cover:**

- [ ] MYR v1.3.x uses local-only revocation — revocation signals propagate via gossip but coordination is out-of-band
- [ ] When to revoke: key compromise, malicious behavior, operator request
- [ ] Revocation command: `curl -X POST https://YOUR_NODE/myr/governance/revoke -d '{"peer_fingerprint":"..."}'`
- [ ] Each operator must revoke independently on their own node
- [ ] Out-of-band notification is REQUIRED: notify all operators via the agreed channel (Signal/etc.) before revoking
- [ ] Quarantine vs. revoke: quarantine isolates a peer pending investigation; revoke is permanent
- [ ] Verify revocation took effect: `curl https://YOUR_NODE/myr/governance/audit`

**Comprehension check:** Each operator verbally confirms they can execute a revocation and know when to use quarantine vs. revoke.

| Operator | Confirmed understanding | Facilitator initials | Date |
|----------|------------------------|---------------------|------|
| _________ | [ ] | _________ | _________ |
| _________ | [ ] | _________ | _________ |
| _________ | [ ] | _________ | _________ |

---

### Section 2: Incident Triage (10 min)

**Key points to cover:**

- [ ] Severity definitions: Sev1 (network-wide), Sev2 (partial degradation), Sev3 (single node)
- [ ] Response times: Sev1 < 1 hour, Sev2 < 15 min notify / < 4 hours resolve, Sev3 < 8 hours
- [ ] Immediate actions for all incidents: capture health snapshot, open incident log, freeze changes
- [ ] Escalation path: Operator -> Observer -> Escalation Contact
- [ ] Reference: `docs/pilot-packet/incident-response-card.md` (print or bookmark)

**Comprehension check:** Each operator can classify a sample scenario by severity.

| Operator | Confirmed understanding | Facilitator initials | Date |
|----------|------------------------|---------------------|------|
| _________ | [ ] | _________ | _________ |
| _________ | [ ] | _________ | _________ |
| _________ | [ ] | _________ | _________ |

---

### Section 3: Recovery Runbooks (5 min)

**Key points to cover:**

- [ ] 5 runbooks exist in `docs/RUNBOOKS.md`
- [ ] Every operator must be familiar with at least 2: **Node Crash Recovery** and **Key Compromise Response**
- [ ] Node Crash: stop, snapshot DB, integrity check, restart or restore
- [ ] Key Compromise: revoke, rotate, re-announce, audit

| Operator | Familiar with crash recovery | Familiar with key compromise | Facilitator initials | Date |
|----------|------------------------------|------------------------------|---------------------|------|
| _________ | [ ] | [ ] | _________ | _________ |
| _________ | [ ] | [ ] | _________ | _________ |
| _________ | [ ] | [ ] | _________ | _________ |

---

### Section 4: Launch-Day Rehearsal (15 min)

Execute the rehearsal gate script together:

```bash
bash scripts/pilot/c1-rehearsal-gate.sh http://localhost:3719
```

Walk through each check. For checks that require a live endpoint, demonstrate using localhost or confirm the operator understands what to verify against their public URL.

**Rehearsal items:**

- [ ] Run `verify-node-health.sh` — all checks PASS
- [ ] Run `npm run test:release` — all tests pass
- [ ] Demonstrate onboarding a peer: `bash scripts/pilot/onboard-new-peer.sh`
- [ ] Demonstrate SLO check: `node scripts/slo-check.js --no-auth`
- [ ] Confirm incident channel is set up and all operators are in it
- [ ] Confirm weekly measurement cadence owner is assigned

| Operator | Rehearsal completed | Facilitator initials | Date |
|----------|---------------------|---------------------|------|
| _________ | [ ] | _________ | _________ |
| _________ | [ ] | _________ | _________ |
| _________ | [ ] | _________ | _________ |

---

### Section 5: Q&A and Role Assignment (15 min)

- [ ] Confirm Escalation Contact assignment: _________________ (backup: _______________)
- [ ] Confirm Observer assignment: _________________
- [ ] Confirm communication channels:
  - Primary (day-to-day): _________________
  - Incident: _________________
  - Weekly review: _________________
- [ ] All operators acknowledge the weekly measurement cadence (see `docs/pilot-packet/measurement-loop.md`)

---

## Final Signoff

All C0 operators and the facilitator must sign below to confirm the briefing is complete.

| Role | Name | Signature/Initials | Date |
|------|------|--------------------|------|
| Facilitator | _________ | _________ | _________ |
| Operator (n1) | _________ | _________ | _________ |
| Operator (n2) | _________ | _________ | _________ |
| Operator (n3) | _________ | _________ | _________ |

---

## Go/No-Go Consequence

- **If ALL operators complete the briefing with signoff:** Criterion #12 is satisfied.
- **If ANY operator cannot attend or fails comprehension checks:** Reschedule within 3 days. C1 invitations are blocked until all operators are briefed.
