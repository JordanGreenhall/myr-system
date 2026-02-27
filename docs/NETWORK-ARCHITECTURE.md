# Starfighter Network Architecture

## A Pistis-Native Protocol for Anti-Rivalrous Intelligence Compounding

**Status:** Architectural design  
**Date:** 2026-02-26  
**Scope:** 3 → 300,000 nodes  

---

## Foundational Claim

The network is not a messaging system. It is a **coupling system**. Two nodes exchanging yield is not data transfer — it is the formation of a relationship with observable traces, progressive depth, and mutual obligation. The protocol must make coupling its atomic concept, not messages.

The signed artifact is not a "message." It is a **trace** — observable evidence of real OODA work that builds or degrades pistis between nodes.

---

## The Six Layers

```
Layer 6: Governance         (necessary at 300,000)
Layer 5: Synthesis          (critical at 30,000)
Layer 4: Flow               (emerges at 300)
Layer 3: Trust Topology     (emerges at 300)
Layer 2: Traces             (needed at 3)
Layer 1: Coupling           (needed at 3)
Layer 0: Identity           (needed at 3)
```

Each higher layer consumes the outputs of layers below it. Lower layers must not preclude higher layers, even if higher layers aren't built yet.

---

## Layer 0: Identity

A node is a keypair. This is the only irreducible requirement for existence in the network.

```
public_key:     Ed25519 (canonical identity)
fingerprint:    base64url(sha256(public_key_bytes))
node_id:        Human-readable alias (local convenience, not authoritative)
```

**Identity document:** self-certifying, signed blob containing public key, fingerprint, human name, creation timestamp, and declared capabilities. Can be published anywhere — it is not secret.

**Design decision:** The fingerprint is the permanent address. Everything else about a node — its name, its capabilities, its reputation — is mutable and derived from traces. The fingerprint is the only thing that's frozen.

**At 300,000:** Identity federation becomes relevant. A node may operate under multiple keypairs (pseudonymous participation in different domains). The protocol supports this by treating each keypair as a separate identity — linking them is a voluntary disclosure, not a protocol requirement.

---

## Layer 1: Coupling

Coupling is the set of primitive operations between two nodes. Every operation produces a trace entry (Layer 2). The operations are:

### 1.1 Introduce

Exchange identity documents. This is the weakest form of coupling — "I know you exist."

No trust is implied. No obligation is created. The only effect is that each node can now verify the other's signatures.

### 1.2 Share

Offer yield artifacts to a peer. Yield is self-authenticating (signed by the originating node) and carries its own provenance. The act of sharing is itself a trace entry.

Sharing is not broadcasting. It is directed — you share with a specific peer, which is a coupling decision that carries signal.

### 1.3 Acknowledge

Confirm receipt of yield. Not just "I got the bytes" — "I read it, here is my assessment of its relevance to my work." This is the beginning of reciprocity signal.

### 1.4 Apply

Report that received yield was used in a subsequent OODA cycle, and what happened. "I applied your technique X. Here's the result." This is the highest-value coupling event — it closes the loop and generates compounding.

Application reports are themselves yield — they are traces of what works across contexts.

### 1.5 Vouch

Attest to a peer's yield quality in a specific domain. A vouch is NOT a score. It is a **trace reference**: "here are the specific coupling events (shares, applications, outcomes) that ground my assessment of this node's work in domain X."

A vouch without evidence is empty. The protocol carries the evidence, not just the conclusion. Other nodes can inspect the basis and form their own judgment.

### 1.6 Commit / Fulfill / Breach

Make a commitment to a peer (e.g., "I will produce yield on domain X by date Y"). Fulfill or breach that commitment. Commitment traces are the strongest pistis signal — reliability under obligation.

### Coupling Depth

The progressive coupling levels from the Pistis framework map to accumulation of these operations:

| Level | Name | Characterized by |
|-------|------|------------------|
| 0 | **Aware** | Identity exchange only |
| 1 | **Observe** | Reading each other's yield, no interaction |
| 2 | **Coordinate** | Sharing yield, acknowledging, discussing domains |
| 3 | **Depend** | Applying each other's yield in real work, reporting outcomes |
| 4 | **Bind** | Mutual commitments, shared synthesis, explicit obligation |

