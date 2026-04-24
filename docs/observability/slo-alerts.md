# MYR SLO Alert Definitions

## Burn-rate model

Use a dual-window burn-rate policy for each SLO:

- Fast burn window: 1h window, catches acute incidents.
- Slow burn window: 6h window, catches sustained degradation.
- Page when both windows breach paging thresholds.
- Warn when either window breaches warning thresholds.

Formula:

- Error budget burn rate = `(1 - observed_sli) / (1 - target_sli)`
- Higher than 1.0 means budget is being consumed faster than allowed.

## SLO 1: Sync Freshness

- Target: 95% checks have `sync.sync_lag_seconds <= 60`.
- Source metric: `slo_sync_freshness_compliant_pct`.
- Page: burn rate >= 14 (1h) and >= 6 (6h).
- Warn: burn rate >= 6 (1h) or >= 3 (6h).
- Action:
  1. Run `scripts/ops/incident-triage.sh`.
  2. Inspect stale peers from `/myr/health/network`.
  3. Trigger bounded sync recovery and peer re-seeding.

## SLO 2: Gossip Health

- Target: 99% checks have `gossip.active_view_size >= fanout - 1`.
- Source metric: `slo_gossip_health_compliant_pct`.
- Page: burn rate >= 14 (1h) and >= 6 (6h).
- Warn: burn rate >= 6 (1h) or >= 3 (6h).
- Action:
  1. Validate active/passive view pressure via `/myr/metrics`.
  2. Flush stale or revoked peers.
  3. Re-bootstrap from known trusted peers.

## SLO 3: Governance Propagation

- Target: p99 propagation <= 120s for revocation signals.
- Source metric: `slo_governance_propagation_p99_seconds`.
- Page: p99 > 180s for both 1h and 6h windows.
- Warn: p99 > 120s in either window.
- Action:
  1. Review governance signal trail via `/myr/governance/audit`.
  2. Check gossip transport stability.
  3. Escalate to governance owner if revocations are delayed.

## SLO 4: Onboarding Success

- Target: 95% of join attempts complete within 60s.
- Source metrics: `onboarding.compliant_pct`, `slo_onboarding_success_p95_seconds`.
- Page: compliant_pct < 85% for both 1h and 6h windows.
- Warn: compliant_pct < 95% in either window.
- Action:
  1. Review onboarding traces and latest sync failures.
  2. Validate key verification and peer trust transitions.
  3. Run onboarding end-to-end test gate.

## SLO 5: Uptime

- Target: >=99.5% successful `/myr/health` checks.
- Source metrics: `slo_uptime_pct` and external checker status logs.
- Page: burn rate >= 14 (1h) and >= 6 (6h), or continuous outage > 5m.
- Warn: burn rate >= 6 (1h) or >= 3 (6h).
- Action:
  1. Start node crash recovery runbook (WAL + integrity).
  2. Verify restart health and metrics endpoints.
  3. Publish incident timeline and owner updates.

## Severity mapping

- Sev1 (paging): Uptime outage, governance propagation delays affecting revocation safety, or sustained network-wide sync failure.
- Sev2 (warning/escalation): Single-node degradation, partial gossip health loss, onboarding regression.
- Sev3 (ticket only): transient spikes that self-recover within one fast-burn window.
