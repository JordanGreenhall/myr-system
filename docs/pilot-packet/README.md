# MYR Pilot Packet

Executable pilot packet for MYR network operators. Follow the steps below in order.

## Prerequisites

- Node.js 18+ installed
- MYR system cloned and `npm install` completed
- Access to a machine with a public IP or Tailscale/Cloudflare tunnel

## Execution Order

| Step | Document | Purpose |
|------|----------|---------|
| 1 | [Operator Setup Checklist](checklist-operator-setup.md) | Install, configure, and verify a running MYR node |
| 2 | [Cohort Onboarding Checklist](checklist-cohort-onboarding.md) | Onboard peers into cohorts C0 through C2 |
| 3 | [Support Roles](support-roles.md) | Understand who does what during the pilot |
| 4 | [Measurement Loop](measurement-loop.md) | Weekly measurement cadence and action thresholds |
| 5 | [Incident Response Card](incident-response-card.md) | Handle incidents by severity |

## Automation Scripts

Located in `scripts/pilot/`:

| Script | Purpose |
|--------|---------|
| `verify-node-health.sh` | Run health and metrics checks, output pass/fail |
| `verify-cohort-status.sh` | Check peer count, sync status, gossip view for a cohort |
| `onboard-new-peer.sh` | Automate new-peer onboarding with verification |

## Quick Start

```bash
# 1. Set up your node
#    Follow checklist-operator-setup.md, or run:
cp config.example.json config.json
node scripts/myr-keygen.js
node server/index.js &

# 2. Verify node health
bash scripts/pilot/verify-node-health.sh http://localhost:3719

# 3. Onboard a peer
bash scripts/pilot/onboard-new-peer.sh http://localhost:3719 https://peer-node:3719

# 4. Check cohort status
bash scripts/pilot/verify-cohort-status.sh http://localhost:3719
```

## Acceptance Test

```bash
npm test -- --grep "pilot-acceptance"
```

Verifies all pilot-packet docs exist, scripts are executable, and checklists reference real endpoints.