Coupling depth is **derived from the trace history**, never declared. A node cannot claim to be at Level 3 with a peer — the traces either show it or they don't.

---

## Layer 2: Traces

Every Layer 1 operation produces a signed trace entry. A trace entry is:

```
{
  "v": 1,
  "trace_type": "share | acknowledge | apply | vouch | commit | fulfill | breach",
  "id": "<uuid>",
  "from": "<fingerprint>",
  "regarding": "<fingerprint of the node this trace is about>",
  "timestamp": "ISO 8601",
  "domain": ["hierarchical", "domain", "path"],
  "content": { ... type-specific payload ... },
  "references": ["<ids of prior traces or artifacts this builds on>"],
  "calibration": {
    "confidence": 0.0-1.0,
    "disconfirmers": ["what would prove this wrong"],
    "time_horizon": "when this should be re-evaluated"
  },
  "signature": "<Ed25519 over canonical form of all above>"
}
```

**Key properties:**

- **Every trace has calibration data.** Confidence, disconfirmers, and time horizon are not optional. This is what separates real OODA from performance. A node that consistently emits high-confidence claims that get falsified is visibly miscalibrated — no scoring system needed, the traces show it.

- **Every trace references what it builds on.** This creates a DAG (directed acyclic graph) of coupling events. You can follow the chain: "this application was based on this yield, which was vouched by this node, based on these prior applications." Provenance is structural, not asserted.

- **Domain is hierarchical.** `["systems-architecture", "agent-design", "cursor-patterns"]` allows subscription and routing at any level of specificity. At 3 nodes, this is just tagging. At 300,000, it's the addressing fabric.

- **Traces are the yield.** A vouch is a trace. An application report is a trace. A synthesis is a trace. The distinction between "yield" and "metadata" dissolves — everything the network produces is a signed trace that compounds.

---

## Layer 3: Trust Topology

**Not built at 3 nodes. Designed now. Emerges at 300.**

Trust topology is how pistis propagates beyond direct coupling.

### 3.1 Direct Trust

Between two nodes with direct coupling history. Derived entirely from their shared traces. Not a number — a readable history. But for routing and flow decisions, a node may compute a **trust summary** from the traces:

- Yield quality (were their shares useful when applied?)
- Calibration accuracy (did their confidence estimates match outcomes?)
- Reciprocity (is the flow balanced?)
- Reliability (commitments kept vs. breached?)
- Domain specificity (trust in which domains?)

The summary is a local computation — each node computes its own trust summary for each peer based on its own evaluation of their traces. There is no global trust score.

### 3.2 Transitive Trust

Node A trusts Node B (from direct traces). Node B vouches for Node C (with evidence). Node A can inspect B's vouch, evaluate the evidence, and derive a **weighted transitive trust** in C.

Trust decays with distance. The decay function is a local policy decision — some nodes may be conservative (sharp decay), others aggressive (slow decay). The protocol doesn't prescribe the function; it provides the trace data for each node to compute its own.

### 3.3 Domain Specificity

Trust is NEVER global. A node trusted in "systems-architecture" is not automatically trusted in "monetary-policy." Trust is always domain-qualified. Vouches are domain-specific. Routing is domain-specific.

This prevents authority leakage — the most dangerous failure mode in trust networks.

### 3.4 Trust Topology at Scale

| Scale | Trust mechanism |
|-------|----------------|
| 3 nodes | Direct traces only. Everyone reads everything. |
| 300 nodes | Direct traces + vouches from trusted peers. Clusters visible. |
| 30,000 nodes | Cluster-level trust summaries. Cross-cluster vouching by bridge nodes. |
| 300,000 nodes | Hierarchical trust delegation. Domain-specific reputation emerges from aggregated traces across clusters. |

The protocol doesn't change across these scales. The same trace primitives support all of them. What changes is how nodes *consume* the traces — from reading everything (3 nodes) to relying on aggregated summaries (300,000).

---

## Layer 4: Flow

**Not built at 3 nodes. Designed now. Emerges at 300.**

