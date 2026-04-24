# Incident Response Card

Laminated-card-style reference. Print or bookmark this page.

---

## 1. Classify Severity

| Sev | Impact | Examples | Response Time |
|-----|--------|----------|---------------|
| **1** | Network-wide outage or data integrity breach | Signature validation failure, revocation propagation broken, all syncs failing | Immediate, < 1 hour resolution |
| **2** | Partial degradation, peer subset affected | Some peers unreachable, sync lag > 60s for multiple nodes, gossip imbalance | < 15 min notify lead, < 4 hours resolution |
| **3** | Single node issue, no network impact | One node crashing, local DB corruption, one peer offline | < 8 hours response, < 24 hours resolution |

---

## 2. Immediate Actions

### All Severities

1. **Capture health snapshot**
   ```bash
   curl http://localhost:3719/myr/health
   curl http://localhost:3719/myr/health/node
   curl http://localhost:3719/myr/health/network
   curl http://localhost:3719/myr/metrics
   ```

2. **Open incident log** — record: time, scope, severity, owner, actions taken.

3. **Freeze risky changes** — no deployments, no peer approvals, no key rotations until resolved.

### Sev1 Only

4. **Page on-call operator** immediately.
5. **Notify all peer operators** via pre-agreed channel.
6. **Send initial acknowledgment** (template below).

---

## 3. Diagnose

| Symptom | Likely Cause | Check Command |
|---------|-------------|---------------|
| `auth_required` / `unknown_peer` | Auth header missing or invalid | Verify `X-MYR-Timestamp`, `X-MYR-Nonce`, `X-MYR-Signature` headers |
| `peer_not_trusted` / `forbidden` | Peer revoked or not approved | `myr peer list` — check trust state |
| Sync drift / stale data | Sync lag too high | `curl .../myr/metrics` — check `sync.sync_lag_seconds` |
| Low `peers_active` | Peers offline or unreachable | `curl .../myr/health` — check `peers_active` vs `peers_total` |
| Gossip imbalance | Active view depleted | `curl .../myr/metrics` — check `gossip.active_view_size` vs fanout |
| Hash/signature mismatch | Data corruption or tampering | Check reject traces in server logs |
| `queue_age > 1800` (red status) | Sync queue stalled | Restart server, check disk space and DB integrity |

---

## 4. Recover

### Node Crash (Sev3)
1. Stop node process
2. Snapshot DB files: `cp db/myr.db db/myr.db.bak && cp db/myr.db-wal db/myr.db-wal.bak`
3. Check integrity: `sqlite3 db/myr.db "PRAGMA integrity_check;"`
4. If OK: restart node, verify `/myr/health`
5. If FAIL: restore from last backup, replay recent syncs

### Key Compromise (Sev1)
1. Revoke compromised peer: `curl -X POST .../myr/governance/revoke -d '{"peer_fingerprint":"..."}'`
2. Rotate keypair: `curl -X POST .../myr/governance/key-rotate`
3. Re-announce to all trusted peers
4. Audit: `curl .../myr/governance/audit`

### Network Partition (Sev2)
1. Identify affected peers: check `/myr/health/network` for low reachability
2. Re-seed trusted peers manually
3. Monitor healing: watch `peers_active` and `sync_lag_seconds`
4. Throttle traffic until sync lag stabilizes

### Gossip Contamination (Sev2)
1. Detect: repeated sync failures, abnormal IHAVE/IWANT ratios
2. Flush stale passive view entries
3. Re-bootstrap from known trusted peers only
4. Monitor `active_view_size` and `passive_view_size` returning to normal

### Data Corruption (Sev2)
1. Identify suspect reports from sync rejection traces
2. Quarantine: `curl -X POST .../myr/governance/quarantine -d '{"report_id":"..."}'`
3. Re-fetch valid reports from trusted peers
4. Verify signatures match

---

## 5. Communicate

### Initial Acknowledgment (Sev1/Sev2)
```
INCIDENT: MYR network incident affecting [scope].
SEVERITY: [Sev1/Sev2]
STARTED: [time]
OWNER: [name]
INVESTIGATING: [brief description]
NEXT UPDATE: [time, e.g., 30 minutes]
```

### Mitigation Update
```
UPDATE: Mitigation active — [action taken].
STATUS: [current state]
DATA INTEGRITY RISK: [low/medium/high]
NEXT UPDATE: [time]
```

### Resolution
```
RESOLVED: [time]
ROOT CAUSE: [cause]
RECOVERY: [actions taken]
FOLLOW-UP: [items for post-mortem]
DURATION: [total time]
```

---

## 6. Post-Incident

- [ ] Write post-mortem within 48 hours
- [ ] Update runbooks if new failure mode discovered
- [ ] Capture incident as a MYR falsification report (yield_type: falsification)
- [ ] Review whether cohort gate criteria need updating
- [ ] Share learnings with all peer operators
