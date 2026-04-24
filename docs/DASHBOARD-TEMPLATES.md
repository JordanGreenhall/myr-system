# MYR Dashboard Templates

These templates define operator-facing dashboards and map each panel to current `/myr/metrics` keys.

## 1) Network Overview Dashboard

- Goal: fast health read of node scale, sync freshness, and gossip posture.
- Refresh interval: 30s-60s.

Panels:
- Node uptime
  - Metric key: `node.uptime_seconds`
  - Visualization: single stat + sparkline
- Peer counts
  - Metric keys: `peers.total`, `peers.trusted`
  - Visualization: dual stat + ratio
- Active gossip connections
  - Metric keys: `peers.active_gossip_view`, `gossip.active_view_size`, `gossip.passive_view_size`
  - Visualization: stacked bar
- Sync lag
  - Metric key: `sync.sync_lag_seconds`
  - Visualization: gauge (green/yellow/red bands)
- Sync throughput proxy
  - Metric key: `sync.messages_per_cycle`
  - Visualization: trend line
- Domain distribution
  - Metric key: `reports.by_domain`
  - Visualization: top-N bar chart

## 2) Gossip Health Dashboard

- Goal: verify gossip fanout stability and message flow balance.
- Refresh interval: 15s-30s.

Panels:
- Active vs passive view size
  - Metric keys: `gossip.active_view_size`, `gossip.passive_view_size`
  - Visualization: paired time series
- IHAVE traffic
  - Metric keys: `gossip.ihave_sent`, `gossip.ihave_received`
  - Visualization: cumulative counters + rate panel
- IWANT traffic
  - Metric keys: `gossip.iwant_sent`, `gossip.iwant_received`
  - Visualization: cumulative counters + rate panel
- Gossip request/response ratio
  - Derived: `gossip.iwant_sent / max(gossip.ihave_received, 1)`
  - Visualization: single stat with thresholds

## 3) Governance Dashboard

- Goal: monitor governance signal behavior and trust-health impacts.
- Current state: full governance propagation metrics are not present in `/myr/metrics`; use available proxy signals now.

Panels (current proxies):
- Trusted peer baseline
  - Metric key: `peers.trusted`
  - Visualization: single stat + trend
- Network reach proxy
  - Metric keys: `peers.total`, `peers.trusted`
  - Derived: `peers.trusted / max(peers.total, 1)`
  - Visualization: ratio gauge
- Sync freshness proxy for signal spread
  - Metric key: `sync.sync_lag_seconds`
  - Visualization: percentile/heat panel (if sampled)

Future required metrics (not yet exposed):
- `governance.revocation_propagation_seconds`
- `governance.quarantine_count`
- `governance.trust_graph_density`

## 4) Per-Node Operations Dashboard

- Goal: local node operational quality and routing behavior proxy.

Panels:
- Node identity + uptime
  - Metric keys: `node.fingerprint`, `node.uptime_seconds`
  - Visualization: metadata + trend
- Local vs imported report balance
  - Metric keys: `reports.local`, `reports.imported`
  - Visualization: stacked area
- Sync lag + messages per cycle
  - Metric keys: `sync.sync_lag_seconds`, `sync.messages_per_cycle`
  - Visualization: dual-axis line chart
- Gossip load profile
  - Metric keys: `gossip.ihave_sent`, `gossip.iwant_sent`, `gossip.ihave_received`, `gossip.iwant_received`
  - Visualization: grouped rate charts

Future required metrics for full economics view (not yet exposed):
- `routing.relay_cost`
- `routing.subscription_match_rate`
- `routing.economic_score`

## Alert Starter Set

- Critical: `sync.sync_lag_seconds > 120` for 5m.
- Warning: `gossip.active_view_size < 3` for 10m.
- Warning: `peers.trusted < 1` for 10m.
- Warning: `sync.messages_per_cycle == 0` while `peers.trusted > 0` for 15m.
