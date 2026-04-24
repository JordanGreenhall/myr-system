# ADR: MYR Scale Architecture — Bounded Fanout Gossip

**Status:** Proposed
**Date:** 2026-04-24
**Author:** Spock (Science Officer)
**Issue:** STA-175

## Context

MYR's current sync protocol uses **pull-based full-mesh** replication: every node contacts every trusted peer every sync cycle. This works well for 3–100 nodes but has O(N^2) message complexity per cycle, making it unsustainable beyond ~300 nodes.

| Nodes | List Requests/Cycle | Report Fetches (5 rpt/node) | Total Messages |
|------:|--------------------:|----------------------------:|---------------:|
| 10    | 90                  | ~450                        | ~540           |
| 50    | 2,450               | ~12,250                     | ~14,700        |
| 100   | 9,900               | ~19,800                     | ~29,700        |
| 1,000 | 999,000             | ~4,995,000                  | ~5,994,000     |

At 1,000 nodes the system generates ~6M HTTP requests per sync cycle. This is not credible.

## Decision

Replace full-mesh pull with **bounded-fanout gossip** using subscription-driven selective propagation. The architecture reduces per-cycle message complexity from O(N^2) to O(N * F) where F is the fanout constant (typically 3–8).

## Architecture

### Core Concept: Epidemic Dissemination with Demand Filtering

Instead of every node pulling from every peer, each node:

1. Maintains a **peer sample** of size F (fanout, default 5) drawn from its trusted peers
2. **Pushes** new reports to its peer sample (push-lazy: send metadata, let receiver pull full report if interested)
3. Filters outbound reports against the **receiver's declared subscriptions**
4. Periodically **rotates** the peer sample using random peer sampling (RPS)

Reports propagate epidemically through the overlay. With fanout F=5 and 1,000 nodes, a report reaches all interested nodes in O(log_F(N)) = ~4-5 hops.

### Components

#### 1. Peer Sampling Service (PSS)

Each node maintains two views:

- **Active view** (size F, default 5): peers this node actively pushes to and pulls from
- **Passive view** (size P, default 20): backup peers for view rotation

View maintenance uses HyParView-style protocol:
- On join: contact bootstrap nodes, get random sample
- Periodic shuffle: swap random subset of active/passive views with a random peer
- On peer failure: promote from passive view

```
peer_sample = {
  active: [peer_1, peer_2, ..., peer_F],   // push/pull targets
  passive: [peer_a, peer_b, ..., peer_P],   // backup pool
  shuffle_interval: 300s,                    // view refresh
}
```

**Complexity:** Each node contacts F peers per cycle instead of N-1. Total messages: N * F = O(N).

#### 2. Push-Lazy Dissemination

When a node creates or receives a new report:

1. Compute report metadata hash (already exists: `signed_artifact`)
2. For each peer in active view:
   a. Check if report matches peer's declared subscriptions
   b. If match (or peer has no subscriptions): send **IHAVE** notification with metadata
3. Receiving peer checks local dedup (already exists: signature-based dedup)
4. If new: responds with **IWANT**, sender transmits full report
5. Receiver re-gossips to its own active view (with TTL decrement)

```
IHAVE message:
{
  type: "ihave",
  reports: [
    { signature: "sha256:...", domain_tags: ["security", "performance"],
      yield_score: 0.8, created_at: "ISO8601", size_bytes: 1400 }
  ],
  ttl: 4,
  sender_fingerprint: "sha256:xx:xx:..."
}

IWANT message:
{
  type: "iwant",
  signatures: ["sha256:...", "sha256:..."]
}
```

**Key property:** IHAVE messages are tiny (~100 bytes per report). Only interested peers pull the full report (~1-3 KB). Bandwidth is proportional to demand, not supply.

#### 3. Subscription-Driven Filtering (exists, needs enforcement)

The subscription system already exists (`lib/subscriptions.js`) with:
- Per-node domain tag declarations
- Signed subscription signals with hop propagation
- `reportMatchesSubscriptions()` filter function

**Change required:** Make subscriptions **mandatory for gossip peers**. A node in the active view that has not declared subscriptions receives all reports (backward compatible), but subscription-aware peers get filtered pushes.

The subscription gossip piggybacks on the peer sampling shuffle: when nodes exchange view entries, they also exchange subscription summaries.

