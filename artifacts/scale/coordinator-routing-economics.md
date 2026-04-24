# Coordinator Routing Economics

Gate 1 quantitative analysis for DomainCoordinator at 10,000+ scale.

**Date:** 2026-04-24
**Source:** `test/coordinator-load.test.js` measured on Node.js, single-threaded, in-memory Maps.

---

## 1. Per-Peer Registration Cost

| Metric | Value |
|--------|-------|
| Data stored per registration | publicKey (64 B) + operatorName (~16 B) + peerUrl (~32 B) + registeredAt (24 B) + JS object overhead |
| Measured heap per peer | ~2,600 bytes (avg across 10k peers, 3-5 domains each) |
| CPU per register() call | ~1.6 us (10,000 registrations in ~16 ms) |

Each peer occupies entries in two Maps:
- `routingTable`: domain -> Map<publicKey, registration> (one entry per domain the peer subscribes to)
- `peerDomains`: publicKey -> Set<domain> (one entry per peer)

With an average of 4 domains per peer, the total registration entries are ~4x the peer count.

## 2. Per-Route-Query Cost

| Operation | Scale | Avg Latency | Notes |
|-----------|-------|-------------|-------|
| `route(domain)` | 1,000 peers | < 0.02 ms | Single Map.get + values spread |
| `route(domain)` | 10,000 peers | < 0.1 ms | O(peers_in_domain) |
| `routeMultiple(10 domains)` | 1,000 peers | < 0.1 ms | Iterates 10 domain Maps, deduplicates |
| `routeMultiple(10 domains)` | 10,000 peers | < 0.5 ms | Dominant cost: spread + dedup |
| `selectPeersForReport(2 domains)` | 10,000 peers | < 1 ms | Wrapper over routeMultiple |

All operations are well within the required thresholds (route < 10ms, routeMultiple < 50ms).

## 3. Memory Budget Projection

| Peers | Domains (avg 50/peer cluster) | Estimated Heap | Notes |
|-------|-------------------------------|----------------|-------|
| 1,000 | 100 | ~2.5 MB | Baseline |
| 5,000 | 200 | ~13 MB | Linear scaling |
| 10,000 | 200 | ~26 MB | Validated in test |
| 50,000 | 500 | ~130 MB (projected) | Linear extrapolation |
| 100,000 | 1,000 | ~260 MB (projected) | Single-process practical ceiling |

At 10,000 peers with 50 domains average, the coordinator consumes approximately **26 MB of heap** — negligible for a Node.js server process (typical V8 heap limit is 1.5-4 GB).

## 4. Coordinator Routing vs Naive Broadcast

| Scale | Coordinator Route (targeted) | Naive Broadcast | Bandwidth Savings |
|-------|------------------------------|-----------------|-------------------|
| 1,000 peers | Send to ~40 peers (avg domain size) | Send to 1,000 peers | **96%** |
| 10,000 peers | Send to ~200 peers (avg domain size) | Send to 10,000 peers | **98%** |
| 100,000 peers | Send to ~1,000 peers (projected) | Send to 100,000 peers | **99%** |

**Key insight:** Coordinator routing cost is O(matching_peers) per query, while broadcast is O(all_peers). The coordinator's per-query cost stays bounded by domain membership, not total network size.

### Per-message bandwidth cost

Assuming a typical gossip report of ~2 KB:

| Scale | Coordinator (targeted) | Naive Broadcast | Savings per report |
|-------|----------------------|-----------------|-------------------|
| 1,000 peers | 40 * 2 KB = 80 KB | 1,000 * 2 KB = 2 MB | 1.92 MB saved |
| 10,000 peers | 200 * 2 KB = 400 KB | 10,000 * 2 KB = 20 MB | 19.6 MB saved |
| 100,000 peers | 1,000 * 2 KB = 2 MB | 100,000 * 2 KB = 200 MB | 198 MB saved |

At 10,000 peers with 100 reports/min, coordinator saves ~1.96 GB/min in bandwidth vs broadcast.

## 5. CPU Budget at Scale

| Metric | 10,000 peers |
|--------|-------------|
| Registration (full re-sync) | ~16 ms |
| route() per call | < 0.1 ms |
| routeMultiple(10) per call | < 0.5 ms |
| getStats() | < 0.5 ms |

At 100 route queries/sec, the coordinator uses ~10 ms/sec of CPU — approximately **1% of a single core**. The coordinator is not a CPU bottleneck at 10,000+ scale.

## 6. Resilience Summary

Validated in `test/coordinator-resilience.test.js`:

- **Peer churn:** Register 500 -> unregister 200 -> register 300: routing table maintains perfect integrity.
- **Domain hot-spots:** 50% of peers on one domain: route() returns bounded, correct results. No performance degradation.
- **Stale cleanup:** Unregistering stale peers leaves no orphaned domain entries. Double-unregister is harmless.
- **Re-registration:** Replacing a peer's domains atomically removes old mappings before adding new ones. No ghost entries.

## 7. Conclusion: GO

**The DomainCoordinator is validated as the primary routing layer for 10,000+ participants.**

| Criterion | Result |
|-----------|--------|
| route() < 10ms at 10k | PASS (< 0.1 ms) |
| routeMultiple() < 50ms at 10k | PASS (< 0.5 ms) |
| Memory < 200 MB at 10k | PASS (~26 MB) |
| Resilience under churn | PASS |
| Bandwidth savings vs broadcast | 98%+ at 10k |

**Scaling ceiling:** The in-memory Map architecture scales linearly and can support up to ~100,000 peers on a single process before memory becomes a concern (~260 MB). Beyond that, sharding by domain prefix or moving the routing table to a shared store (Redis, SQLite) would be the next evolution.

No architectural changes needed for the 10,000-peer target.
