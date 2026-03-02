# MYR Operations Integration Specification v0.2

**Status:** DRAFT  
**Author:** Polemarch  
**Date:** 2026-03-02  
**Review:** Requested  
**Dependencies:** Network Protocol Spec v0.3  
**Changes from v0.1:** Verification graph model (not warning system), lineage tracking, selective sharing

## Problem Statement

MYR reports can flow between nodes automatically (via Network Protocol), but they're useless unless they **actively change operational behavior through verified practice**.

**Current state:** Reports sit in a database. Agents don't consult them. The same mistakes get repeated.

**Wrong model (v0.1):** Import peer reports → surface warnings → prevent failures (passive relay)

**Correct model (v0.2):** Import peer reports → TRY methods → document YOUR evidence → share YOUR verified learnings (verification graph)

## Design Principles

1. **Trust through practice, not relay** - pistis foundation requires verification before use
2. **Value-add graph** - intelligence compounds through verification at each hop
3. **Lineage tracking** - every MYR shows derivation and verification chain
4. **Selective sharing** - share verified learnings, not broadcast
5. **Context-dependent ratings** - Gary's 2/5 means "worked poorly for Gary", not "universally bad"
6. **Verification before influence** - only YOUR verified MYRs change operational behavior
7. **Observable feedback loop** - operators see verification in action

## Scope

This specification covers **how nodes use MYR reports operationally**:
- Verification workflow (try before use)
- When agents query reports (verified vs unverified)
- How reports influence decisions (only after verification)
- Lineage and value-add tracking
- Sharing policy (selective, not broadcast)
- Visibility and feedback to operators

**Out of scope:**
- How reports sync between nodes (covered in Network Protocol Spec)
- Report creation/storage (existing MYR functionality)

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│              MYR Verification Graph              │
└──────────────────────────────────────────────────┘
                       │
      ┌────────────────┼────────────────┐
      │                │                │
      ▼                ▼                ▼
┌──────────┐    ┌─────────────┐   ┌──────────┐
│ Import   │    │  Verify     │   │  Share   │
│ Peer MYRs│───►│  (Try It)   │──►│  Your    │
│          │    │             │   │  MYR     │
└──────────┘    └─────────────┘   └──────────┘
                       │
                       ▼
              ┌────────────────┐
              │ Use Operationally│
              │ (Verified Only) │
              └────────────────┘
                       │
      ┌────────────────┼────────────────┐
      │                │                │
      ▼                ▼                ▼
┌──────────┐    ┌─────────────┐   ┌──────────┐
│ Startup  │    │Pre-Execution│   │  Memory  │
│ Context  │    │  Warnings   │   │  Search  │
└──────────┘    └─────────────┘   └──────────┘
```

## Integration Point 0: Verification Workflow

**THIS COMES FIRST - REQUIRED BEFORE CONSUMPTION**

**When:** After importing peer MYRs, before using them operationally

**Purpose:** Verify peer methods through practice, document YOUR evidence, create derivative MYRs

### Workflow

#### 1. Import Peer MYRs

```bash
# Import Gary's MYR export (signature-verified)
node $MYR_HOME/scripts/myr-import.js \
  --file gary-export-20260302.myr.json \
  --peer-key ~/.myr/keys/gary.public.pem \
  --peer-name gary
```

**What happens:**
- Verify signature against Gary's public key
- Store reports in database with `source_peer='gary'` and `verified_by_me=false`
- Reports are **informational only** until verified

#### 2. Review Verification Candidates

```bash
# Show unverified network MYRs relevant to current work
node $MYR_HOME/scripts/myr-verification-candidates.js \
  --query "HTTP deployment" \
  --limit 5
```

**Output:**
```
=== Verification Candidates (Unverified Network MYRs) ===

[gary] HTTP server deployment (2026-02-20) [rating: 2/5 in his context] [network:unverified]
  Gary's approach: Deploy without rate limiting
  Gary's result: Crashed under moderate load
  Gary's notes: "Should have added rate limiting first"
  
  Verification opportunity: Try this in your context and document YOUR evidence.
  Potential value-add: Your infrastructure differs (Node.js vs Go, different load patterns)
  
