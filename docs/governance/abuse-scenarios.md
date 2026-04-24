# Abuse Scenario Playbook

Operational procedures for detecting and responding to governance threats in the MYR network. Each scenario includes detection signals, response path, trust-weight impact, and recovery procedure.

---

## 1. Sybil Attack

**Description:** An adversary creates many fake node identities to gain disproportionate influence in trust scoring, stage promotion, or gossip propagation.

**Detection signals:**
- Burst of new peer registrations sharing network fingerprint patterns (IP range, timing)
- Multiple nodes reach `provisional` stage simultaneously with suspiciously circular mutual approvals
- `myr_traces` shows clustered `approve` events between nodes with no prior organic interaction
- Domain trust scores spike for a domain with low historical activity

**Response path:**
1. Query `GET /myr/governance/audit?limit=200` and filter `approvals` for clustered timestamps
2. Identify the set of suspect public keys via mutual-approval graph analysis
3. For each suspect node: `POST /myr/governance/revoke` with `peer_fingerprint` (first 12 chars of public key)
4. Governance revocation signals propagate via gossip (TTL=5 default)
5. Log incident in `myr_traces` with event_type `revoke` and metadata documenting the cluster

**Trust-weight impact:**
- All revoked peers drop to `trust_level: 'revoked'` in `myr_peers`
- Their yields remain in storage but are excluded from trust-weighted recall scoring
- Mutual approvals from revoked peers no longer count toward promotion criteria for other nodes
- Peers who received promotions from Sybil-influenced approvals should be re-evaluated via `GET /myr/participation/evaluate`

**Recovery procedure:**
- Re-run `evaluateStage()` for all peers who had mutual approvals with revoked nodes
- Demotions cascade automatically when approval counts drop below thresholds
- Monitor `myr_traces` for re-registration attempts from similar network patterns
- Consider tightening promotion criteria temporarily (raise `minMutualApprovals` threshold)

---

## 2. Yield Poisoning

**Description:** A malicious or compromised node submits deliberately false or misleading yields to corrupt the knowledge base.

**Detection signals:**
- Spike in falsification yields targeting specific domains
- Contradiction detection (`detectContradictions()`) flags high-confidence yields opposing established consensus
- Operator ratings for yields from a specific source drop below 2.0
- Recall scoring shows `contradictionPenalty` applied frequently to one source's yields

**Response path:**
1. Run `detectContradictions(db, { domain: '<affected-domain>' })` to enumerate suspect yields
2. For each poisoned yield: `POST /myr/governance/quarantine` with `yield_id` and `reason`
3. If the source node is systematically producing poison: `POST /myr/governance/revoke` the peer
4. Resolve contradictions: call `resolveContradiction()` with operator notes documenting the poisoning

**Trust-weight impact:**
- Quarantined yields are excluded from recall: `NOT EXISTS (SELECT 1 FROM myr_quarantined_yields q WHERE q.yield_id = r.id AND q.status = 'active')`
- Source peer's domain trust score drops via lower `avgRating` and increased falsification count
- `contradictionPenalty` in `yield-scoring.js` reduces scores for all yields involved in unresolved contradictions

**Recovery procedure:**
- Review all yields from the quarantined source via `SELECT * FROM myr_reports WHERE source_node_id = ?`
- Quarantine additional suspect yields as needed
- If peer was revoked, their stage drops and all capabilities are removed
- Re-run contradiction detection after cleanup to verify no residual contradictions

---

## 3. Trust Manipulation

**Description:** A node (or colluding group) exploits the promotion/demotion system to gain `trusted-full` status without genuine contributions.

**Detection signals:**
- A peer reaches `trusted-full` with minimal yield volume but exactly-threshold mutual approvals
- `stage_evidence` in `myr_peers` shows promotion stats barely meeting criteria (e.g., exactly 10 mutual approvals, exactly 50 shared MYRs)
- Approval patterns show reciprocal-only relationships (A approves B, B approves A, no broader network)
- `myr_traces` with event_type `stage_change` shows rapid promotion timeline (< 7 days from `local-only` to `trusted-full`)