#### 4. Anti-Entropy Repair (replaces full pull)

Full-mesh pull is replaced by periodic anti-entropy with a random peer:

1. Every T seconds (default 600s), pick one random peer from active view
2. Exchange **Bloom filter** of report signatures held locally
3. Identify missing reports in both directions
4. Exchange only the missing reports

This catches anything the push-gossip missed (network partitions, message loss).

```
Anti-entropy exchange:
{
  type: "sync_bloom",
  bloom: "<base64-encoded bloom filter of local signatures>",
  since: "ISO8601",  // only reports after this timestamp
  filter_params: { m: 8192, k: 5 }  // filter size and hash count
}
```

**Bloom filter sizing:** For 10,000 reports, a 16KB Bloom filter gives <1% false positive rate. This is transmitted once per anti-entropy round instead of paginating through the full report list.

#### 5. Coordinator Nodes (Phase 2 — required for 10,000+ goal)

For networks beyond ~2,000 nodes, **domain coordinators** become necessary:

- Nodes with high uptime and connectivity volunteer as coordinators for specific domain tags
- Coordinators maintain a complete view of reports in their domain
- Leaf nodes can sync exclusively through their domain coordinator
- Coordinators gossip with each other for cross-domain propagation

Coordinator design and prototyping must begin before 1,000 nodes, not after. 1,000 participants is a hard market-significant intermediate rung — by the time MYR reaches it, coordinator architecture must already be validated. The project goal is 10,000+ participants; deferring coordinator work until post-1,000 creates a scaling cliff at exactly the moment operational demands are highest.

### Message Complexity Comparison

| Model | Messages/Cycle | At N=100 | At N=1,000 | At N=10,000 |
|-------|---------------|----------|------------|-------------|
| Full-mesh pull (current) | N * (N-1) | 9,900 | 999,000 | 99,990,000 |
| Bounded fanout gossip (F=5) | N * F | 500 | 5,000 | 50,000 |
| Anti-entropy (1 peer/round) | N | 100 | 1,000 | 10,000 |
| **Total (gossip + AE)** | **N * (F+1)** | **600** | **6,000** | **60,000** |

**Improvement factor at 1,000 nodes: 166x fewer messages.**

### Convergence Properties

- **Reliability:** With fanout F=5 and random peer sampling, the probability that a report fails to reach all nodes drops exponentially with each hop. At F=5, probability of total failure after 5 hops < 10^-6.
- **Latency:** Reports reach 99% of interested nodes within ceil(log_5(N)) sync intervals. At N=1,000: ~4 intervals. At default 30s intervals: ~2 minutes.
- **Consistency:** Anti-entropy repair guarantees eventual delivery even under sustained message loss. Convergence is guaranteed within T_anti-entropy seconds for any reachable pair.
- **Partition tolerance:** The peer sampling service detects disconnected peers and rotates the active view, healing partitions automatically when connectivity is restored.

### What Does NOT Change

The gossip architecture preserves all existing MYR invariants:

1. **Ed25519 signing** — all reports remain signed; verification logic unchanged
2. **SHA-256 dedup** — `signed_artifact` dedup works identically
3. **Nonce replay prevention** — still enforced on all authenticated requests
4. **Trust levels** — only trusted peers are in the peer sample
5. **Report format** — the canonical report JSON is unchanged
6. **Subscription signals** — reused as-is for demand filtering
7. **Trace logging** — extended with gossip event types
8. **Relay fallback** — works for any peer in the active view
9. **API endpoints** — `/myr/reports` listing still works for direct queries; gossip is a transport optimization

## Migration Path

### Phase 0: Preparation (current release, v1.2.x)
- No protocol changes
- Release can honestly state: "works for 3–100 nodes; scale architecture designed for 10,000+ goal, not yet implemented"
- This ADR is the deliverable
- 10,000+ readiness work (governance, observability, abuse resistance, operational procedures) begins in this phase alongside protocol design

### Phase 1: Bounded Fanout (v1.3.0)
1. Add `lib/gossip.js` with peer sampling service and push-lazy dissemination
2. Add IHAVE/IWANT message types to `/myr/gossip` endpoint
3. Modify sync scheduler to use gossip for push + single-peer anti-entropy for repair
4. Keep `/myr/reports` pull endpoint for backward compatibility
5. Nodes auto-detect peer capability: if peer supports `/myr/gossip`, use gossip; otherwise fall back to pull
6. **Migration is automatic:** old nodes still work via pull; new nodes gossip with each other and pull from old nodes