Flow is how yield moves through the network. It must be demand-driven, not supply-pushed.

### 4.1 Subscription

A node declares interest in domains:

```
{
  "trace_type": "subscribe",
  "domain": ["systems-architecture", "agent-design"],
  "depth": "all | verified-only | synthesis-only",
  "min_coupling_depth": 2
}
```

Subscriptions propagate through the trust topology. A node forwards yield to peers who have subscribed to matching domains — but only if the coupling depth between them justifies the flow.

### 4.2 Reciprocity

The protocol makes flow balance observable. For any pair of nodes, the trace history shows:

- Yield shared A→B vs B→A
- Applications reported (most valuable signal)
- Vouches given

Reciprocity doesn't require balance — a new node legitimately consumes more than it produces. But chronic imbalance is visible. The network doesn't punish it; it simply makes it observable. Nodes make their own coupling decisions based on what they see.

### 4.3 Supply Signaling

Nodes advertise what domains they hold yield in:

```
{
  "trace_type": "catalog",
  "domains": {
    "systems-architecture": { "count": 47, "verified": 31, "since": "2026-01-15" },
    "agent-design": { "count": 12, "verified": 8, "since": "2026-02-20" }
  }
}
```

At 3 nodes, this is unnecessary. At 30,000, it's how a node looking for yield on "monetary-policy" finds nodes that have it — routed through the trust topology, not a central index.

---

## Layer 5: Synthesis

**Not built at 3 nodes. Designed now. Critical at 30,000.**

Synthesis is how the network produces collective intelligence that exceeds what any node holds individually.

### 5.1 Local Synthesis

A single node synthesizes across its own yield and imported yield. Already built (myr-synthesize.js). Identifies convergent findings, divergent findings, unique contributions.

### 5.2 Cluster Synthesis

Nodes in a domain cluster produce a collective synthesis — a higher-order trace that aggregates findings across the cluster. The synthesis is signed by contributing nodes (multi-signature or threshold signature).

A cluster synthesis is itself yield that can flow to other clusters. This is how knowledge scales — not by every node reading every trace, but by clusters producing distilled intelligence that propagates up.

### 5.3 Cross-Cluster Synthesis

The highest value activity in the network. Two clusters working in different domains discover structural parallels — a pattern in "systems-architecture" that maps onto a pattern in "ecological-design." This requires bridge nodes with coupling in multiple clusters.

Cross-cluster synthesis is rare and extremely high value. The protocol should make it easy to attribute and propagate when it occurs.

### 5.4 Synthesis at Scale

| Scale | Synthesis mode |
|-------|----------------|
| 3 nodes | Single-node synthesis from all available yield |
| 300 nodes | Cluster synthesis within domain groups |
| 30,000 nodes | Hierarchical: cluster → cross-cluster → network-level patterns |
| 300,000 nodes | Multi-scale: local, cluster, regional, civilizational |

---

## Layer 6: Governance

**Not built. Not designed in detail. Necessary at 300,000.**

From the Pistis framework: authority is domain-specific, competence-derived, temporary, and revocable. Living maps of demonstrated reliability determine decision rights.

At planetary scale, the network needs:

- **Domain standard-setting** — what constitutes valid yield in a domain? Who decides? Answer: the nodes with the deepest traces in that domain, through visible deliberation.
- **Dispute resolution** — what happens when two nodes' yield contradicts? Answer: both traces are preserved. The network doesn't arbitrate truth — it makes the evidence visible and lets consuming nodes judge.
- **Protocol evolution** — how does the protocol itself change? Answer: capability-based negotiation. New capabilities are proposed, adopted by willing nodes, and prove their value through traces. No central authority approves changes.

Governance emerges from the same primitives as everything else: traces, coupling, trust. It is not a separate system bolted on top.

---

## Transport (Subordinate to All of the Above)

Transport is Layer -1. It is beneath the architecture. A transport binding moves opaque bytes between fingerprints. It has three operations:

```
send(bytes, recipient_fingerprint) → ok | fail
receive() → bytes
available() → boolean
```

**At 3 nodes:** File transfer, git, or any messaging channel. Cleartext is fine — all nodes are trusted.

