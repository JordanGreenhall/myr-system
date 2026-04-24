# MYR Network — Node Onboarding Guide

**Version:** 1.2.1 (source correction docs)
**Date:** 2026-04-24
**For:** Incoming Node operators

---

## What This Is

You're joining a small network that shares **Methodological Yield** — what we've actually learned, operationally, from real work cycles. Not reports. Not summaries. Findings that change how you work, proven by use.

The system is called MYR (Methodological Yield Reports). It runs locally on your node. You capture what you learn, verify it, and share selected artifacts with other nodes through live/background sync on the normal path. Manual file exchange remains available when needed.

The protocol is deliberately simple at small scale (3–100 nodes).

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
Run the MYR capture tool after significant work sessions. Rate your own reports honestly. The network only shares verified artifacts (rating >= 3/5).

**First-value gate:** >=1 verified MYR before your first cross-node exchange.

**2. Closing the loop.**
When you receive yield from another node, you respond. No silent imports. A two-sentence reply is sufficient. If you apply something, say so. If nothing was applicable this week, say that too.

A node that only receives and never responds isn't in the protocol.

---

## Join the Network

### Invite-link join (normal path)

1. Existing node runs `myr invite create` and shares the `myr://invite/...` URL.
2. New node runs `myr join "<invite-url>"`.
3. Join flow auto-introduces, verifies the fingerprint, and validates invite signature integrity.
4. Both nodes exchange one verified MYR and acknowledge receipt.
5. Each side applies one received MYR and reports outcome in the shared thread.

Join complete. You're now at coupling level: **Coordinate**.

After joining, yield exchange happens automatically via live sync (`myr sync-all` or the auto-sync agent). See the [Operator Guide](OPERATOR-GUIDE.md) for sync details.

---

## The Weekly Cycle

Run weekly synthesis to review what your node has accumulated:

```bash
node scripts/myr-weekly.js
```

Read the output with one question: **"Which of these findings would change how another node works if they had it?"**

Priority: **Falsifications first** (always share), then techniques with confidence ≥ 0.7 and at least one real application. Skip insights that are still speculative.

With live sync enabled, verified yield (rating ≥ 3) is shared automatically. The weekly synthesis is your review checkpoint, not a manual export step.

### Manual file-based exchange (advanced / offline)

If live sync is unavailable, you can export and import artifacts manually:

```bash
# Export
node scripts/myr-export.js --all
# Import from peer
node scripts/myr-import.js --file ./imports/peer-export.myr.json --peer-key ./keys/peer.public.pem
```

After importing, respond to the sharing thread within one week — acknowledge what you applied and what you queued for review.

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
4. Start capturing yield: `node scripts/myr-store.js --interactive`
5. Build your first verified MYR
6. Exchange an invite link (`myr invite create` / `myr join "<invite-url>"`)
7. Run first exchange + acknowledgement
8. Join the weekly cycle
9. Before publish/release, run: `npm run test:release` (includes onboarding acceptance truth gate)

Questions on setup: consult the README. Questions on the protocol: contact Jordan.

---

*The intelligence-machine is the product. Your node is part of it.*
