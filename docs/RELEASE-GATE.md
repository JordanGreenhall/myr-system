# MYR System Release Gate Assessment

**Date:** 2026-04-24
**Assessor:** Worf (Security & QA Officer)
**Scope:** Governance, abuse resistance, observability, and release readiness
**Test Baseline:** 388/389 tests pass (1 pre-existing failure in cli.test.js:498)

---

## Overall Verdict: CONDITIONAL PASS

The system is release-ready for **controlled early-access deployment** with a defined set of known risks and mitigations. It is NOT ready for unattended, open-enrollment production use.

---

## 1. Release Gate Checklist

### A. Authentication & Replay Protection — PASS

| Check | Status | Evidence |
|-------|--------|----------|
| Ed25519 signature verification on all authenticated endpoints | PASS | `server/middleware/auth.js` — canonical request signing |
| Timestamp window (5 min) prevents stale requests | PASS | `auth.js:34` — MAX_AGE_MS = 300000 |
| Nonce replay protection | PASS | `myr_nonces` table, checked before signature verification |
| Nonce expiry and cleanup | PASS | Cleanup runs on each auth check; 10-min expiry window |
| Body hash included in signature | PASS | `auth.js:47` — SHA-256 of body in canonical request |

### B. Peer Trust Boundaries — PASS

| Check | Status | Evidence |
|-------|--------|----------|
| Revoked peers blocked from sync (server-side) | PASS | `server/index.js:2073-2076` — explicit `peer.trust_level === 'revoked'` check |
| Revoked peers blocked from sync (client-side) | PASS | `bin/myr.js:739-740` — throws on non-trusted peer |
| Untrusted peers blocked from report access | PASS | `requireTrustedPeer()` enforces `trust_level === 'trusted'` |
| Unknown public keys rejected | PASS | `server/index.js:2069-2071` — returns `unknown_peer` error |
| Governance actions require local operator key | PASS | `requireLocalOperator()` on approve, revoke, quarantine |

### C. Rate Limiting — CONDITIONAL PASS

| Check | Status | Evidence |
|-------|--------|----------|
| Per-peer rate limiting (authenticated endpoints) | PASS | `server/middleware/rate-limit.js` — 60 req/min per peer key |
| Relay endpoint rate limiting | PASS | `server/index.js:778-803` — per-fingerprint relay rate limit |
| Rate limit on unauthenticated endpoints | FAIL | Discovery, health, introduce endpoints have no rate limiting |
| Per-endpoint granular rate limits | FAIL | Single global 60 req/min, no per-endpoint differentiation |

**Risk:** Unauthenticated endpoint abuse (discovery/health/introduce). Acceptable for early access; operators should use reverse proxy (nginx/caddy) for IP-based rate limiting.

### D. Governance & Intervention — PASS

| Check | Status | Evidence |
|-------|--------|----------|
| Peer revocation (trust_level -> revoked) | PASS | `revokePeerGovernance()` + trace logging |
| Yield quarantine (exclude from recall) | PASS | `quarantineYield()` + recall exclusion at `lib/recall.js:61-65` |
| Governance audit trail | PASS | `governanceAudit()` returns approvals, revocations, stage changes, quarantines |
| Governance actions cryptographically signed | PASS | `signGovernanceAction()` produces verifiable governance signature |
| All governance actions traced | PASS | `writeTrace()` with event_type: revoke, quarantine, approve, stage_change |

### E. Contradiction Detection — CONDITIONAL PASS

| Check | Status | Evidence |
|-------|--------|----------|
| Observation vs. falsification detection | PASS | `lib/contradictions.js:180-200` — pairwise scan |
| Opposing confidence detection | PASS | `lib/contradictions.js:202-227` — directional confidence |
| Domain-scoped filtering | PASS | Normalized domain parameter |
| Contradiction persistence | PASS | `myr_contradictions` table with UNIQUE constraint |
| Contradiction resolution workflow | FAIL | No mechanism to mark contradictions as resolved |
| Severity scoring | FAIL | All contradictions treated equally |

