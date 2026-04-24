# Audit Evidence Paths

For each governance action: what evidence is created, where it is stored, how to retrieve it, and the chain of custody from detection through resolution.

---

## 1. Revoke (Peer Trust Revocation)

### Evidence created

| Evidence | Description |
|----------|-------------|
| Peer record update | `trust_level` set to `'revoked'` in `myr_peers` |
| Trace event | Row in `myr_traces` with `event_type = 'revoke'`, outcome, actor key, metadata (previous trust level, revocation timestamp) |
| Governance signal | Row in `myr_governance_signals` with `action_type = 'revoke'`, cryptographic signature, TTL, hop count |

### Storage locations

| Table | Key fields |
|-------|-----------|
| `myr_peers` | `node_id` (PK), `public_key`, `trust_level`, `participation_stage`, `stage_changed_at`, `stage_evidence` |
| `myr_traces` | `id` (PK), `timestamp`, `event_type = 'revoke'`, `actor_key`, `outcome`, `metadata` (JSON with `previous_trust_level`, `revoked_at`) |
| `myr_governance_signals` | `signal_id` (PK), `action_type = 'revoke'`, `target_id` (peer public key), `payload` (JSON), `signer_public_key`, `signature`, `ttl`, `hop_count`, `created_at` |

### Retrieval

| Query | Method |
|-------|--------|
| API | `GET /myr/governance/audit?limit=N` → `audit.revocations` (filtered traces) and `audit.governance_signals` (all signals) |
| Direct SQL | `SELECT * FROM myr_traces WHERE event_type = 'revoke' ORDER BY timestamp DESC` |
| Direct SQL | `SELECT * FROM myr_governance_signals WHERE action_type = 'revoke' ORDER BY created_at DESC` |
| Peer status | `SELECT node_id, public_key, trust_level, participation_stage FROM myr_peers WHERE trust_level = 'revoked'` |

### Retention policy recommendation

- `myr_traces`: Retain indefinitely. Revocation history is critical for compliance and incident investigation.
- `myr_governance_signals`: Retain indefinitely. Signals serve as cryptographic proof of revocation decisions.
- `myr_peers`: Revoked rows should never be deleted. The `trust_level = 'revoked'` state is the persistent record.

---

## 2. Quarantine (Yield Isolation)

### Evidence created

| Evidence | Description |
|----------|-------------|
| Quarantine record | Row in `myr_quarantined_yields` with yield ID, operator signature, reason, status |
| Trace event | Row in `myr_traces` with `event_type = 'quarantine'`, outcome, actor key, metadata |
| Governance signal | Row in `myr_governance_signals` with `action_type = 'quarantine'` (propagated to network) |

### Storage locations

| Table | Key fields |
|-------|-----------|
| `myr_quarantined_yields` | `id` (PK auto), `yield_id` (UNIQUE), `quarantined_at`, `quarantined_by`, `operator_signature`, `reason`, `status` ('active'/'released'), `metadata` (JSON) |
| `myr_traces` | `id` (PK), `timestamp`, `event_type = 'quarantine'`, `actor_key`, `outcome`, `metadata` |
| `myr_governance_signals` | `signal_id` (PK), `action_type = 'quarantine'`, `target_id` (yield ID), `payload`, `signer_public_key`, `signature` |

### Retrieval

| Query | Method |
|-------|--------|
| API | `GET /myr/governance/audit?limit=N` → `audit.quarantines` (traces) and `audit.quarantined_yields` (current state) |
| Active quarantines | `SELECT * FROM myr_quarantined_yields WHERE status = 'active'` |
| All quarantines | `SELECT * FROM myr_quarantined_yields ORDER BY quarantined_at DESC` |
| Direct SQL | `SELECT * FROM myr_traces WHERE event_type = 'quarantine' ORDER BY timestamp DESC` |

### Retention policy recommendation

- `myr_quarantined_yields`: Retain indefinitely. Even `released` quarantines should be kept for audit trail.
- `myr_traces`: Retain indefinitely. Quarantine decisions are compliance-relevant.
- Quarantined yield data in `myr_reports`: Do not delete the yield itself; the quarantine exclusion in recall (`NOT EXISTS` subquery) handles suppression without data destruction.

---

## 3. Key Rotation

### Evidence created

| Evidence | Description |
|----------|-------------|
| Peer record update | `public_key` updated to new key, `previous_public_key` tracked in `myr_peers` |
| Key rotation announcement | Structured JSON with `old_public_key`, `new_public_key`, `endorsement_signature` (signed by old key) |
| Governance signal | Row in `myr_governance_signals` with `action_type = 'key_rotation'`, payload containing rotation announcement |
| Trace event | Row in `myr_traces` with event_type documenting the rotation |

### Storage locations

| Table | Key fields |
|-------|-----------|
| `myr_peers` | `public_key` (updated to new), `previous_public_key` (added field tracking old key) |
| `myr_governance_signals` | `signal_id` (PK), `action_type = 'key_rotation'`, `target_id` (node ID), `payload` (JSON with old key, new key, endorsement signature), `signer_public_key` (old key), `signature` |
| `myr_traces` | `id` (PK), `timestamp`, `event_type`, `actor_key`, `outcome`, `metadata` |

### Retrieval

