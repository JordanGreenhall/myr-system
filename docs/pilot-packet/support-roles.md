# Support Roles

Role definitions for MYR pilot support operations.

---

## Roles

### Operator

**Who**: Each node runner. Every pilot participant is an operator of their own node.

**Responsibilities**:
- Keep their MYR node running and reachable
- Deploy and maintain reverse proxy with rate limiting
- Capture yield reports regularly (target: weekly minimum)
- Verify reports in their queue (`node scripts/myr-verify.js --queue`)
- Approve or reject peer introductions within 48 hours
- Monitor their node health daily (`/myr/health/node`)
- Participate in weekly measurement reviews
- Rotate keys before 90-day expiry

**Escalation path**: Operator -> Observer -> Escalation Contact

**Tools**:
- `bash scripts/pilot/verify-node-health.sh http://localhost:3719`
- `myr peer list`, `myr sync-all`
- `node scripts/myr-verify.js --queue`

---

### Observer

**Who**: Designated experienced operator(s) who monitor network-wide health. In C0, this is typically the network founder or lead operator.

**Count**: 1 per cohort (C0-C1), 2+ for C2+.

**Responsibilities**:
- Run weekly measurement loop (see [Measurement Loop](measurement-loop.md))
- Check all nodes' health endpoints weekly
- Track cohort gate progress and report readiness
- Identify inactive operators and follow up
- Review governance audit logs for anomalies
- Compile and distribute the weekly pilot report
- Coordinate peer introductions across the cohort
- Maintain the operator contact list

**Escalation path**: Observer -> Escalation Contact

**Tools**:
- `bash scripts/pilot/verify-cohort-status.sh http://localhost:3719`
- `node scripts/slo-check.js`
- `curl .../myr/governance/audit`
- `curl .../myr/health/network`

---

### Escalation Contact

**Who**: Project lead or designated technical authority. Handles Sev1/Sev2 incidents and makes cohort advancement decisions.

**Count**: 1 (with a named backup).

**Responsibilities**:
- Respond to Sev1 incidents immediately (< 1 hour)
- Respond to Sev2 incidents within 15 minutes of notification
- Make go/no-go decisions on cohort gate advancement
- Approve or reject key rotations and governance actions that affect the network
- Coordinate out-of-band revocation (v1.3.1 limitation: revocation is local-only)
- Own post-incident reviews and runbook updates
- Approve new peer introductions for C0-C1 (direct invite cohorts)

**Escalation path**: Escalation Contact is the final escalation tier for the pilot.

**Tools**:
- All observer tools
- `curl -X POST .../myr/governance/revoke`
- `curl -X POST .../myr/governance/key-rotate`
- `curl -X POST .../myr/governance/quarantine`

---

## On-Call Schedule (C0-C1)

For C0-C1 (3-10 nodes), formal on-call is not required. Instead:

- **Primary**: Escalation Contact is reachable during business hours + 1 hour response after-hours for Sev1.
- **Backup**: Observer can perform basic triage (health checks, restart guidance) if Escalation Contact is unavailable.

For C2+ (50+ nodes), establish a formal rotation:

| Role | Rotation | Coverage |
|------|----------|----------|
| On-call operator | Weekly | Business hours |
| On-call escalation | Weekly | 24/7 for Sev1 |

---

## Communication Channels

Define these before pilot launch:

| Channel | Purpose | Who |
|---------|---------|-----|
| Primary (e.g., Signal group) | Day-to-day coordination, peer approvals | All operators |
| Incident (e.g., dedicated thread) | Active incident communication | Observer + Escalation Contact |
| Weekly review (e.g., shared doc) | Measurement loop results | Observer posts, all read |

---

## Role Assignment Template

```
Pilot: MYR C0
Date: YYYY-MM-DD

Escalation Contact: [Name] ([contact])
  Backup: [Name] ([contact])

Observer: [Name] ([contact])

Operators:
  - Node n1: [Name] ([contact]) — [node URL]
  - Node n2: [Name] ([contact]) — [node URL]
  - Node n3: [Name] ([contact]) — [node URL]
```
