# MYR Operational SLO Definitions

This document defines operational SLO targets for network health. Each SLO includes:
- `Target`: required reliability objective
- `SLI`: measurable indicator
- `Metric source`: concrete key(s)
- `Notes`: constraints and implementation gaps

## SLO 1: Sync Freshness

- Target: 95% of checks show network sync lag at or below 60 seconds.
- SLI: `% of checks where sync.sync_lag_seconds <= 60`.
- Metric source: `GET /myr/metrics -> sync.sync_lag_seconds`.
- Notes: This is a point-in-time lag indicator derived from `last_sync_at`. Scheduler sampling (for example every minute) is required to compute a true 95% window objective.

## SLO 2: Gossip Health

- Target: 99% of checks show active gossip view size at or above `F - 1`.
- SLI: `% of checks where gossip.active_view_size >= (fanout - 1)`.
- Metric source: `GET /myr/metrics -> gossip.active_view_size`.
- Notes: The current endpoint exposes local active view size, not a full per-node fleet distribution. Use this as the local-node operational proxy until fleet-wide aggregation is added.

## SLO 3: Governance Propagation

- Target: 99% of governance revocation signals propagate within 120 seconds.
- SLI: `% of revocation events where propagation_latency_seconds <= 120`.
- Metric source: not currently available in `GET /myr/metrics`.
- Notes: This SLO is defined but not directly measurable from current metrics payload. Required instrumentation: propagation latency histogram/counters for governance events.

## SLO 4: Onboarding Success Rate

- Target: 95% of `myr join` attempts complete successfully within 60 seconds.
- SLI: `% of join attempts where join_success=true and join_duration_seconds <= 60`.
- Metric source: not currently available in `GET /myr/metrics`.
- Notes: This SLO is defined but not directly measurable from current metrics payload. Required instrumentation: join attempt count, join success count, and join duration summary.

## SLO 5: Uptime

- Target: `/myr/health` returns HTTP 200 for at least 99.5% of checks.
- SLI: `% of checks where GET /myr/health returns 200`.
- Metric source: `GET /myr/health` HTTP status code.
- Notes: This endpoint-level availability SLO should be measured by an external checker on a fixed interval.

## Compliance Evaluation

The script [`scripts/slo-check.js`](/Users/roberthall/code/myr-system/scripts/slo-check.js) evaluates these SLOs using live endpoint data and emits:
- `pass`: current sample satisfies threshold
- `fail`: current sample violates threshold
- `not_evaluable`: required metric is not yet exposed