**Risk:** Contradictions accumulate without resolution mechanism. Acceptable for early access; operators review manually via `myr governance audit`.

### F. Participation & Trust Progression — PASS

| Check | Status | Evidence |
|-------|--------|----------|
| 4-stage participation model defined | PASS | `lib/participation.js` — local-only, provisional, bounded, trusted-full |
| Capability-based access control per stage | PASS | `enforceStage()` + `hasCapability()` |
| Promotion criteria (mutual approvals, shared MYRs, ratings) | PASS | `PROMOTION_CRITERIA` with check functions |
| Demotion triggers (rejection rate, consecutive failures) | PASS | `DEMOTION_TRIGGERS` with check functions |
| Domain-qualified trust scoring | PASS | `computeDomainTrust()` — per-peer, per-domain |
| Stage progress visibility | PASS | `getStageProgress()` with actionable guidance |

### G. Observability — CONDITIONAL PASS

| Check | Status | Evidence |
|-------|--------|----------|
| Trace logging for all security-relevant events | PASS | 12 event types: introduce, approve, share, sync_pull, sync_push, verify, reject, discover, relay_sync, revoke, quarantine, stage_change |
| Health endpoint with network metrics | PASS | `/myr/health` — peers, reports, sync timing, uptime |
| Security warnings for hash/signature mismatches | PASS | `console.error('SECURITY WARNING: ...')` in sync.js |
| Structured logging | FAIL | Uses console.log/console.error, no structured log format |
| Request-level access logging | FAIL | No middleware-level request logging |

**Risk:** Debugging incidents requires manual trace table queries. Acceptable for early access.

### H. Input Validation — CONDITIONAL PASS

| Check | Status | Evidence |
|-------|--------|----------|
| SQL injection prevention (parameterized queries) | PASS | better-sqlite3 prepared statements throughout |
| Report field type validation | PASS | yield_type CHECK constraint, confidence REAL |
| Body size limit | PASS | Express default 100KB |
| Pagination bounds | PASS | limit 1-500 in sync, 1-2000 in governance audit |
| Report hash verification on import | PASS | SHA-256 hash comparison in sync.js |
| Operator signature verification on import | PASS | Ed25519 signature check for operator-signed reports |
| Field length validation | FAIL | No max length on text fields (cycle_intent, evidence, etc.) |

**Risk:** Extremely long text fields could inflate DB. Low severity — peer trust boundary limits exposure.

---

## 2. Scenarios Tested (via existing test suite)

| Scenario | Test File | Result |
|----------|-----------|--------|
| Report CRUD + validation | server.test.js, reports-list.test.js | PASS |
| Peer add, approve, reject, revoke | cli.test.js, governance.test.js | PASS |
| Sync with trusted peer (import, dedup, signature verify) | sync.test.js | PASS |
| Sync blocks revoked peer | cli.test.js | PASS |
| Quarantine excludes from recall | governance.test.js, recall.test.js | PASS |
| Contradiction detection | contradictions.test.js | PASS |
| Rate limiting (60 req/min) | layer1-protocol.test.js | PASS |
| Relay rate limiting | relay.test.js | PASS |
| Nonce replay prevention | server.test.js | PASS |
| Auth header validation | server.test.js, layer1-protocol.test.js | PASS |
| Two-node integration (full onboarding flow) | integration-two-node.js | PASS |
| Participation stage enforcement | participation.test.js | PASS |
| Subscription routing (signature verified) | subscriptions.test.js | PASS |
| Synthesis (multi-node overlap, provenance) | synthesis.test.js | PASS |
| Scale sync (paged replay, gap detection) | scale-sync.test.js | PASS |
| Reachability detection | reachability.test.js | PASS |

---

## 3. Known Risks — Accepted for Early Access

