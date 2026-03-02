# Starfighter/Pistis Protocol Reconciliation Draft (v1)

**Date:** 2026-02-27  
**Author:** Polemarch  
**Purpose:** Resolve the architecture/spec gap before sharing with Node 1/2 collaborators.

---

## Executive Decision

We adopt a **trace-first model now**.

- **Yield Artifact (MYR)** = what was learned (static payload, signed by producer)
- **Coupling Event (Trace)** = what happened between nodes (share/ack/apply/vouch/etc., signed by actor)

The old Phase-2 artifact envelope (`{version, artifact_type, payload, signature}`) remains valid as a **payload format only**. It is no longer treated as the full network event record.

---

## 1) Canonical Data Model (Now)

## 1.1 Yield Artifact (MYR)

```json
{
  "myr_v": 1,
  "myr_id": "n1-20260227-001",
  "producer": "<producer fingerprint>",
  "timestamp": "ISO8601",
  "domain": ["systems-architecture", "agent-design"],
  "yield": {
    "type": "technique|insight|falsification|pattern",
    "intent": "...",
    "question_answered": "...",
    "evidence": "...",
    "what_changes_next": "...",
    "what_was_falsified": null,
    "confidence": 0.78,
    "disconfirmers": ["..."],
    "time_horizon": "30d"
  },
  "verification": {
    "operator_rating": 4,
    "operator_notes": "...",
    "verified_at": "ISO8601"
  },
  "signature": "<producer Ed25519 over canonical artifact body>"
}
```

## 1.2 Coupling Trace (Network Event)

```json
{
  "trace_v": 1,
  "trace_id": "uuid",
  "trace_type": "share|ack|apply|vouch|commit|fulfill|breach|subscribe|catalog",
  "from": "<actor fingerprint>",
  "regarding": "<counterparty fingerprint>",
  "timestamp": "ISO8601",
  "domain": ["systems-architecture", "agent-design"],
  "references": ["trace:<id>", "myr:<myr_id>"],
  "content": { "type-specific fields": "..." },
  "calibration": {
    "confidence": 0.0,
    "disconfirmers": [],
    "time_horizon": "..."
  },
  "signature": "<actor Ed25519 over canonical trace body>"
}
```

**Invariant:** A MYR can exist without being shared. A share can never exist without referencing a MYR.

---

## 2) Event Semantics (Minimal Set for Node 0/1/2)

### 2.1 `share`
- Actor sends one or more MYR artifacts to a specific node
- `references` must include `myr:<id>` for each shared artifact
- `content` includes transport channel metadata (optional)

### 2.2 `ack`
- Receiver confirms receipt and relevance assessment
- Must reference the originating `share` trace

### 2.3 `apply`
- Receiver reports application of shared MYR in local OODA cycle
- Must reference the originating `share` (or `ack`) trace and the MYR id
- Produces highest-value coupling signal

This is sufficient for first external collaboration.

---

## 3) Node 0 ↔ Node 1 Bootstrap Ceremony (MUST)

This is the first trust-critical event and must be fully documented as traces.

1. **Identity Exchange**
   - Exchange identity docs out-of-band (in-person/verified channel)
   - Each side verifies fingerprint match against presented public key

2. **Key Confirmation**
   - Each side signs a nonce challenge from the other
   - Verify signatures before proceeding

3. **Genesis Share**
   - Node 0 shares 1 verified MYR to Node 1 (`share` trace)
   - Node 1 shares 1 verified MYR to Node 0 (`share` trace)

4. **Acknowledge**
   - Each side emits `ack` trace referencing received `share`

5. **Apply**
   - Each side applies one received MYR in real work and emits `apply` trace

6. **Bootstrap Complete**
   - Mark pair coupling depth = Coordinate (eligible to progress to Depend after successful apply loop)

All six steps become the template for Node 2 onboarding.

---

## 4) Sybil Resistance Succession (Post-Jordan Path)

Current state (3-node stage):
- Joining gate: ≥10 MYRs, avg operator rating ≥3.0
- Jordan acts as root verification anchor

Succession rule (activate at 300+):
- New node admission requires **N domain-relevant vouches** from established nodes
- `N` scales with network size:
  - 3–99 nodes: N=1
  - 100–999 nodes: N=2
  - 1,000+ nodes: N=3
- At least one vouch must come from a node with demonstrated traces in target domain
- Vouch must reference concrete `share/ack/apply` trace evidence, not ratings alone

This creates a path beyond single-human bottleneck while preserving quality.

---

## 5) Migration Note (Old Phase 2 → Trace-First)

No data loss migration:

- Existing signed exports (`artifact_type: myr`) remain valid **MYR payloads**
- For each imported/exported artifact event, generate synthetic `share` trace entries (backfill)
- Existing verification ratings map into `verification.operator_rating`
- New network interactions must emit explicit traces (`share`, `ack`, `apply`) going forward

Result: old artifacts preserved; new protocol semantics become explicit.

---

## 6) External Sharing Readiness Checklist (Node 1/2)

Must pass before sharing spec externally:

1. ✅ Yield/Event separation reflected in docs and schema
2. ✅ Bootstrap ceremony documented and reproducible
3. ✅ Sybil succession rule specified (N-vouch scaling)
4. ✅ Migration note from old artifact envelope clarified
5. ✅ Minimal ping/ack/apply conformance test defined

---

## 7) Immediate Next Edits

Update these files to align with this draft:

1. `docs/PHASE-2-SPEC.md`
   - Recast artifact envelope as MYR payload format
   - Add trace layer section and minimal event set

2. `docs/NETWORK-ARCHITECTURE.md`
   - Tighten language: MYR payload vs coupling trace
   - Insert explicit bootstrap ceremony and succession thresholds

3. `README.md`
   - Add “network trace mode” section and conformance loop (`share → ack → apply`)

4. `schema/`
   - Add `trace-event.json` alongside `myr-report.json`

---

**Bottom line:** We do not throw away Phase 2 work. We place it in the right layer. MYR is payload. Trace is protocol.