**Response path:**
1. Query `GET /myr/participation/peer/:publicKey` for suspect nodes to inspect promotion stats
2. Cross-reference mutual approval graph for closed-loop patterns
3. If manipulation confirmed: revoke trust via `POST /myr/governance/revoke`
4. Re-evaluate all peers whose promotions depended on the manipulator's approvals

**Trust-weight impact:**
- Revoked peer loses all capabilities and drops to `trust_level: 'revoked'`
- Domain trust scores for the peer's contributions recalculate to near-zero
- Peers promoted with help from manipulator's approvals may demote when mutual approval count drops

**Recovery procedure:**
- Batch re-evaluation: iterate affected peers through `evaluateStage()` to trigger cascading demotions
- Add monitoring for approval velocity anomalies
- Document manipulation pattern in operational notes for future detection

---

## 4. Data Exfiltration via Sync

**Description:** A node at `provisional` or higher stage abuses sync capabilities to bulk-download the yield database without contributing.

**Detection signals:**
- `myr_traces` shows high volume of `sync_pull` events from a single peer with zero `sync_push` events
- Peer's shared MYR count stays at minimum while pull volume is disproportionate
- Rate limiter (60 req/min authenticated) triggers repeatedly for the peer

**Response path:**
1. Query audit trail: `SELECT * FROM myr_traces WHERE actor_key = ? AND event_type = 'sync_pull' ORDER BY timestamp DESC`
2. If pull:push ratio exceeds 10:1 with no organic contributions, flag as exfiltration
3. Demote peer: revoke trust to block further sync access
4. If data sensitivity warrants, quarantine yields the peer may have seeded (possible poisoning cover)

**Trust-weight impact:**
- Revoked peer loses `canSync` capability, blocking all further data access
- Peer's trust scores reset; existing yields remain but are not amplified in recall

**Recovery procedure:**
- No data can be "unexfiltrated" — focus on limiting future access
- Review what data was accessible during the peer's active period
- Consider adding per-peer sync volume tracking to `myr_traces` metadata

---

## 5. Gossip Flooding

**Description:** A malicious node attempts to overwhelm the gossip network by broadcasting excessive IHAVE messages or governance signals.

**Detection signals:**
- Rate limiter returns 429 responses repeatedly for a single peer
- Governance signal deduplication rejects high volume of duplicate `signal_id` values
- Gossip layer sees IHAVE messages exceeding normal fanout patterns (F=5 default)
- Network-wide hop_count patterns show unusual propagation depth

**Response path:**
1. Identify the flooding source from rate limiter logs and `myr_governance_signals` duplicate rejection patterns
2. Revoke the flooding peer: `POST /myr/governance/revoke`
3. TTL bounds (default 5 hops) naturally limit flood propagation depth
4. Deduplication via `signal_id` PRIMARY KEY prevents replay amplification

**Trust-weight impact:**
- Revoked peer loses `canRelay` and `canSync` capabilities
- Gossip fanout naturally excludes revoked peers from active view
- No trust score impact on honest peers (flood signals are deduplicated, not applied twice)

**Recovery procedure:**
- Network self-heals: TTL expiry and dedup prevent persistent flood effects
- Monitor `myr_governance_signals` for lingering flood artifacts
- Verify honest peers' gossip state is clean via `GET /myr/governance/audit`

---

## 6. Coordinator Gaming

**Description:** A node manipulates coordinator-assisted routing to steer sync traffic, bias peer selection, or gain preferential relay positioning.

**Detection signals:**
- Coordinator logs show a single node requesting routing information at abnormal frequency
- Peer selection patterns show convergence toward a single relay node
- `myr_traces` with event_type `relay_sync` shows one node handling disproportionate relay volume
- Subscription filtering bypassed: IHAVE payloads arrive for unsubscribed domains