[jared] Port binding verification pattern (2026-02-15) [rating: 4/5 in his context] [network:unverified]
  Jared's approach: Test port accessibility before deployment
  Jared's result: Caught firewall issue early
  Jared's notes: "Saved 2 hours of debugging"
  
  Verification opportunity: Try this pattern on next deployment.

(These are verification prompts, not trusted input)
```

#### 3. Try Method in Your Context

**Execute the technique/pattern:**
- Don't just read it - actually do it
- Document what happens in YOUR environment
- Note additions/refinements you make
- Record context (when it works, when it doesn't)

**Example:** Jordan tries Gary's HTTP deployment

```bash
# Jordan's deployment session
cd ~/code/myr-system
node scripts/http-server.js

# Result: Crashes under load (Gary was right)
# Jordan adds rate limiting + graceful degradation
# Re-deploys, sustains 100 req/min
```

#### 4. Store YOUR MYR (Derivative)

```bash
node $MYR_HOME/scripts/myr-store.js \
  --method "HTTP server deployment with resilience" \
  --derived-from "gary-20260220-001" \
  --derived-relationship "verification+refinement" \
  --verification-evidence "Deployed to myr-node. Confirmed Gary's crash without rate limiting. Added graceful degradation on 429 + circuit breaker. Sustained 100 req/min stable." \
  --additions "1) Graceful degradation on rate limit, 2) Circuit breaker pattern, 3) Health endpoint for monitoring" \
  --context "Node.js + Express, production load 50-100 req/min" \
  --rating 4 \
  --notes "Gary's approach works with additions. Core insight valid: rate limiting critical. My additions make it production-ready."
```

**Result:** New MYR created with:
- `derived_from: "gary-20260220-001"`
- `derived_from_node: "gary"`
- `derived_relationship: "verification+refinement"`
- `verification_evidence: <your specific evidence>`
- `verified_by_me: true`

#### 5. Only THEN Use Operationally

After verification:
- MYR is marked `verified_by_me: true`
- Agent integration points (startup, warnings, search) will use it
- Unverified MYRs remain informational only

**Policy:** Network MYRs are **verification prompts**, not trusted input.

### Verification Relationships

When creating derivative MYR, specify relationship:

- **verification** - I tried peer's method, confirmed results (same rating ±1)
- **refinement** - I tried peer's method, added improvements (higher rating)
- **extension** - I tried peer's method, extended to new context
- **contradiction** - I tried peer's method, got different results (explain why)

### Unverified MYR Lifespan

**Policy:** Unverified network MYRs have 90-day expiry.

**Rationale:** If you haven't tried it in 90 days, it's not relevant to your practice. Delete or archive.

**Exception:** Mark as "reference only" to keep without verification (e.g., peer's personal workflow you're not adopting).

## Integration Point 1: Agent Startup Context

**When:** Agent session starts (after memory search, before first user interaction)

**Purpose:** Load verified network intelligence before the agent begins work

**Implementation:**

```bash
# Added to agent AGENTS.md startup sequence (after memory search):
node $MYR_HOME/scripts/myr-verified-context.js \
  --agent <agent_name> \
  --query "<startup_context>" \
  --limit 5
```

**Key difference from v0.1:** Only shows MYRs YOU'VE VERIFIED through practice.

**Example (Polemarch startup):**
```bash
node $MYR_HOME/scripts/myr-verified-context.js \
  --agent polemarch \
  --query "deployment operations systems architecture" \
  --limit 5
```

**Output format:**
```
=== MYR Verified Intelligence ===
Found 2 relevant verified reports:

[jordan←gary] HTTP server deployment (2026-03-01) [your rating: 4/5] [verified]
  Source: gary-20260220-001 (gary rated 2/5 in his context)
  Your verification: "Tried Gary's approach, confirmed crash. Added graceful degradation."
  Your additions: Circuit breaker, health endpoint, better error handling
  Your context: Works well for 50-100 req/min load
  
[jordan←jared] Port accessibility testing (2026-02-28) [your rating: 5/5] [verified]
  Source: jared-20260215-003 (jared rated 4/5 in his context)
  Your verification: "Adopted pattern. Caught firewall issue on first deployment."
  Your additions: Automated port check in deployment script
  Network depth: 2 nodes verified (jared, jordan)