| Query | Method |
|-------|--------|
| API | `GET /myr/governance/audit?limit=N` → `audit.governance_signals` filtered by `action_type = 'key_rotation'` |
| Direct SQL | `SELECT * FROM myr_governance_signals WHERE action_type = 'key_rotation' ORDER BY created_at DESC` |
| Peer key history | `SELECT node_id, public_key, previous_public_key FROM myr_peers WHERE node_id = ?` |

### Verification

Key rotation announcements include an `endorsement_signature` created by the old private key over the canonical rotation JSON. Verify with:

```javascript
const { verifyKeyRotationAnnouncement } = require('./lib/key-rotation');
const valid = verifyKeyRotationAnnouncement(announcement); // true if old key endorses new key
```

### Retention policy recommendation

- `myr_governance_signals`: Retain indefinitely. Key rotation signals are the cryptographic chain of key custody.
- `myr_peers.previous_public_key`: Retain indefinitely. Provides key lineage for forensic analysis.
- Consider maintaining a full key history table if nodes rotate keys multiple times.

---

## 4. Contradiction Resolution

### Evidence created

| Evidence | Description |
|----------|-------------|
| Contradiction record update | `resolved_at`, `resolved_by`, `resolution_note` set in `myr_contradictions` |
| Resolution record | Immutable row in `myr_contradiction_resolutions` with resolution details and optional signature |
| Governance signal (optional) | `action_type = 'resolve_contradiction'` signal if network propagation needed |

### Storage locations

| Table | Key fields |
|-------|-----------|
| `myr_contradictions` | `id` (PK auto), `yield_a_id`, `yield_b_id`, `domain_tag`, `contradiction_type` ('observation_vs_falsification' / 'opposing_confidence'), `details` (JSON), `detected_at`, `resolved_at`, `resolved_by`, `resolution_note` |
| `myr_contradiction_resolutions` | Immutable audit log: `contradiction_id`, `resolved_by`, `resolution_note`, `resolution_signature`, `resolved_at` |
| `myr_governance_signals` | `signal_id` (PK), `action_type = 'resolve_contradiction'` (if propagated) |

### Retrieval

| Query | Method |
|-------|--------|
| API | `GET /myr/governance/audit?limit=N` → `audit.contradiction_resolutions` |
| Active contradictions | `getStoredContradictions(db, domain, { includeResolved: false })` |
| All contradictions | `getStoredContradictions(db, domain, { includeResolved: true })` |
| Resolution history | `listContradictionResolutions(db, { limit: 100, contradictionId: id })` |
| Direct SQL | `SELECT * FROM myr_contradictions WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC` |
| Direct SQL | `SELECT * FROM myr_contradiction_resolutions ORDER BY resolved_at DESC` |

### Retention policy recommendation

- `myr_contradictions`: Retain indefinitely. Both resolved and unresolved contradictions are part of the knowledge quality record.
- `myr_contradiction_resolutions`: Retain indefinitely. This is the immutable audit log — never delete resolution records.
- Resolved contradictions remain queryable via `includeResolved: true` for forensic review.

---

## Chain of Custody

The complete evidence chain for any governance action follows this path:

```
Detection
  → An anomaly is identified (manual investigation, contradiction detection, rate limiter trigger)

Signal Creation
  → Operator initiates action via governance API endpoint
  → System creates cryptographically signed governance signal (Ed25519)
  → Signal stored in myr_governance_signals with unique signal_id (SHA-256)
  → Trace event recorded in myr_traces with timestamp, actor, outcome

Application
  → Signal applied locally:
    - Revoke: myr_peers.trust_level = 'revoked'
    - Quarantine: row inserted in myr_quarantined_yields
    - Key rotation: myr_peers.public_key updated
    - Contradiction resolution: myr_contradictions.resolved_at set, myr_contradiction_resolutions row created

Propagation
  → If TTL > 1, signal forwarded to gossip peers (fanout=5)
  → Each relay increments hop_count and decrements TTL
  → Receiving peers validate signature, deduplicate by signal_id, apply locally
  → Propagation stops when TTL reaches 1 (no further forwarding)

Audit Retrieval
  → GET /myr/governance/audit returns all evidence categories
  → Each evidence record links back to:
    - The actor (signer_public_key / actor_key)
    - The target (target_id / yield_id / node_id)
    - The action (action_type / event_type)
    - The time (created_at / timestamp)
    - The cryptographic proof (signature / operator_signature / endorsement_signature)
```

### Cross-referencing evidence

To reconstruct the full history of a governance event:

1. **Start with the governance signal:** `SELECT * FROM myr_governance_signals WHERE target_id = ?`
2. **Find the trace:** `SELECT * FROM myr_traces WHERE actor_key = ? AND event_type = ? AND timestamp BETWEEN ? AND ?`
3. **Check the effect:**
   - Revoke: `SELECT trust_level FROM myr_peers WHERE public_key = ?`
   - Quarantine: `SELECT * FROM myr_quarantined_yields WHERE yield_id = ?`
   - Key rotation: `SELECT public_key, previous_public_key FROM myr_peers WHERE node_id = ?`
   - Contradiction: `SELECT * FROM myr_contradiction_resolutions WHERE contradiction_id = ?`
4. **Verify propagation:** Check `hop_count` values across network peers' `myr_governance_signals` for the same `signal_id`