**Response path:**
1. Audit relay patterns: `SELECT actor_key, COUNT(*) FROM myr_traces WHERE event_type = 'relay_sync' GROUP BY actor_key ORDER BY COUNT(*) DESC`
2. If a single node handles >30% of relay traffic without proportional stage justification, investigate
3. Revoke or demote the gaming node
4. If coordinator itself is compromised, rotate coordinator credentials and re-bootstrap routing

**Trust-weight impact:**
- Gaming node loses relay capability upon demotion/revocation
- Peers who relied on the gaming node for routing re-discover alternate paths via gossip
- Domain trust scores for the gaming node's contributions are not directly affected unless yields are also suspect

**Recovery procedure:**
- Peers re-equilibrate routing through normal gossip peer sampling
- Verify coordinator routing tables are clean after removing gaming node
- Monitor for re-registration under new identity (see Sybil scenario)

---

## 7. Key Compromise

**Description:** A node's Ed25519 private key is compromised, allowing an attacker to impersonate the node, sign governance signals, or forge yield submissions.

**Detection signals:**
- Legitimate operator reports unexpected actions under their node identity
- Governance signals appear with valid signatures but unintended actions (revocations the operator didn't initiate)
- Key rotation announcements appear that the operator didn't generate
- Yields submitted from the node's identity that the operator doesn't recognize

**Response path:**
1. Immediately rotate the compromised key: `POST /myr/governance/key-rotate` with `node_id`
   - Generates new Ed25519 keypair
   - Creates rotation announcement endorsed by old key (if old key still available)
   - Propagates via governance gossip
2. If old key is fully compromised (attacker holds it), the attacker could also issue a competing rotation
   - In this case: revoke the old key via a trusted peer's governance signal
   - Manually distribute the new public key to trusted peers out-of-band
3. Quarantine any yields or governance signals signed by the compromised key during the exposure window

**Trust-weight impact:**
- `applyKeyRotation()` updates `myr_peers` with new public key and tracks `previous_public_key`
- Trust scores and stage carry over to the new key (identity continuity)
- If key was used maliciously before rotation, manual quarantine of affected yields reduces their recall scores

**Recovery procedure:**
- Verify rotation announcement propagated to all peers via `GET /myr/governance/audit`
- Audit all actions signed by old key during exposure window
- Re-endorse critical governance decisions with new key if needed
- Update any external systems that cached the old public key

---

## 8. Collusion Ring

**Description:** Multiple nodes coordinate to manipulate trust scores, manufacture consensus, suppress contradictions, or protect poisoned yields from quarantine.

**Detection signals:**
- Graph analysis of mutual approvals reveals dense cliques with minimal external connections
- Contradiction resolution patterns show the same set of nodes resolving each other's contradictions
- Operator ratings for the ring's yields are exclusively from ring members
- Stage promotions within the ring follow a coordinated timeline (sequential promotions within hours)

**Response path:**
1. Map the collusion ring via approval graph: `SELECT * FROM myr_peers WHERE trust_level = 'trusted' ORDER BY stage_changed_at`
2. Cross-reference with `myr_traces` to identify closed-loop approval and rating patterns
3. Revoke all confirmed ring members: batch `POST /myr/governance/revoke` for each peer
4. Quarantine yields that received artificially inflated ratings from ring members
5. Re-run contradiction detection to surface previously suppressed contradictions

**Trust-weight impact:**
- All ring members lose trust and capabilities
- Cascading demotions affect honest peers who happened to have approvals from ring members
- Domain trust scores in affected domains recalibrate significantly

**Recovery procedure:**
- Batch re-evaluate all peers in affected domains via `evaluateStage()`
- Review and re-rate yields that were exclusively rated by ring members
- Re-resolve contradictions that ring members had previously resolved
- Strengthen promotion criteria: consider requiring approval diversity (not just count)