(All reports verified through your practice)
```

**Agent behavior:**
- Read verified context
- Incorporate learnings into working memory
- Proceed with awareness of YOUR verified knowledge

**No unverified relay** - only intelligence you've earned through practice.

## Integration Point 2: Pre-Execution Warnings

**When:** Before executing high-risk operations (deployments, schema changes, config updates)

**Purpose:** Surface YOUR verified warnings from YOUR practice

**Implementation:**

```bash
# Before running deterministic plan or spawning sub-agent:
node $MYR_HOME/scripts/myr-verified-check.js \
  --method "<method_name>" \
  --context "<additional_context>" \
  --threshold 2
```

**Key difference from v0.1:** Only warns based on MYRs YOU'VE VERIFIED.

**Example (before deploying HTTP server):**
```bash
node $MYR_HOME/scripts/myr-verified-check.js \
  --method "deploy HTTP server" \
  --context "MYR node API" \
  --threshold 2
```

**Output format (if YOU'VE tried and documented):**
```
⚠️  Warning: You've tried this before (verified 2026-03-01)

[jordan] HTTP server deployment [your rating: 2/5 before refinements] [verified]
  Your evidence: "Deployed without rate limiting, crashed under load"
  Your solution: "Added graceful degradation + circuit breaker (now 4/5)"
  
Recommendation: Use refined approach (rating 4/5) documented in jordan-20260301-002

Continue with refined approach? (y/n)
```

**Output format (if you HAVEN'T tried it):**
```
📚 Network knowledge available (unverified):

[gary] HTTP server deployment (2026-02-20) [gary rated 2/5] [network:unverified]
  Gary's issue: "Crashed under load without rate limiting"
  
This is a verification opportunity, not a trusted warning.

Try Gary's pattern and document your evidence? (y/n/later)
```

**Behavioral change from v0.1:**
- Warnings ONLY from YOUR verified experience
- Unverified network MYRs = verification prompts, not warnings
- Agent can offer to try peer's method and verify

**Default policy (configurable):**
- **YOUR rating 1 (failed badly):** Strong warning + show your solution
- **YOUR rating 2 (worked poorly):** Warning + show your refinements
- **YOUR rating 3+ (worked acceptably):** Informational note
- **Unverified network MYR:** Verification prompt only

## Integration Point 3: Memory Search Integration

**When:** Agent searches for relevant context during task execution

**Purpose:** Include verified MYRs in search results, distinguish from unverified

**Implementation:**

```bash
node memory-search.js \
  --agent polemarch \
  --include-shared \
  --include-myr-verified \
  --query "HTTP deployment" \
  --limit 10
```

**Optional:** `--include-myr-unverified` shows verification candidates

**Output format:**
```
=== Search Results: "HTTP deployment" ===

[64%] HTTP deployment verified pattern (verified MYR)
Agent: polemarch | Rating: 4/5 | Verified: 2026-03-01
Source: gary-20260220-001 (gary rated 2/5)
Your evidence: Tried Gary's approach, confirmed crash, added circuit breaker...
Network depth: 2 verifications (gary→jordan)

[58%] HTTP deployment failures (local memory)
Agent: polemarch | Category: lesson | Date: 2 days ago
Three attempts to deploy, forgot port forwarding each time...

[52%] Port testing automation (verified MYR)
Agent: polemarch | Rating: 5/5 | Verified: 2026-02-28
Source: jared-20260215-003 (jared rated 4/5)
Your evidence: Adopted pattern, caught firewall issue...
Network depth: 3 verifications (jared→jordan→gary)

--- Unverified (verification candidates) ---

[48%] PostgreSQL connection pooling (unverified network MYR)
Source: gary-20260225-008 (gary rated 3/5)
Gary's approach: Pool size = 2x CPU cores
[Try this and verify? Creates verification opportunity]
```

**Behavioral change:**
- Verified MYRs appear inline with local memories
- Unverified MYRs in separate section (verification prompts)
- Network depth shown (how many nodes verified)
- Source attribution includes lineage

## Integration Point 4: Task Routing Hints

**When:** Mission Control dispatcher or agent spawner selecting which agent/model to use

**Purpose:** Use YOUR verified intelligence to inform routing decisions

**Implementation:**

```bash
# Before spawning sub-agent or selecting model:
node $MYR_HOME/scripts/myr-verified-routing-hints.js \
  --method "<method_name>" \
  --model "<proposed_model>" \
  --agent "<proposed_agent>"
