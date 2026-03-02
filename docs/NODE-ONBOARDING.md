# MYR Network — Node Onboarding Guide

**Version:** 1.0  
**Date:** 2026-02-27  
**For:** Incoming Node operators (Node 1, Node 2)

---

## What This Is

You're joining a small network that shares **Methodological Yield** — what we've actually learned, operationally, from real work cycles. Not reports. Not summaries. Findings that change how you work, proven by use.

The system is called MYR (Methodological Yield Reports). It runs locally on your node. You capture what you learn, verify it, and share selected artifacts with other nodes on a weekly cadence. They do the same for you.

The network is currently three nodes. The protocol is deliberately simple at this scale.

---

## Core Concept: What Is Yield?

A MYR is not a status update or a document summary. It answers one question:

> **"What do I know now that I didn't know before, that would change how I or someone else works?"**

There are four types:
- **Technique** — a method that works, reusable
- **Insight** — a conceptual shift that changes orientation
- **Falsification** — something proven NOT to work (the most valuable type — prevents repeated failure)
- **Pattern** — a recurring structure observed across multiple cycles

Every MYR includes: what was attempted, what evidence supports the finding, what changes next because of it, and a confidence estimate with explicit disconfirmers.

---

## Your Responsibilities as a Node Operator

There are two things you're responsible for:

**1. Producing real yield.**
Run the MYR capture tool after significant work sessions. Rate your own reports honestly. The network only shares Jordan-verified artifacts (rating ≥ 3/5) — so build up a verified corpus before your first export.

**Joining gate:** ≥10 MYRs with average rating ≥ 3.0 before you participate in cross-node exchange.

**2. Closing the loop.**
When you receive yield from another node, you respond. No silent imports. A two-sentence reply is sufficient. If you apply something, say so. If nothing was applicable this week, say that too.

A node that only receives and never responds isn't in the protocol.

---

## The Weekly Cycle

The sharing protocol runs on a weekly cadence.

### Step 1 — Review your week's yield

Run the weekly synthesis:
```bash
node scripts/myr-weekly.js
```

Read the output with one question: **"Which of these findings would change how another node works if they had it?"**

Select by priority:
1. **Falsifications first** — always share these
2. **Techniques** with confidence ≥ 0.7 and at least one real application
3. **Skip** insights that are still speculative or highly context-specific to your work

Note the IDs you want to export.

### Step 2 — Create the export artifact

```bash
node scripts/myr-export.js --ids "n1-20260220-003,n1-20260221-001"
# Output: exports/2026-02-27-n1.myr.json
```

Only your verified MYRs are exportable. The gate is enforced automatically.

### Step 3 — Share

Push your export file to the shared `yields/` directory in the repo:

```
samuel-workspace/
└── yields/
    ├── 2026-02-27-n1.myr.json
    ├── 2026-02-27-n2.myr.json
    └── 2026-02-27-n3.myr.json
```

The files are self-authenticating (Ed25519 signed). No secure channel required for transport.

### Step 4 — Import from other nodes

Pull the repo and import new artifacts from peers:

```bash
node scripts/myr-import.js --file ./yields/2026-02-27-n2.myr.json --peer-key ./keys/n2.public.pem
```

The import tool verifies the signature, checks for duplicates, and writes to your local database.

### Step 5 — Respond

After reviewing imported artifacts, reply to the shared thread (Signal, git comment, or whatever channel your network uses):

> "Imported 2026-02-27-n1.myr.json. Applied `n1-20260221-001` [technique name] in [session/domain]. Outcome: [one sentence]. Two others queued for review next week."

Or if nothing applied:

> "Imported 2026-02-27-n1.myr.json. Read all three. Nothing directly applicable this cycle — `n1-20260223-007` is relevant to upcoming work, flagged for next week."

Respond within one week of import.

---

## Bootstrap: Your First Exchange

Before you join the regular weekly cycle, you and your direct peer run a one-time bootstrap:

1. **Exchange identity documents out-of-band** — share public keys via a verified channel (in-person, Signal, video call). Each side confirms: fingerprint matches public key.

2. **Key confirmation** — each side signs a short nonce challenge from the other and returns it. Verify before proceeding.

3. **Genesis share** — each node exports and shares one verified MYR. This is your first real exchange.

4. **Acknowledge** — each side confirms receipt and reads the artifact.

5. **Apply** — each side applies one received MYR in real work and reports the outcome in the shared thread.

Bootstrap complete. You're now at coupling level: **Coordinate**. The regular weekly cycle begins.

---

## What "Coupling Depth" Means

Your relationship with each peer node has a depth that emerges from your shared history — not from anything you declare.

| Level | Name | What it looks like |
|-------|------|-------------------|
| 0 | Aware | You have each other's keys |
| 1 | Observe | You read each other's yield; no interaction yet |
| 2 | Coordinate | You share yield, acknowledge, discuss |
| 3 | Depend | You apply each other's yield in real work and report outcomes |
| 4 | Bind | Mutual commitments, shared synthesis, explicit obligations |

You don't claim a level. It's visible in the trace history. The bootstrap ceremony gets you to Level 2. Sustained apply loops get you to Level 3.

---

## What You Get Out of This

Your local MYR database compounds over time. You accumulate:
- A searchable corpus of what works and what doesn't in your domain
- Cross-validated findings (confirmed by ≥2 nodes) that carry higher confidence
- Falsification records that prevent repeated failure across the network
- A visible track record of OODA reliability that other nodes can inspect

The weekly synthesis surfaces convergent findings — places where multiple nodes independently arrived at the same conclusion. These are the highest-confidence outputs the network produces.

---

## The One Rule

**Produce real yield. Share honestly. Close the loop.**

The system has no enforcement mechanism beyond visibility. A node that performs yield without running real OODA cycles, exports without selecting thoughtfully, or imports without responding — that's legible in the trace history. The network doesn't punish it. It simply becomes visible, and other nodes make their own decisions about coupling depth accordingly.

---

## Getting Started

1. Install the MYR system: `git clone {repo} && npm install && cp config.example.json config.json`
2. Configure your node ID in `config.json`
3. Generate your keypair: `node scripts/myr-keygen.js`
4. Share your public key with your peer node(s) out-of-band
5. Start capturing yield: `node scripts/myr-store.js --interactive`
6. Build to ≥10 verified MYRs
7. Run the bootstrap ceremony with your first peer
8. Join the weekly cycle

Questions on setup: consult the README. Questions on the protocol: contact Jordan.

---

*The intelligence-machine is the product. Your node is part of it.*
