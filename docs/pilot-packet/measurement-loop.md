# Measurement Loop

Weekly measurement cadence for pilot operations. Run every Monday (or your team's agreed day).

---

## Weekly Measurement Checklist

### 1. Node Health (Per Node)

**Source**: `GET /myr/health/node`

| Metric | Where to Find | Green | Yellow | Red |
|--------|--------------|-------|--------|-----|
| Node status | `status` field | `green` | `yellow` | `red` |
| Queue age | `metrics.queue_age_seconds` | <= 300s | <= 1800s | > 1800s |
| Uptime | `metrics.uptime_seconds` | > 604800 (7d) | > 86400 (1d) | < 86400 |

**Action if Yellow**: investigate sync queue, check disk space.
**Action if Red**: follow [Incident Response Card](incident-response-card.md), Sev3.

### 2. Sync Freshness (Per Node)

**Source**: `GET /myr/metrics`

| Metric | Where to Find | Target | Action Threshold |
|--------|--------------|--------|-----------------|
| Sync lag | `sync.sync_lag_seconds` | <= 60s | > 60s: investigate peer connectivity |
| Last sync | `sync.last_sync_at` | < 30 min ago | > 1 hour: manual `myr sync-all` |
| Peers active | `GET /myr/health` -> `peers_active` | All peers | < expected: check offline peers |

**SLO**: 95% of checks show sync_lag <= 60s.

### 3. Gossip Health (Per Node)

**Source**: `GET /myr/metrics`

| Metric | Where to Find | Target | Action Threshold |
|--------|--------------|--------|-----------------|
| Active view size | `gossip.active_view_size` | >= fanout (default 5) | < (fanout - 1): re-bootstrap |
| IHAVE sent/received | `gossip.ihave_sent`, `ihave_received` | Both > 0 | Either 0: gossip broken |
| IWANT sent/received | `gossip.iwant_sent`, `iwant_received` | Both > 0 | Either 0: no report exchange |

**SLO**: 99% of checks show active_view_size >= (fanout - 1).

### 4. Yield Production (Network-Wide)

**Source**: `GET /myr/reports` + `GET /myr/metrics`

| Metric | How to Measure | C0-C1 Target | C2 Target |
|--------|---------------|-------------|-----------|
| Weekly yield rate | Count reports created this week | >= 80% of nodes contribute | >= 70% |
| Yield quality | Reports with operator_rating >= 3 | >= 60% | >= 60% |
| Falsifications | Reports with yield_type = falsification | >= 1 per week | >= 5% of total |
| Verified exports | `node scripts/myr-export.js --since LAST_MONDAY` | Growing week over week | Growing |

**Action if below target**: reach out to inactive operators, check if onboarding issues exist.

### 5. Governance & Trust (Network-Wide)

**Source**: `GET /myr/governance/audit`

| Metric | How to Measure | Target | Action Threshold |
|--------|---------------|--------|-----------------|
| Open revocations | Audit events with type = revocation | 0 unresolved | Any: investigate immediately |
| Quarantined reports | Audit events with type = quarantine | Reviewed within 7 days | > 7 days unresolved: escalate |
| Contradiction clusters | `GET /myr/contradictions` per domain | Reviewed within 7 days | > 7 days: resolve or document |
| Key rotation age | Last key rotation per node | < 90 days | > 90 days: rotate |

### 6. Peer Churn (Network-Wide)

| Metric | How to Measure | C0-C1 Target | Action Threshold |
|--------|---------------|-------------|-----------------|
| Unreachable peers | `peers_total - peers_active` from health | < 10% for > 48h | > 10%: contact operators |
| Onboarding pipeline | Pending peer introductions | Cleared within 48h | > 48h pending: follow up |

---

## Automated Measurement

Run the health check script across all nodes:

```bash
# Single node
bash scripts/pilot/verify-node-health.sh http://localhost:3719

# Cohort status
bash scripts/pilot/verify-cohort-status.sh http://localhost:3719
```

Run the SLO checker:

```bash
node scripts/slo-check.js
```

---

## Weekly Report Template

```
## MYR Pilot — Week of [DATE]

### Node Health
- Nodes green: X/Y
- Nodes yellow: X (list)
- Nodes red: X (list + incident refs)

### Sync
- Sync freshness SLO: XX% (target: 95%)
- Longest sync lag: Xs (node: nX)

### Gossip
- Gossip health SLO: XX% (target: 99%)
- Active view coverage: X/Y nodes at fanout

### Yield
- Reports captured: X (delta: +/- vs last week)
- Quality (rated 3+): XX%
- Falsifications: X

### Governance
- Open revocations: X
- Unresolved contradictions: X
- Key rotations due: X nodes

### Churn
- Peers unreachable >48h: X
- Pending onboarding: X

### Actions for Next Week
- [ ] ...
```

---

## Cohort Gate Review

At the end of each measurement cycle, check whether the current cohort is ready to advance:

| Gate | Criteria | Consecutive Weeks Required |
|------|---------|---------------------------|
| C0 -> C1 | All C0 metrics met | 2 weeks |
| C1 -> C2 | All C1 metrics met | 3 weeks |
| C2 -> C3 | All C2 metrics met | 4 weeks |

See [Cohort Onboarding Checklist](checklist-cohort-onboarding.md) for full gate criteria.