```

**Key difference from v0.1:** Only considers MYRs YOU'VE VERIFIED.

**Example:**
```bash
node $MYR_HOME/scripts/myr-verified-routing-hints.js \
  --method "code review" \
  --model "gemini-2.0-flash"
```

**Output format (if YOU'VE tried and documented):**
```json
{
  "recommendation": "avoid",
  "confidence": "high",
  "evidence": [
    {
      "your_rating": 1,
      "method": "code review large PR",
      "model": "gemini-2.0-flash",
      "your_evidence": "Tried on MYR codebase review. Hallucinated 3 security issues that didn't exist. Missed actual logic error.",
      "verified_at": "2026-02-28T14:00:00Z",
      "source": "jordan (verified, no peer source)"
    }
  ],
  "suggested_alternatives": ["claude-sonnet-4-5", "gpt-4o"],
  "message": "Your verified experience: gemini-2.0-flash failed code review (rating 1/5). Use claude-sonnet-4-5 instead.",
  "network_verification_depth": 1
}
```

**Output format (if you HAVEN'T tried it, but peer has):**
```json
{
  "recommendation": "unknown",
  "confidence": "none",
  "unverified_evidence": [
    {
      "peer": "gary",
      "peer_rating": 2,
      "method": "code review",
      "model": "gemini-2.0-flash",
      "peer_notes": "Missed critical logic error",
      "created_at": "2026-02-28T09:00:00Z"
    }
  ],
  "message": "No verified experience. Gary rated gemini poorly (2/5), but you haven't tried it. Verification opportunity.",
  "verification_prompt": true
}
```

**Behavioral change:**
- Only YOUR verified experience influences routing
- Peer experience shows as verification prompt
- No routing changes based on unverified relay

## Component: Query Engine

### `myr-verification-candidates.js`

**Purpose:** Show unverified network MYRs worth trying

**Usage:**
```bash
node myr-verification-candidates.js --query <text> --limit <n>
```

**Algorithm:**
```
1. Search network MYRs WHERE verified_by_me=false
2. Rank by:
   - Relevance (text similarity to query)
   - Peer rating (lower = more interesting failure to verify)
   - Recency
   - Verification depth (how many other nodes verified)
3. Return top N with verification prompts
```

**Output:** Human-readable list with verification opportunities

### `myr-verified-context.js`

**Purpose:** Provide startup context from verified MYRs only

**Usage:**
```bash
node myr-verified-context.js --agent <name> --query <text> --limit <n>
```

**Algorithm:**
```
1. Search local + verified MYRs (verified_by_me=true)
2. Rank by relevance, recency, your rating
3. Include lineage (derived_from chain)
4. Show verification depth (network consensus)
5. Return top N results
```

**Output:** Human-readable list of YOUR verified intelligence

### `myr-verified-check.js`

**Purpose:** Pre-execution warning check (verified only)

**Usage:**
```bash
node myr-verified-check.js --method <name> --context <text> --threshold <rating>
```

**Algorithm:**
```
1. Search verified MYRs (verified_by_me=true) WHERE method_name MATCH
2. Filter for your_rating <= threshold
3. Include your refinements (if rating improved in derivative)
4. Also search unverified network MYRs (show as verification prompts)
5. Return warnings (verified) + opportunities (unverified)
```

**Exit codes:**
- `0` - No warnings (safe to proceed)
- `1` - Warnings from YOUR verified experience
- `2` - Critical warnings (YOUR rating=1)
- `3` - Verification opportunities available (unverified network MYRs)

**Output:** Warnings (verified) + verification prompts (unverified)

### `myr-verified-routing-hints.js`

**Purpose:** Model/agent selection hints from verified intelligence

**Usage:**
```bash
node myr-verified-routing-hints.js --method <name> [--model <name>] [--agent <name>]
```

**Algorithm:**
```
1. Search verified MYRs (verified_by_me=true) WHERE method+model/agent match
2. Calculate recommendation from YOUR ratings
3. Also check unverified network MYRs (show as verification prompts)
4. Return JSON with recommendation (verified) + opportunities (unverified)
```

**Output:** JSON recommendation from YOUR verified experience

## Lineage Schema

### MYR Report Schema (Extended)

Add to existing MYR schema:

```javascript
{
  // Existing fields...
  "operator_rating": 4,
  "operator_notes": "Works well with additions",
  
  // NEW: Lineage tracking
  "derived_from": "gary-20260220-001",           // Source MYR ID
  "derived_from_node": "gary",                   // Source node operator
  "derived_relationship": "verification+refinement",  // verification|refinement|extension|contradiction
  
  // NEW: Verification evidence
  "verification_evidence": "Tried Gary's approach in my context. Confirmed crash without rate limiting. Added graceful degradation on 429 + circuit breaker. Deployed to myr-node, sustained 100 req/min stable.",
  
  // NEW: Additions/refinements
  "additions": [
    "Graceful degradation on rate limit",
    "Circuit breaker pattern",
    "Health endpoint for monitoring"
  ],
  
  // NEW: Context specificity
  "context_notes": "Node.js + Express, production load 50-100 req/min",
  
  // NEW: Verification metadata
  "verified_by_me": true,                        // Have I tried this?
  "verified_by_nodes": ["gary", "jordan"],       // Who has verified (network consensus)
  "verification_depth": 2,                       // Chain length
  "consensus_rating": 3.0,                       // Avg rating across verifiers
  
  // Existing fields...
  "share_network": true,
  "signature": "sha256:abc123...",
  "operator_signature": "d1e2f3g4..."
}
```

### Lineage Query Examples

**Show derivation chain:**
```bash
node myr-lineage.js --signature jordan-20260301-002

