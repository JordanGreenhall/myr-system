# MYR Support Operations Playbook

## Incident Triage Checklist
1. Confirm incident scope: single node, peer subset, or network-wide.
2. Capture current health:
   - `/myr/health`
   - `/myr/health/node`
   - `/myr/health/network`
   - `/myr/metrics`
3. Classify severity (Sev1/Sev2/Sev3) by user impact and blast radius.
4. Freeze risky changes until primary cause is understood.
5. Open/update incident log with timestamps and owner.

## Escalation Procedure
1. Sev1: page on-call operator and incident lead immediately.
2. Sev2: notify operations lead and assign recovery owner within 15 minutes.
3. Security/governance events: involve governance owner immediately.
4. If unresolved in one sync window, escalate to engineering leadership.

## Common Failure Modes and Diagnosis
1. Auth failures (`auth_required`, `unknown_peer`)
   - Check request signature headers and nonce/timestamp validity.
2. Trust failures (`peer_not_trusted`, `forbidden`)
   - Validate peer trust state and revocation history.
3. Sync drift / stale peers
   - Review `last_sync_at`, `sync_lag_seconds`, and queue age signals.
4. Gossip imbalance
   - Compare `ihave`/`iwant` counters and active/passive view sizes.
5. Data integrity mismatch
   - Inspect reject traces for hash/signature mismatch and quarantine if needed.

## Operator Communication Templates

### Initial Acknowledgement
`We have identified an MYR network incident affecting <scope>. Investigation started at <time>. Next update in <interval>.`

### Mitigation In Progress
`Mitigation is active: <action>. Current status: <status>. Risk to data integrity: <low|medium|high>.`

### Resolution
`Incident resolved at <time>. Root cause: <cause>. Recovery actions: <actions>. Follow-up items: <items>.`
