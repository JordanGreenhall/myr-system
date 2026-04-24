# MYR Pilot Brief

**For:** First release cohort operators
**System version:** 1.3.1
**Date:** April 2026
**Operating model:** See `docs/PILOT-OPERATING-MODEL.md` for cohort strategy, success metrics, and growth gates

---

## What You're Joining

A growing network (currently 3 nodes, targeting 10,000+ participants) that shares verified methodological yield — knowledge about what works, what fails, and what changes, captured from real work cycles and cryptographically signed.

MYR is not a messaging system. It is an intelligence compounding system. Your node captures what you learn. The network compounds it across participants. Growth follows a cohort model with explicit gates at 10, 50, 200, 1,000, and 10,000+ nodes (see `docs/PILOT-OPERATING-MODEL.md`).

---

## What Works Today

**Your node is immediately useful alone.** You can capture, search, verify, and synthesize your own yield without connecting to anyone. The local intelligence machine is fully operational.

**Network exchange is real.** Ed25519-signed artifacts, bounded-fanout gossip transport (IHAVE/IWANT + Bloom anti-entropy), 3-way fingerprint verification, DHT peer discovery, and relay fallback for nodes behind NAT. The protocol is tested with 436 automated test cases and O(N*F) message complexity validated at N=1,000.

**Onboarding is one step.** `curl | bash` install, or `myr join "<invite-url>"` to connect to an existing node.

---

## What Doesn't Work Yet

**No transitive trust.** Every trust relationship requires direct verification. You cannot be "vouched for" by a mutual peer.

**No demand-driven yield flow.** You receive all yield from trusted peers, not yield filtered to your domains of interest. Subscription signals exist in code but don't yet drive routing.

**No yield revocation.** Once exported, a report cannot be recalled or invalidated.

**Scale ceiling: ~2,000 nodes without coordinators.** v1.3.0 gossip transport supports O(N*F) scaling to ~2,000 nodes. Beyond that, domain coordinators are required (see `docs/ADR-scale-architecture.md` Phase 4). Coordinator architecture must be validated before 1,000 nodes — the hard intermediate rung — to avoid a scaling cliff on the path to 10,000+.

---

## What's Expected of You

1. **Capture real yield.** Run `myr-store` after meaningful work sessions. Rate honestly. Only verified MYRs (>= 3/5) leave your node.

2. **Close the loop.** When you import yield from a peer, respond — even if it's "nothing applicable this week." A node that only receives is visibly not participating.

3. **Verify out-of-band.** Before approving a peer, confirm their fingerprint through a channel you trust (Signal, phone, in person). The protocol enforces 3-way cryptographic verification, but initial trust is a human decision.

---

## The Weekly Cycle

| Step | Command | What happens |
|------|---------|-------------|
| 1. Review your week | `node scripts/myr-weekly.js` | Synthesis of your yield by type and domain |
| 2. Export | `node scripts/myr-export.js --all` | Signed bundle of verified MYRs |
| 3. Sync | `myr sync-all` | Pull new yield from trusted peers |
| 4. Synthesize | `node scripts/myr-synthesize.js --tags "domain"` | Cross-node convergent/divergent analysis |
| 5. Respond | (your channel) | Acknowledge what you received and whether you applied it |

---

## Participation Stages

Your relationship with the network deepens from evidence, not from declaration.

| Stage | Entry | Capability |
|-------|-------|-----------|
| Local Only | Install + configure | Capture, search, verify — no network |
| Provisional | 1 trusted peer + 3-way verify | Sync with up to 3 peers, rate-limited |
| Bounded | Trusted by >= 3 peers | Full sync, DHT active, serve sync requests |
| Trusted | Deep coupling history | Bridge across domains, vouch for new nodes (not yet built) |

Stage progression is computed from your trace history — every coupling event is logged and auditable.

---

## Risks and Honest Limits

- **The network is small.** Three nodes. The value of cross-node synthesis scales with participation. At current size, local yield is the primary value. The cohort growth plan targets 10,000+ participants.
- **Sync uses gossip transport.** Bounded-fanout gossip with push-lazy dissemination. Reports propagate epidemically in O(log_F(N)) hops. Weekly review cadence is the operational design point.
- **Governance is network-wide.** Revocation and quarantine signals propagate via governance gossip. Contradiction detection and resolution workflows exist. Key rotation is supported. See `docs/SUPPORT-OPERATIONS.md` and `docs/RUNBOOKS.md` for incident and recovery procedures.
- **Key management is your responsibility.** Your Ed25519 keypair is your identity. Compromise means all your historical signatures are attributable to the attacker. Back up `~/.myr/keys/` securely. Key rotation is available via `POST /myr/governance/key-rotate`.

---

## Getting Started

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/JordanGreenhall/myr-system/main/install.sh | bash

# Or join via invite
myr join "myr://invite/<token-from-existing-node>"

# Capture your first MYR
node scripts/myr-store.js --interactive

# Verify it
node scripts/myr-verify.js --queue

# Start the server for network sync
myr start
```

Questions on setup: see the Operator Guide (`docs/OPERATOR-GUIDE.md`).
Growth plan and success metrics: see the Pilot Operating Model (`docs/PILOT-OPERATING-MODEL.md`).
Scale architecture: see the ADR (`docs/ADR-scale-architecture.md`).
Questions on the protocol: contact Jordan.