# Output:
gary-20260220-001 (gary rated 2/5)
  └─ jordan-20260301-002 (jordan rated 4/5) ← verification+refinement
     └─ jared-20260303-005 (jared rated 4/5) ← verification
```

**Show verification consensus:**
```bash
node myr-consensus.js --method "HTTP deployment"

# Output:
Method: HTTP deployment
Verified by: 3 nodes (gary, jordan, jared)
Ratings: gary=2/5, jordan=4/5, jared=4/5
Consensus: 3.3/5 (works with additions)
Divergence: Gary's context had issues, Jordan's additions solved them
```

## Sharing Policy

### Selective Sharing (Not Broadcast)

**Share MYRs when:**
1. Peer explicitly requests knowledge on topic
2. Collaborating on shared infrastructure
3. You've verified peer's method and added value

**Do NOT:**
- Export all MYRs to all peers automatically
- Share unverified MYRs (relay without practice)
- Share context-specific patterns (personal workflows, emoji triggers)

**Example:**

Jared documents emoji triggers (🔻💮♻️) for his personal workflow.
- Jordan does NOT share Jared's MYR to Gary (relay)
- If Jordan adopts emoji triggers and they work for HIM:
  - Jordan documents HIS MYR (derived from Jared's)
  - Jordan shares HIS verified experience (value-added)

### Export Commands

**Verified MYRs only:**
```bash
node $MYR_HOME/scripts/myr-export.js \
  --verified-only \
  --output jordan-export-20260302.myr.json
```

**Specific domain (verified):**
```bash
node $MYR_HOME/scripts/myr-export.js \
  --tags "deployment,http" \
  --verified-only \
  --output jordan-deployment-export.myr.json
```

**Relevant to specific peer:**
```bash
node $MYR_HOME/scripts/myr-export.js \
  --peer gary \
  --relevant-to-peer \
  --verified-only \
  --output jordan-to-gary-20260302.myr.json
```

**Relevance filter:** Only export MYRs likely useful to peer's known domains (inferred from past exchanges).

### No Broadcast Mode

**Removed from v0.1:**
```bash
# This command NO LONGER EXISTS:
node myr-export.js --all
```

**Rationale:** Broadcasting all MYRs violates selective sharing principle.

## Visibility and Feedback

### Operator Visibility

**After task completion, show verification impact:**
```
[Polemarch] HTTP server deployed and verified operational.