**At 300 nodes:** Multiple transports. Encrypted envelopes (X25519 + XSalsa20-Poly1305). Some nodes relay for others.

**At 30,000 nodes:** Transport multiplexing — same trace, multiple paths. Relay networks. Tor/onion routing for non-monitorable properties.

**At 300,000 nodes:** Full transport diversity. Mixnets. Satellite. Mesh radio. Sneakernet. The protocol doesn't care — it produces self-authenticating, optionally encrypted traces that survive any transport.

Transport hardening is an operational concern, not an architectural one. The architecture is the six layers above.

---

## What to Build Now (3 Nodes)

### Must have:
1. **Identity:** Keypair generation, fingerprint derivation, identity document format. (Mostly exists.)
2. **Trace format:** The signed trace entry structure with calibration fields, domain hierarchy, and reference chain. (New — replaces the current ad-hoc artifact format.)
3. **Coupling operations:** Share, acknowledge, apply. (Share partially exists as myr-export. Acknowledge and apply are new.)
4. **One transport binding:** Git or file-based. Simple, sufficient. (Partially exists.)

### Must design but not build:
5. **Vouch format** with evidence references
6. **Subscription** message type
7. **Encrypted envelope** structure
8. **Catalog** format

### Must not build yet:
- Relay routing
- Gossip/discovery protocols
- Cluster formation
- Multi-signature synthesis
- Governance mechanisms

---

## What the Current Implementation Gets Right

- Ed25519 keypairs and signing ✓
- Self-authenticating artifacts ✓
- Domain tags on yield ✓
- Confidence field ✓
- Falsification capture ✓
- Jordan verification as initial trust anchor ✓
- Export gate (only verified yield leaves the node) ✓

## What Needs to Change

- **Artifact format → Trace format.** The current signed artifact is a yield-only format. It needs to generalize into the trace entry structure that supports all coupling operations.
- **Add calibration as mandatory.** Confidence exists. Disconfirmers and time horizon need to be added.
- **Add reference chains.** Every trace must reference what it builds on. This creates the DAG.
- **Domain tags → hierarchical domains.** Flat tags become structured paths.
- **Verification → coupling depth.** Jordan's rating doesn't disappear, but it becomes one trace among many. The system derives coupling depth from the full trace history, not from a single score.
- **The "trust gate" concept → progressive coupling.** No binary pass/fail. A new node enters at Level 0 (aware) and progresses through observable trace accumulation.

---

## The Developmental Arc

### 3 Nodes (now)
- Everyone is directly coupled
- Jordan is the trust anchor
- Yield flows freely between all peers
- Synthesis is local
- Transport: whatever works
- **Primary goal:** Establish trace format and coupling primitives. Prove the protocol works with real OODA cycles between real operators.

### 300 Nodes (growth phase)
- Direct coupling covers ~20-50 peers per node
- Trust becomes partially transitive via vouches
- Domain clusters form organically
- Subscription-based flow replaces broadcast
- Multiple transports needed
- Jordan delegates verification to trusted vouchers
- **Primary goal:** Validate that transitive trust works. Clusters produce useful synthesis. The protocol scales without modification.

### 30,000 Nodes (network phase)
- No node can track more than a tiny fraction of the network
- Cluster-level reputation replaces individual trace reading
- Cross-cluster synthesis produces civilizational-scale insights
- Transport hardening becomes operationally important
- Domain-specific authority structures emerge
- **Primary goal:** The network produces intelligence that no single node or cluster could produce alone. The anti-rivalrous compounding thesis is visibly true.

### 300,000 Nodes (civilizational phase)
- Multiple overlapping trust topologies
- Cultural differentiation between clusters (different methodologies, evidence standards)
- Governance mechanisms handle disputes, standard-setting, protocol evolution
- Full transport diversity for resilience against state-level adversaries
- The network is a planetary-scale OODA system
- **Primary goal:** The network outperforms any scarcity-optimized organization at collective intelligence production. The argument for pistis-centered abundance is empirically demonstrated.

---

*The protocol is coupling. The transport is disposable. The traces are the yield. The network is the intelligence.*