### Phase 2: Subscription Enforcement (v1.3.x)
1. Require subscriptions for gossip-mode peers
2. Piggyback subscription exchange on peer sampling shuffle
3. Nodes without subscriptions continue to work but receive all reports (no regression)

### Phase 3: Anti-Entropy + Bloom Filters (v1.4.0)
1. Replace periodic full-pull with Bloom filter exchange
2. Add `/myr/sync/bloom` endpoint
3. Remove full-mesh pull from default sync schedule (keep as manual command)

### Phase 4: Coordinators (v1.5.0 — pre-1,000 delivery required)
1. Domain coordinator election protocol
2. Coordinator-to-coordinator gossip ring
3. Required for the 10,000+ project goal; design and prototype must be validated before 1,000 nodes to avoid a scaling cliff

### Backward Compatibility

Every phase maintains backward compatibility:
- Old nodes that only support pull continue to work
- New nodes detect peer capabilities via `/.well-known/myr-node` protocol version
- The `protocol_version` field in the discovery document indicates gossip support
- No flag day required; mixed networks converge correctly

## Prototype: lib/gossip.js

The prototype implements Phase 1 core: peer sampling + push-lazy IHAVE/IWANT. See `lib/gossip.js` for the implementation and `test/gossip-scale.test.js` for benchmark evidence.

## Residual Risk After This Milestone

### Materially Reduced
- **O(N^2) message complexity** — eliminated by bounded fanout; complexity is now O(N * F)
- **Full-mesh assumption** — replaced by partial views with guaranteed epidemic coverage
- **Bandwidth waste on uninteresting reports** — subscription-driven filtering is architecturally integrated

### Remaining Risks
1. **Peer sampling protocol is unimplemented.** The current prototype uses static peer selection. Production deployment requires the full HyParView shuffle protocol (Phase 1 deliverable).
2. **Bloom filter anti-entropy is designed but not prototyped.** The existing cursor-based pull works but is less efficient for repair scenarios.
3. **Coordinator election is designed but unimplemented.** The 10,000+ project goal requires coordinators. Design and prototype validation must happen before 1,000 nodes; 1,000 is an intermediate rung, not the destination.
4. **NAT traversal at scale.** The relay mechanism works 1:1 but has not been tested as a gossip intermediary. Relay nodes may become bottlenecks if many nodes are behind NAT.
5. **Subscription completeness.** If nodes don't declare subscriptions, they receive all reports. Subscription adoption is a social/UX problem, not a protocol problem.
6. **No formal verification.** Convergence properties are argued from epidemic dissemination theory (Kermarrec et al., 2003) but not formally verified for this specific protocol.
7. **10,000+ operational readiness gaps.** Beyond protocol scaling, the following are required for 10,000+ operation and must begin before 1,000 nodes: governance/abuse resistance framework, network-wide observability and support operations, routing economics model, trust-weighted retrieval at scale, onboarding resilience under load, launch/pilot operating procedures, and recovery/failure runbooks.

### Honest Scale Claims for v1.2.x Release

> MYR v1.2.x supports networks of 3–100 nodes using direct peer-to-peer sync. A bounded-fanout gossip architecture has been designed and partially prototyped that provides a credible scaling path. The gossip protocol reduces message complexity from O(N^2) to O(N), maintains all existing cryptographic guarantees, and supports incremental migration from the current pull-based model. Full gossip support is planned for v1.3.0. The project goal is a 10,000+ participant methodological intelligence network. 1,000 participants is a hard market-significant intermediate rung on that path — not the destination. Substantial 10,000-readiness work (coordinator architecture, governance, abuse resistance, observability, support operations, routing economics, and recovery procedures) must proceed in parallel with the path to 1,000, not be deferred until after it.

## References

- Leitao, Pereira, Rodrigues. "HyParView: A Membership Protocol for Reliable Gossip-Based Broadcast." DSN 2007.
- Kermarrec, Massoulié, Ganesh. "Probabilistic Reliable Dissemination in Large-Scale Systems." IEEE TPDS, 2003.
- Eugster et al. "Epidemic Information Dissemination in Distributed Systems." IEEE Computer, 2004.
