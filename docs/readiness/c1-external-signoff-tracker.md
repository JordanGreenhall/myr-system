# C1 External Signoff Tracker

**Date:** 2026-04-25
**Version:** v1.3.7
**Assessor:** Number Two (XO)
**Overall status:** CONDITIONAL GO — awaiting operator signoffs

---

## Purpose

This is the single authoritative tracker for all external (non-automated) actions required before C1 invitations can be sent. It consolidates requirements from `c1-launch-environment-gate.md`, `c1-operator-briefing-checklist.md`, and the rehearsal gate into one executable checklist.

**No outbound communication was performed by the agent.** All operator notifications must be initiated by the Escalation Contact.

---

## Automated Gate Summary (all pass)

| Gate | Result | Detail |
|------|--------|--------|
| Regression tests | PASS | 539/539, 0 failures |
| Release acceptance | PASS | `npm run test:release` |
| Evidence collection | PASS | 8 pass, 0 fail, 2 warn (no live endpoint — expected) |
| SLO tooling | PASS | `scripts/slo-check.js` exists |
| Pilot scripts | PASS | All 3 scripts present |
| Documentation | PASS | All 7 required docs present |
| Package/tag truth | PASS | v1.3.7, HEAD == origin/main == v1.3.7 tag |

Last automated run: `bash scripts/pilot/c1-rehearsal-gate.sh` — **14 PASS, 0 FAIL, 4 EXTERNAL GATES**

---

## External Signoff Table

### Gate A: Reverse Proxy — TLS & Rate Limiting (per node)

Each C0 operator must deploy a reverse proxy and submit evidence. Reference: `docs/readiness/c1-launch-environment-gate.md`.

**Required evidence per node:**

1. **TLS evidence** — `curl -v https://NODE_URL/myr/health` output showing valid certificate and HTTP 200.
2. **Rate-limit evidence** — 35-request burst output showing HTTP 429 after ~30 requests.

**Verification commands (operator executes on their node):**

```bash
# TLS verification
curl -v https://YOUR_NODE_URL/myr/health 2>&1 | grep -E "(SSL|subject|issuer|HTTP/)"

# Rate-limit verification
for i in $(seq 1 35); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" https://YOUR_NODE_URL/myr/health)
  echo "Request $i: HTTP $CODE"
done

# Save evidence files
curl -v https://YOUR_NODE_URL/myr/health 2>&1 > /tmp/myr-tls-evidence.txt
for i in $(seq 1 35); do
  curl -s -o /dev/null -w "req=$i status=%{http_code}\n" https://YOUR_NODE_URL/myr/health
done > /tmp/myr-ratelimit-evidence.txt
```

**Submission table:**

| Node | Operator | TLS evidence submitted | Rate-limit evidence submitted | Verified by | Date |
|------|----------|:----------------------:|:----------------------------:|:-----------:|:----:|
| n1   |          | [ ]                    | [ ]                          |             |      |
| n2   |          | [ ]                    | [ ]                          |             |      |
| n3   |          | [ ]                    | [ ]                          |             |      |

**Deadline:** 2026-05-02 (7 days from tracker issuance).

---

### Gate B: Operator Briefing & Signoff

A single 60-minute briefing session covering revocation, incident triage, runbooks, and launch-day rehearsal. Reference: `docs/readiness/c1-operator-briefing-checklist.md`.

**Required completion:**

1. All C0 operators attend the briefing.
2. Each operator passes comprehension checks for revocation and incident triage.
3. Each operator completes the launch-day rehearsal (runs `c1-rehearsal-gate.sh` together).
4. Facilitator and all operators sign the final signoff table.

**Signoff table:**

| Role           | Name | Briefing complete | Comprehension confirmed | Signature | Date |
|----------------|------|:-----------------:|:-----------------------:|:---------:|:----:|
| Facilitator    |      | [ ]               | N/A                     |           |      |
| Operator (n1)  |      | [ ]               | [ ]                     |           |      |
| Operator (n2)  |      | [ ]               | [ ]                     |           |      |
| Operator (n3)  |      | [ ]               | [ ]                     |           |      |

**Deadline:** Within 3 days of Gate A completion.

---

### Gate C: Live Node Health Verification

After reverse proxy deployment, verify each node is reachable and healthy through the public URL.

```bash
# Per-node health check
curl -sf https://YOUR_NODE_URL/myr/health | python3 -m json.tool

# Expected: {"status":"ok", ...}
```

| Node | Public URL | Health status | Verified by | Date |
|------|-----------|:-------------:|:-----------:|:----:|
| n1   |           | [ ] ok        |             |      |
| n2   |           | [ ] ok        |             |      |
| n3   |           | [ ] ok        |             |      |

---

### Gate D: Onboarding Rehearsal

Run a live onboarding rehearsal with a test peer to validate the end-to-end C1 invitation flow.

```bash
bash scripts/pilot/onboard-new-peer.sh https://YOUR_NODE_URL https://TEST_PEER_URL
```

| Item | Status | Verified by | Date |
|------|:------:|:-----------:|:----:|
| Test peer successfully onboarded | [ ] | | |
| Peer appears in governance audit | [ ] | | |
| Sync completes without error | [ ] | | |

---

## Escalation Rules

- **Deadline breach (Gate A):** If any operator has not submitted evidence by 2026-05-02, the Escalation Contact must issue a direct follow-up within 24 hours. If no response within 48 hours of deadline, escalate to project lead for a forced GO/NO-GO decision.
- **Briefing unable to schedule:** If the briefing cannot occur within 3 days of Gate A completion, the Escalation Contact must document the reason and set a new date within 5 business days.
- **Node unreachable (Gate C):** If any node fails health checks after proxy deployment, the operator has 48 hours to remediate. The Escalation Contact is notified immediately.

---

## Final GO Condition

```
IF Gate A: all 3 nodes have TLS + rate-limit evidence verified
AND Gate B: all operators briefed with signoff
AND Gate C: all 3 nodes return health status "ok" via public URL
AND Gate D: onboarding rehearsal completed successfully
THEN → GO: Send C1 invitations

IF any gate is incomplete
THEN → NO-GO: Complete the named gate(s) first
```

---

## Artifact Cross-Reference

| Artifact | Path |
|----------|------|
| This tracker | `docs/readiness/c1-external-signoff-tracker.md` |
| Launch environment gate | `docs/readiness/c1-launch-environment-gate.md` |
| Operator briefing checklist | `docs/readiness/c1-operator-briefing-checklist.md` |
| Invite decision | `docs/readiness/c1-invite-decision.md` |
| Decision packet | `docs/readiness/decision-packet.md` |
| Risk register | `docs/readiness/risk-register.md` |
| Evidence report | `artifacts/readiness/evidence-report.json` |
| Rehearsal gate script | `scripts/pilot/c1-rehearsal-gate.sh` |

---

## Agent Attestation

No outbound communication was performed by the agent. This tracker is an internal artifact only. The Escalation Contact is responsible for distributing this tracker to operators and initiating all external actions.
