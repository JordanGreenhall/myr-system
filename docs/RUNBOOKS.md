# MYR Recovery Runbooks

## 1) Node Crash Recovery (WAL + Integrity)
1. Stop the node process.
2. Snapshot `myr.db`, `myr.db-wal`, and `myr.db-shm`.
3. Run SQLite integrity check:
   - `sqlite3 myr.db "PRAGMA integrity_check;"`
4. If integrity is `ok`, restart and verify:
   - `GET /myr/health`
   - `GET /myr/metrics`
5. If integrity fails, restore last known-good backup and replay recent imports/syncs.
6. Confirm recovery by checking sync freshness and peer reachability.

## 2) Key Compromise Procedure (Revocation + Rotation)
1. Immediately revoke compromised peers/keys with:
   - `POST /myr/governance/revoke`
2. Rotate node keypair and publish governance signal:
   - `POST /myr/governance/key-rotate`
3. Re-announce node identity to trusted peers.
4. Verify peers observe updated trust state via:
   - `GET /myr/governance/audit`
5. Document blast radius, affected signatures, and remediation timeline.

## 3) Network Partition Healing (Peer Sampling Recovery)
1. Check partition symptoms:
   - low `reachable_peers`
   - stale `last_sync_at`
2. Re-seed trusted peers and restart sync pull cycle.
3. Trigger bounded peer-sampling recovery by reintroducing healthy peers.
4. Observe healing via:
   - `GET /myr/health/network`
   - `GET /myr/metrics` gossip/sync sections
5. Keep traffic throttled until sync lag stabilizes.

## 4) Data Corruption Recovery (Signature Re-verification)
1. Identify suspect reports from sync rejection traces.
2. Re-run signature and hash verification against source peers.
3. Quarantine invalid yields:
   - `POST /myr/governance/quarantine`
4. Re-fetch valid artifacts from trusted peers.
5. Confirm trace outcomes move from reject/failure back to success.

## 5) Gossip View Contamination (Flush + Re-bootstrap)
1. Detect contamination signals:
   - repeated relay/sync failures
   - abnormal gossip traffic ratios
2. Flush stale/untrusted passive view entries.
3. Re-bootstrap from known trusted peers only.
4. Monitor:
   - `active_gossip_view`
   - `active_view_size`
   - `passive_view_size`
5. Re-enable normal propagation once metrics return to expected bounds.
