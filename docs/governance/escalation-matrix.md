# Escalation Matrix

Severity levels, response responsibilities, authorized actions, and governance signal configuration for MYR network governance events.

---

## Severity Levels

### INFO

**Definition:** Routine governance events that require no immediate action. Logged for audit completeness.

**Examples:**
- New peer registered at `local-only` stage
- Peer promoted from `provisional` to `bounded` meeting all criteria
- Routine sync pull/push completed successfully
- Contradiction detected but within normal operational bounds

**Who acts:** No action required. Automated logging only.

**Authorized actions:**
- Record in `myr_traces`
- Include in `GET /myr/governance/audit` response

**Time-to-respond SLA:** None (passive logging).

**Governance signal config:**
- TTL: N/A (no signal generated)
- Hop limit: N/A

---

### WARNING

**Definition:** Events that indicate potential abuse or degraded trust conditions. Require operator awareness and possible investigation.

**Examples:**
- Peer demotion triggered (e.g., `bounded` to `provisional` due to dropping approval count)
- Rate limiter returns 429 for an authenticated peer (3+ times in 5 minutes)
- Contradiction detection finds 3+ unresolved contradictions in a single domain
- Sync pull:push ratio exceeds 5:1 for a peer over 24 hours
- Yield from a `provisional` peer receives operator rating below 2.0

**Who acts:** Local operator (node admin). Review within SLA window.

**Authorized actions:**
- Investigate peer activity via `GET /myr/participation/peer/:publicKey`
- Query audit trail: `GET /myr/governance/audit`
- Run `detectContradictions()` for affected domains
- **No revocation or quarantine without escalation to CRITICAL** unless clear evidence of malice

**Time-to-respond SLA:** 24 hours (review and document findings).

**Governance signal config:**
- TTL: N/A (investigation phase, no propagation)
- Hop limit: N/A

---

### CRITICAL

**Definition:** Confirmed abuse, trust violation, or security event requiring immediate remediation. Operator must act.

**Examples:**
- Confirmed Sybil cluster (3+ nodes with circular approval patterns)
- Yield poisoning confirmed (deliberately false yields with evidence)
- Trust manipulation (peer reached `trusted-full` via gaming)
- Gossip flooding from a specific peer
- Collusion ring identified
- Data exfiltration pattern confirmed (high-volume pull with zero contribution)

**Who acts:** Local operator. Must act within SLA window. May coordinate with trusted peers for network-wide response.

**Authorized actions:**
- `POST /myr/governance/revoke` — revoke trust for confirmed bad actors
- `POST /myr/governance/quarantine` — quarantine poisoned or suspect yields
- `resolveContradiction()` — resolve contradictions caused by malicious activity
- Re-evaluate affected peers via `evaluateStage()` to trigger cascading demotions
- Create governance signals for network propagation

**Time-to-respond SLA:** 4 hours (containment actions initiated).

**Governance signal config:**
- TTL: 5 hops (default, ensures network-wide propagation)
- Hop limit: Standard (hop_count increments per relay, signal stops at TTL)

**Automated vs manual boundary:**
- **Automated:** Rate limiting (429 responses), gossip deduplication (signal_id uniqueness), TTL enforcement on propagation
- **Manual:** Revocation decisions, quarantine decisions, contradiction resolution, peer investigation

---

### EMERGENCY

**Definition:** Active key compromise, network-wide attack, or integrity failure requiring immediate coordinated response.

**Examples:**
- Ed25519 private key confirmed compromised (attacker has signing capability)
- Competing key rotation announcements from same node identity
- Governance signals appearing with valid signatures for actions the operator did not authorize
- Mass revocation cascade affecting >20% of trusted peers
- Coordinator compromise (routing manipulation at infrastructure level)

**Who acts:** Local operator immediately. Coordinate with all trusted peers out-of-band. Full network response.

**Authorized actions:**
- All CRITICAL actions, plus:
- `POST /myr/governance/key-rotate` — emergency key rotation
- Out-of-band communication with trusted peers to distribute new keys
- Manual override of gossip propagation (direct peer notification bypassing compromised relay paths)
- Temporary suspension of automated promotions
- Full audit and quarantine of all actions during the compromise window

**Time-to-respond SLA:** 1 hour (containment), 4 hours (full remediation plan), 24 hours (remediation complete).

**Governance signal config:**
- TTL: 5 hops (maximum propagation for emergency signals)
- Hop limit: Standard, but operators should verify signal arrival at network edges
- **Key rotation signals:** Must propagate to all peers; verify via audit endpoint

**Automated vs manual boundary:**
- **Automated:** Key rotation announcement generation, governance signal propagation, deduplication
- **Manual:** Decision to rotate keys, identification of compromise window, out-of-band peer coordination, quarantine of compromise-window artifacts

---

## Escalation Path

```
INFO → (pattern detected) → WARNING → (confirmed abuse) → CRITICAL → (key/infrastructure compromise) → EMERGENCY
```

**Escalation triggers:**
| From | To | Trigger |
|------|----|---------|
| INFO | WARNING | Anomaly detected: unusual approval patterns, rate limit hits, contradiction clusters |
| WARNING | CRITICAL | Investigation confirms malicious intent or systematic abuse |
| CRITICAL | EMERGENCY | Key compromise confirmed, infrastructure integrity at risk, or remediation of CRITICAL event reveals wider attack |

**De-escalation:**
- EMERGENCY → CRITICAL: Compromise contained, new keys distributed, compromise window audited
- CRITICAL → WARNING: Bad actors revoked, poisoned yields quarantined, monitoring in place
- WARNING → INFO: Investigation complete, no malice confirmed, operational adjustments documented

---

## Governance Signal TTL and Hop Limits by Severity

| Severity | Signal Generated | Default TTL | Hop Limit | Propagation Scope |
|----------|-----------------|-------------|-----------|-------------------|
| INFO | No | — | — | Local logging only |
| WARNING | No | — | — | Local investigation only |
| CRITICAL | Yes (revoke, quarantine) | 5 | 5 hops | Network-wide via gossip |
| EMERGENCY | Yes (revoke, quarantine, key_rotation) | 5 | 5 hops | Network-wide + out-of-band verification |

**Signal deduplication:** All governance signals are deduplicated by `signal_id` (SHA-256 hash of canonical signal). Duplicate signals are rejected silently. This prevents replay attacks and flood amplification regardless of severity level.

**Signal expiry:** Governance signals persist in `myr_governance_signals` indefinitely for audit purposes. TTL controls propagation depth only, not storage retention.

---

## Response Checklist

### For any CRITICAL or EMERGENCY event:

1. [ ] Identify affected peers and yields
2. [ ] Revoke confirmed bad actors (`POST /myr/governance/revoke`)
3. [ ] Quarantine suspect yields (`POST /myr/governance/quarantine`)
4. [ ] Verify governance signals propagated (`GET /myr/governance/audit`)
5. [ ] Re-evaluate affected peers (`GET /myr/participation/evaluate`)
6. [ ] Re-run contradiction detection (`detectContradictions()`)
7. [ ] Document incident in operational notes
8. [ ] Monitor for re-registration or follow-up attacks
9. [ ] (EMERGENCY only) Rotate keys if compromised (`POST /myr/governance/key-rotate`)
10. [ ] (EMERGENCY only) Coordinate out-of-band with trusted peers