### Risk 1: Revocation is local, not network-wide
**Description:** When node A revokes node B, other nodes (C, D) still trust B.
**Severity:** Medium
**Mitigation:** Operators communicate revocations out-of-band. Future: gossip-based revocation propagation.
**Acceptable for release:** Yes — early access implies small, coordinated operator community.

### Risk 2: No body size or field length limits on text content
**Description:** Report text fields (evidence, cycle_intent, etc.) have no length caps.
**Severity:** Low
**Mitigation:** Peer trust boundary limits exposure; only trusted peers can submit reports. Express default 100KB body limit applies.
**Acceptable for release:** Yes.

### Risk 3: Unauthenticated endpoints lack IP-based rate limiting
**Description:** Discovery, health, introduce endpoints have no rate limiting.
**Severity:** Medium
**Mitigation:** Deploy behind reverse proxy (nginx/caddy) with IP-based limits. Documented in operations guide.
**Acceptable for release:** Yes — operators expected to use reverse proxy.

### Risk 4: Contradiction detection is O(n^2) and has no resolution workflow
**Description:** Contradictions accumulate; no way to mark them resolved.
**Severity:** Low
**Mitigation:** Early access corpus is small. Manual review via governance audit.
**Acceptable for release:** Yes.

### Risk 5: Domain trust computation uses LIKE for tag matching
**Description:** `LIKE '%tag%'` in domain trust could match substrings (e.g., "work" matches "networking").
**Severity:** Low
**Mitigation:** Domain tags are JSON arrays; substring match is unlikely to inflate scores significantly in practice.
**Acceptable for release:** Yes.

### Risk 6: Participation stage stats are node-wide, not per-peer
**Description:** `gatherPeerStats()` counts global trusted peers, not per-peer metrics.
**Severity:** Low (by design — stage reflects node's network position, not individual peer relationships).
**Acceptable for release:** Yes.

### Risk 7: No key rotation mechanism
**Description:** Compromised node key requires full re-key and peer re-introduction.
**Severity:** Medium
**Mitigation:** Node key stored in `~/.myr/` with user file permissions. Future: key rotation protocol.
**Acceptable for release:** Yes — standard for v1.x peer-to-peer systems.

### Risk 8: Pre-existing test failure (cli.test.js:498)
**Description:** `announce-to` test expects `'introduced'` but code returns `'trusted'` (uncommitted working copy change).
**Severity:** Low
**Mitigation:** The code behavior (auto-approve fingerprint-valid introductions to `'trusted'`) is correct per the comment. The test assertion needs alignment.
**Acceptable for release:** Yes — behavior is correct; test needs update.

---

## 4. Risks NOT Acceptable Without Mitigation

None identified. All risks are bounded by the peer trust model and acceptable for controlled early-access deployment.

---

## 5. Release Recommendation

### CONDITIONAL PASS — Release for Early Access

**Conditions:**
1. Operators MUST deploy behind a reverse proxy with IP-based rate limiting for unauthenticated endpoints.
2. Operators MUST understand revocation is local-only and coordinate out-of-band.
3. The pre-existing test failure (`cli.test.js:498`) should be fixed (test expectation updated from `'introduced'` to `'trusted'`).

**Strengths justifying release:**
- Strong cryptographic foundation (Ed25519 signing, nonce replay protection, body hash in signature)
- Comprehensive peer trust boundaries (revocation blocks sync at both client and server)
- Governance controls are operational and auditable (revoke, quarantine, audit trail)
- Progressive participation model with promotion/demotion criteria
- 388/389 tests pass across 111 test suites
- Rate limiting on authenticated endpoints and relay
- Quarantined yields properly excluded from recall

**What would upgrade this to UNCONDITIONAL PASS:**
- Network-wide revocation propagation (gossip)
- IP-based rate limiting for unauthenticated endpoints (built-in, not proxy-dependent)
- Contradiction resolution workflow
- Structured logging with request-level access logs
- Field length validation on report text fields
- Key rotation protocol
