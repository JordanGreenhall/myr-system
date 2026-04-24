# Cohort Onboarding Checklist

Per-cohort onboarding procedures for C0 through C2.

---

## C0 — Protocol Validation (3 nodes)

**Entry**: Direct invite, manual onboarding.
**Duration**: Ongoing until all C0 metrics met x2 consecutive weeks.
**Onboarding SLA**: < 1 hour (guided).

### Pre-onboarding (Operator)

- [ ] New peer has completed the [Operator Setup Checklist](checklist-operator-setup.md)
- [ ] New peer's node is reachable at their public URL
- [ ] New peer's health endpoint returns `"status": "ok"`
- [ ] New peer has generated Ed25519 keypair

### Peer Introduction

- [ ] **Exchange public URLs** out-of-band (direct message, call, etc.)

- [ ] **Add peer on your node**
  ```bash
  myr peer add --url https://PEER_NODE_URL:3719
  ```
  Expected: peer appears in pending state.

- [ ] **Verify peer's discovery document**
  ```bash
  curl https://PEER_NODE_URL:3719/.well-known/myr-node
  ```
  Expected: valid JSON with matching `public_key`.

- [ ] **3-way fingerprint verification** — confirm fingerprint matches out-of-band:
  ```bash
  myr peer list
  ```
  Read the `SHA-256:xx:xx:...` fingerprint aloud or share via secure channel. Peer confirms it matches their key.

- [ ] **Approve peer**
  ```bash
  myr peer approve SHA-256:xx:xx:xx:...
  ```
  Expected: peer trust set to `trusted` or `provisional`.

- [ ] **Peer approves you** (mutual approval required for Provisional stage)

### First Sync

- [ ] **Trigger manual sync**
  ```bash
  myr sync-all
  ```
  Expected: sync completes with reports exchanged (or 0 if first connection).

- [ ] **Verify sync freshness**
  ```bash
  curl http://localhost:3719/myr/metrics
  ```
  Check: `sync.sync_lag_seconds` <= 60.

- [ ] **Verify peer count**
  ```bash
  curl http://localhost:3719/myr/health
  ```
  Check: `peers_active` incremented.

### Post-onboarding Verification

- [ ] **Peer captures first yield** within 24 hours
- [ ] **Peer's yield appears after next sync**
  ```bash
  node scripts/myr-search.js --query "peer-topic"
  ```
- [ ] **Gossip is operational** — check IHAVE/IWANT counters:
  ```bash
  curl http://localhost:3719/myr/metrics | grep -i gossip
  ```
  Expected: `ihave_sent` and `ihave_received` > 0 after first sync cycle.

---

## C1 — Gossip Validation (10 nodes)

**Entry**: Direct invite, guided onboarding.
**Duration**: 4 weeks after all C0 gates pass.
**Onboarding SLA**: < 1 hour (guided).
**Gate from C0**: All C0 metrics met x2 consecutive weeks.

### Pre-requisites (Gate C0 -> C1)

- [ ] Gossip transport validated (IHAVE/IWANT operational)
- [ ] Governance signal propagation tested
- [ ] Onboarding documented and tested with 1+ new node
- [ ] Structured logging operational

### Per-Peer Onboarding

Follow the same steps as C0, plus:

- [ ] **Verify gossip convergence** after adding peer
  ```bash
  curl http://localhost:3719/myr/metrics
  ```
  Check: `gossip.active_view_size` >= 2 (at least `fanout - 1`).

- [ ] **Verify multi-hop propagation** — after peer syncs with their other peers, check that yields from non-direct peers arrive:
  ```bash
  node scripts/myr-search.js --query "from-indirect-peer"
  ```

- [ ] **Verify domain trust scoring**
  ```bash
  curl http://localhost:3719/myr/participation/peer/PEER_PUBLIC_KEY
  ```
  Expected: participation stage and domain trust scores visible.

### C1 Success Metrics (Check Weekly)

- [ ] Sync freshness: all peers <= 2 sync cycles behind
- [ ] Participation rate: >= 80% of nodes produce weekly yield
- [ ] Yield quality: >= 60% of reports rated 3/5+
- [ ] Gossip convergence: <= 5 hops to full network
- [ ] Peer churn: < 10% unreachable > 48h

---

## C2 — Subscription Filtering (50 nodes)

**Entry**: Referral invite, self-serve onboarding.
**Duration**: 6 weeks after all C1 gates pass.
**Onboarding SLA**: < 30 min (self-serve).
**Gate from C1**: All C1 metrics met x3 consecutive weeks.

### Pre-requisites (Gate C1 -> C2)

- [ ] Subscription enforcement operational
- [ ] 3+ domain tags actively used across network
- [ ] Peer sampling validated at N=10
- [ ] No Sev1 incidents unresolved in prior 4 weeks

### Per-Peer Onboarding (Self-Serve)

- [ ] **Generate invite URL**
  ```bash
  myr invite create
  ```
  Share the `myr://invite/<token>` URL with the new peer.

- [ ] **New peer joins via invite**
  ```bash
  myr join "myr://invite/<token>"
  ```
  Expected: automatic introduction and pending approval.

- [ ] **Approve peer** (or have referrer vouch)
  ```bash
  myr peer approve SHA-256:xx:xx:xx:...
  ```

- [ ] **New peer sets domain subscriptions**
  ```bash
  curl -X POST http://localhost:3719/myr/subscriptions \
    -H "Content-Type: application/json" \
    -d '{"tags": ["domain1", "domain2"]}'
  ```
  Expected: filtered IHAVE messages based on subscriptions.

- [ ] **Verify subscription filtering**
  ```bash
  curl http://localhost:3719/myr/subscriptions
  ```
  Expected: declared domain subscriptions listed.

### C2 Success Metrics (Check Weekly)

- [ ] All C1 metrics continue to hold
- [ ] Subscription adoption: >= 50% of nodes declare subscriptions
- [ ] Filtered IHAVE: >= 30% of IHAVE messages filtered by subscription
- [ ] Governance propagation: < 3 sync cycles
- [ ] Onboarding success: >= 90% of join attempts succeed within 30 min

---

## Automated Cohort Check

Run the cohort status script to verify the current state:

```bash
bash scripts/pilot/verify-cohort-status.sh http://localhost:3719
```

This checks peer count, sync status, gossip view size, and participation metrics.