MYR Intelligence Used:
✓ Your verified pattern (jordan-20260301-002, derived from gary's)
  - Used circuit breaker approach (your rating: 4/5)
  - Avoided crash scenario you documented
  - Additions: graceful degradation, health endpoint
  
Verification Graph:
  gary (2/5) → jordan (4/5, added enhancements) → [this deployment]
  
Network depth: 2 nodes verified this approach
```

**After trying peer's method:**
```
[Polemarch] Tried Gary's HTTP deployment pattern (gary-20260220-001).

Result: Confirmed Gary's crash scenario (as documented)
Your additions: Circuit breaker, graceful degradation
Your rating: 4/5 (works well with additions)

Created: jordan-20260301-002 (verification+refinement)
Ready to share: Your verified + enhanced version

Impact: Converted unverified network MYR → verified value-added MYR
```

### Operational Metrics

**Track and report:**
- Verification rate (% of network MYRs you've tried)
- Value-add rate (% where you added refinements)
- Network depth (avg verification chain length)
- Consensus patterns (where network agrees/diverges)
- Verification prompts surfaced vs acted on

**Example weekly summary:**
```
=== MYR Verification Graph Summary (Week of 2026-03-02) ===

Verification Activity:
  Network MYRs imported: 12
  Verification candidates surfaced: 8
  Methods tried: 5
  Derivative MYRs created: 4
  Value-added rate: 80% (4/5 had refinements)

Network Consensus:
  HTTP deployment: 3 nodes verified (avg 3.3/5)
    - Consensus: Works with rate limiting
    - Gary's 2/5 → Jordan's additions → 4/5
  
  Port testing: 2 nodes verified (avg 4.5/5)
    - High consensus: Pattern works well
  
  Emoji triggers: 1 node (Jared's workflow)
    - Not verified by others (context-specific)

Verification Depth:
  Avg chain length: 2.1 hops
  Longest chain: gary → jordan → jared (HTTP deployment)
  
Coverage Gaps (no verified MYRs):
  - PostgreSQL connection pooling (gary's unverified)
  - Kubernetes deployment (no network data)
```

## Configuration

### Per-Node Policy

`myr-config.json`:
```javascript
{
  // ... network config from Protocol Spec
  
  "operations": {
    "verification_required": true,        // Require verification before operational use
    "verification_prompt_threshold": 0.7, // Show verification prompts for relevant MYRs (0-1)
    "unverified_expiry_days": 90,         // Auto-expire unverified network MYRs
    
    "startup_context_enabled": true,
    "startup_context_limit": 5,
    "startup_context_verified_only": true,  // Only show verified MYRs at startup
    
    "pre_exec_warnings_enabled": true,
    "pre_exec_warning_threshold": 2,        // Warn for YOUR ratings <= 2
    "pre_exec_verified_only": true,         // Only warn based on verified MYRs
    
    "memory_search_include_verified": true,
    "memory_search_include_unverified": false,  // Optional: show verification candidates
    
    "routing_hints_enabled": true,
    "routing_hints_verified_only": true,
    
    "sharing_mode": "selective",            // selective | on-request | never
    "share_verified_only": true,            // Never share unverified MYRs
    
    "feedback_visibility": "always"         // always | summary | never
  }
}
```

### Per-Agent Override

Agents can override policy in their AGENTS.md:
```bash
# Polemarch: stricter verification requirements
export MYR_VERIFICATION_REQUIRED=true
export MYR_PRE_EXEC_THRESHOLD=3  # Warn for ratings <=3
```

## Security Considerations

### Trust Boundaries

Verified MYRs influence decisions but **never execute code automatically**.

**Safe operations:**
- Surface verified warnings to operator
- Suggest alternative models/agents
- Include in search results
- Track verification metrics

**Unsafe operations (NEVER):**
- Auto-execute remediation from any MYR (verified or not)
- Trust code in MYR metadata
- Allow MYRs to modify local config

### Verification Requirements

All network MYRs MUST have:
- Valid `operator_signature` (verified against peer's public key)
- `source_peer` attribution
- Marked as `[network:unverified]` until YOU verify

Operators MUST be able to distinguish:
- Local MYRs (YOUR direct experience)
- Verified network MYRs (YOU tried peer's method)
- Unverified network MYRs (verification prompts only)

### Lineage Integrity

When creating derivative MYR:
- `derived_from` MUST reference valid source MYR signature
- `verification_evidence` MUST be YOUR specific evidence
- Cannot claim verification without actually trying

**Enforcement:** Manual (operator responsibility), auditable (lineage graph shows verification chain)

## Migration Path

### Phase 1: Verification Layer (v0.2.0)
- Extend MYR schema with lineage fields
- Implement `myr-verification-candidates.js`
- Implement `myr-import.js` with `verified_by_me=false` default
- Implement `myr-store.js` with derivation support
- Database migration for lineage tracking

### Phase 2: Verified Query Engine (v0.3.0)
- Implement `myr-verified-context.js`
- Implement `myr-verified-check.js`
- Implement `myr-verified-routing-hints.js`
- Implement `myr-lineage.js` and `myr-consensus.js`

### Phase 3: Agent Integration (v0.4.0)
- Update agent AGENTS.md templates with verified context
- Add verification prompts to workflow
- Extend `memory-search.js` with verified/unverified distinction
- Verification feedback loop

### Phase 4: Sharing Policy (v0.5.0)
- Implement selective export (`--verified-only`, `--relevant-to-peer`)
- Remove broadcast export
- Verification depth metrics
- Weekly summary reports

## Success Criteria

After implementation, operators should observe:

1. **Verification workflow in action:**
   ```
   [Polemarch] Found Gary's HTTP deployment pattern (unverified).
   Try it and document your evidence? (creates verification opportunity)
   
   [User: Yes]
   
   [Polemarch] Deploying... confirmed Gary's crash scenario.
   Adding circuit breaker... testing... works at 4/5 with additions.
   Created jordan-20260301-002 (verification+refinement from gary's).
   Ready to share verified + enhanced version.
   ```

2. **Verified intelligence in memory search:**
   ```
   [58%] HTTP deployment verified pattern (verified MYR)
   Your rating: 4/5 | Source: gary (2/5) | Network depth: 2 nodes
   ```

3. **Verification-based warnings:**
   ```
   ⚠️  You've tried this before (verified 2026-03-01, rating 2/5)
   Your solution: Use refined approach (jordan-20260301-002, rating 4/5)
   ```

4. **Lineage visibility:**
   ```
   Verification chain:
   gary (2/5) → jordan (4/5, added enhancements) → jared (4/5, confirmed)
   Consensus: 3.7/5 across 3 nodes
   ```

5. **Selective sharing:**
   ```
   Exported 4 verified MYRs to Gary (deployment domain, value-added)
   Not shared: 8 local MYRs (not relevant to Gary's domains)
   Not shared: 3 unverified network MYRs (relay prohibited)
   ```

**Key outcome:** MYR network is a verification graph where intelligence compounds through practice. Trust through verification, value added at each hop, pistis-native intelligence.

---

## Appendix A: Example Verification Workflow

### Scenario: Jordan Imports Gary's HTTP Deployment MYR

**1. Import Gary's export:**
```bash
node $MYR_HOME/scripts/myr-import.js \
  --file gary-export-20260302.myr.json \
  --peer-key ~/.myr/keys/gary.public.pem \
  --peer-name gary

# Output:
Imported 5 MYRs from gary
  - gary-20260220-001: HTTP server deployment (2/5)
  - gary-20260225-008: PostgreSQL pooling (3/5)
  - gary-20260228-012: Config management (4/5)
  
All marked verified_by_me=false (verification candidates)
```

**2. Review candidates:**
```bash
node $MYR_HOME/scripts/myr-verification-candidates.js \
  --query "HTTP deployment" \
  --limit 3

# Output:
[gary] HTTP server deployment (2026-02-20) [gary rated 2/5] [network:unverified]
  Gary's approach: Deploy without rate limiting
  Gary's result: "Crashed under moderate load"
  Gary's notes: "Should have added rate limiting first"
  
  Verification opportunity: Your infrastructure differs (Node.js vs Gary's Go)
  Potential value-add: Your deployment patterns, observability
```

**3. Jordan tries it:**
```bash
# Jordan deploys HTTP server (no rate limiting, following Gary's approach)
cd ~/code/myr-system
node scripts/http-server.js &

# Load test
ab -n 1000 -c 50 http://localhost:3719/myr/reports

# Result: Crashes after 200 requests (Gary was right)
```

**4. Jordan adds refinements:**
```bash
# Jordan adds rate limiting + circuit breaker
# Re-deploys, re-tests
# Sustains 100 req/min stable
```

**5. Jordan documents HIS MYR:**
```bash
node $MYR_HOME/scripts/myr-store.js \
  --method "HTTP server deployment with resilience" \
  --derived-from "gary-20260220-001" \
  --derived-relationship "verification+refinement" \
  --verification-evidence "Deployed to myr-node without rate limiting (Gary's approach). Confirmed crash at ~200 concurrent requests. Added rate limiting (60/min) + circuit breaker + graceful 429 response. Re-tested: sustained 100 req/min stable for 30 min." \
  --additions "1) Rate limiting middleware (60/min), 2) Circuit breaker on DB queries, 3) Graceful degradation (return cached data on 429), 4) Health endpoint for monitoring" \
  --context "Node.js 25.x + Express 4.x, production load 50-100 req/min, SQLite backend" \
  --rating 4 \
  --notes "Gary's core insight valid: rate limiting critical. My additions make it production-ready. Circuit breaker prevents cascading DB failures."

# Output:
Created: jordan-20260301-002
  Derived from: gary-20260220-001 (verification+refinement)
  Your rating: 4/5 (vs Gary's 2/5)
  Verified: true
  Additions: 4 enhancements documented
  
Lineage:
  gary-20260220-001 (gary, 2/5)
  └─ jordan-20260301-002 (jordan, 4/5) ← verification+refinement
```

**6. Jordan uses it operationally:**

Next deployment:
```bash
# Pre-execution check now finds VERIFIED MYR
node $MYR_HOME/scripts/myr-verified-check.js \
  --method "deploy HTTP server" \
  --threshold 3

# Output:
✓ Verified pattern available (jordan-20260301-002, rating 4/5)
  Your evidence: "Deployed with rate limiting + circuit breaker, works well"
  Derived from: gary-20260220-001 (you verified Gary's approach)
  
Recommendation: Use verified pattern (includes rate limiting, circuit breaker)
```

**7. Jordan shares HIS verified+enhanced MYR:**
```bash
node $MYR_HOME/scripts/myr-export.js \
  --tags "deployment,http" \
  --verified-only \
  --output jordan-deployment-export.myr.json

# Gary imports Jordan's export later
# Sees: jordan-20260301-002 (derived from gary-20260220-001)
# Gary benefits from Jordan's additions
# Gary can verify Jordan's approach in HIS context
```

**Result:** 
- Gary's 2/5 experience shared
- Jordan verified + added value → 4/5
- Jordan shares HIS verified + enhanced version
- Network intelligence compounds through verification
- No passive relay: each hop adds verification evidence

---

## Appendix B: Changes from v0.1

**Fundamental model change:**
- v0.1: Warning system (consume → warn → prevent failures)
- v0.2: Verification graph (import → try → document → share)

**New Integration Point 0:** Verification Workflow (comes first)

**Schema additions:**
- `derived_from` - lineage tracking
- `verification_evidence` - YOUR specific evidence
- `verified_by_me` - have YOU tried this?
- `verification_depth` - network consensus depth
- `additions` - what you added beyond source

**Query engine changes:**
- `myr-context.js` → `myr-verified-context.js` (verified only)
- `myr-check.js` → `myr-verified-check.js` (verified only)
- New: `myr-verification-candidates.js` (unverified prompts)
- New: `myr-lineage.js`, `myr-consensus.js`

**Sharing policy:**
- Removed: `--all` export (no broadcast)
- Added: `--verified-only`, `--relevant-to-peer`
- Principle: Selective, value-added sharing

**Rating interpretation:**
- v0.1: Universal quality score
- v0.2: Context-dependent (Gary's 2/5 means "for Gary", not "universally bad")

**Behavioral changes:**
- Warnings only from YOUR verified experience
- Unverified MYRs = verification prompts, not warnings
- Routing hints only from YOUR verified data
- Memory search distinguishes verified vs unverified

---

**Next Steps:** Review by Jordan, Gary, Jared (especially sharing policy and verification workflow). Revise based on feedback, then implement Phase 1.
