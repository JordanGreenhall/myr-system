# MYR Operations Integration Specification v0.1

**Status:** DRAFT  
**Author:** Polemarch  
**Date:** 2026-03-02  
**Review:** Requested  
**Dependencies:** Network Protocol Spec v0.2

## Problem Statement

MYR reports can flow between nodes automatically (via Network Protocol), but they're useless unless they **actively change operational behavior**.

**Current state:** Reports sit in a database. Agents don't consult them. The same mistakes get repeated.

**Required state:** Reports inform agent decisions at runtime. Network intelligence prevents repeat failures and improves task routing.

## Design Principles

1. **Agents consult network intelligence automatically** - not manually remembered
2. **Warnings surface proactively** - before execution, not after failure
3. **Observable feedback loop** - operators see when reports influence decisions
4. **Fail-safe defaults** - unverified/low-rated reports warn, don't block
5. **Human judgment wins** - operators can override any report-based decision

## Scope

This specification covers **how nodes use MYR reports operationally**:
- When agents query reports
- How reports influence decisions
- What behavioral changes result
- Visibility and feedback to operators

**Out of scope:**
- How reports sync between nodes (covered in Network Protocol Spec)
- Report creation/storage (existing MYR functionality)

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│                 Agent Lifecycle                  │
└──────────────────────────────────────────────────┘
                       │
      ┌────────────────┼────────────────┐
      │                │                │
      ▼                ▼                ▼
┌──────────┐    ┌─────────────┐   ┌──────────┐
│ Startup  │    │Pre-Execution│   │  Memory  │
│ Context  │    │  Warnings   │   │  Search  │
└──────────┘    └─────────────┘   └──────────┘
      │                │                │
      └────────────────┼────────────────┘
                       │
                       ▼
              ┌────────────────┐
              │  Query Engine  │
              │ (myr-query.js) │
              └────────────────┘
                       │
                       ▼
              ┌────────────────┐
              │   MYR Reports  │
              │   (SQLite DB)  │
              │ • Local        │
              │ • Network      │
              └────────────────┘
```

## Integration Point 1: Agent Startup Context

**When:** Agent session starts (after memory search, before first user interaction)

**Purpose:** Load relevant network intelligence before the agent begins work

**Implementation:**

```bash
# Added to agent AGENTS.md startup sequence (after memory search):
node $MYR_HOME/scripts/myr-context.js \
  --agent <agent_name> \
  --query "<startup_context>" \
  --limit 5
```

**Example (Polemarch startup):**
```bash
node $MYR_HOME/scripts/myr-context.js \
  --agent polemarch \
  --query "deployment operations systems architecture" \
  --limit 5
```

**Output format:**
```
=== MYR Network Intelligence ===
Found 3 relevant reports:

[gary] myr-system node handoff (2026-03-01) [rating: 2/5] [network]
  Decision: Manual key exchange is fragile
  Notes: Lost Jared's public key twice during email exchange
  
[jordan] OpenClaw config changes (2026-02-28) [rating: 3/5] [local]
  Decision: Test config changes in isolation first
  Notes: config.patch wiped entire agents.list - broke main session
  
[jared] SQLite schema migrations (2026-02-25) [rating: 4/5] [network]
  Decision: Use transactions for schema changes
  Notes: Rollback on failure is critical for production databases

(Run 'myr show <signature>' for full report)
```

**Agent behavior:**
- Read context output
- Incorporate relevant warnings into working memory
- Proceed with awareness of network learnings

**No automatic blocking** - this is informational context, not enforcement.

## Integration Point 2: Pre-Execution Warnings

**When:** Before executing high-risk operations (deployments, schema changes, config updates, service restarts)

**Purpose:** Surface relevant warnings from network intelligence before potentially repeating a known failure

**Implementation:**

```bash
# Before running deterministic plan or spawning sub-agent:
node $MYR_HOME/scripts/myr-check.js \
  --method "<method_name>" \
  --context "<additional_context>" \
  --threshold 2
```

**Example (before deploying HTTP server):**
```bash
node $MYR_HOME/scripts/myr-check.js \
  --method "deploy HTTP server" \
  --context "MYR node API" \
  --threshold 2
```

**Output format:**
```
⚠️  Warning: Network intelligence found 2 reports rated ≤2 for similar tasks:

[gary] HTTP server deployment (2026-02-20) [rating: 2/5] [network]
  Issue: Server crashed under load without rate limiting
  Recommendation: Add rate limiting before production deployment
  
[jared] Port binding failures (2026-02-15) [rating: 1/5] [network]
  Issue: Forgot to check firewall rules - port 3719 blocked
  Recommendation: Test port accessibility before claiming success

Continue? (y/n/details)
```

**Behavioral options:**

1. **Agent surfaces warning in response:**
   ```
   [Polemarch] Before deploying, I found network warnings:
   - Gary's HTTP server crashed without rate limiting (2/5)
   - Jared's port binding failed due to firewall (1/5)
   
   Should I add rate limiting to the spec first, or proceed as-is?
   ```

2. **Agent auto-adjusts plan:**
   ```
   [Polemarch] Adding rate limiting to deployment plan based on Gary's 
   report (HTTP server crash, rating 2/5). Proceeding with modified approach.
   ```

3. **Agent blocks and escalates:**
   ```
   [Polemarch] Network intelligence shows 2 failures (ratings ≤2) for this 
   method. Blocking deployment. Review reports and confirm intent.
   ```

**Default policy (configurable):**
- **Rating 1 (failed badly):** Auto-escalate to operator with warning
- **Rating 2 (worked poorly):** Surface warning, suggest modifications
- **Rating 3 (worked acceptably):** Informational note only
- **Rating 4-5:** No warning (prior success)

## Integration Point 3: Memory Search Integration

**When:** Agent searches for relevant context during task execution

**Purpose:** Include network reports in search results alongside local memories

**Implementation:**

Extend existing `memory-search.js` with `--include-network` flag:

```bash
node memory-search.js \
  --agent polemarch \
  --include-shared \
  --include-network \
  --query "HTTP deployment" \
  --limit 10
```

**Output format:**
```
=== Search Results: "HTTP deployment" ===

[58%] HTTP deployment failures (local)
Agent: polemarch | Category: lesson | Date: 2 days ago
Three attempts to deploy, forgot port forwarding each time...

[56%] HTTP server rate limiting (network:gary)
Operator: gary | Rating: 2/5 | Date: 5 days ago
Server crashed under moderate load. No rate limiting configured...

[54%] Port accessibility testing (network:jared)
Operator: jared | Rating: 4/5 | Date: 1 week ago
Always test port binding BEFORE deploying service...
```

**Behavioral change:**
- Agents naturally discover network learnings during research
- No separate "check network intelligence" step required
- Network reports appear inline with local memories

**Source attribution:**
- `[local]` - from this node's own experience
- `[network:gary]` - from Gary's node via network sync
- `[shared]` - from shared memory within this node

## Integration Point 4: Task Routing Hints

**When:** Mission Control dispatcher or agent spawner selecting which agent/model to use

**Purpose:** Use network intelligence to inform routing decisions (avoid models/agents that struggled with similar tasks)

**Implementation:**

```bash
# Before spawning sub-agent or selecting model:
node $MYR_HOME/scripts/myr-routing-hints.js \
  --method "<method_name>" \
  --model "<proposed_model>" \
  --agent "<proposed_agent>"
```

**Example:**
```bash
node $MYR_HOME/scripts/myr-routing-hints.js \
  --method "code review" \
  --model "gemini-2.0-flash"
```

**Output format:**
```json
{
  "recommendation": "avoid",
  "confidence": "high",
  "evidence": [
    {
      "operator": "gary",
      "rating": 1,
      "method": "code review large PR",
      "model": "gemini-2.0-flash",
      "notes": "Hallucinated entire security issues that didn't exist",
      "created_at": "2026-02-28T14:00:00Z"
    },
    {
      "operator": "jordan",
      "rating": 2,
      "method": "code review refactor",
      "model": "gemini-2.0-flash",
      "notes": "Missed critical logic error, approved broken code",
      "created_at": "2026-03-01T09:00:00Z"
    }
  ],
  "suggested_alternatives": ["claude-sonnet-4-5", "gpt-4o"],
  "message": "Network intelligence: 2 reports (ratings 1-2) suggest gemini-2.0-flash struggles with code review. Consider claude-sonnet-4-5 instead."
}
```

**Behavioral change:**
- Mission Control dispatcher sees hint before spawning
- Surfaces alternative if network shows poor results with proposed model
- Operator can override (hint, not enforcement)

**Policy (configurable):**
- **3+ reports rated ≤2:** "avoid" recommendation
- **2+ reports rated ≤2:** "caution" recommendation
- **1 report rated 1:** "warning" recommendation
- **All reports rated ≥3:** "proceed" recommendation

## Component: Query Engine

### `myr-context.js`

**Purpose:** Provide startup context for agents

**Usage:**
```bash
node myr-context.js --agent <name> --query <text> --limit <n>
```

**Algorithm:**
```
1. Search local MYR reports WHERE method_name MATCH query
2. Search network MYR reports (source_peer IS NOT NULL) WHERE method_name MATCH query
3. Rank by:
   - Relevance (text similarity to query)
   - Recency (created_at DESC)
   - Operator rating (lower ratings = more important warnings)
4. Return top N results
5. Format for agent consumption (human-readable)
```

**Output:** Human-readable list of relevant reports (see Integration Point 1)

### `myr-check.js`

**Purpose:** Pre-execution warning check

**Usage:**
```bash
node myr-check.js --method <name> --context <text> --threshold <rating>
```

**Algorithm:**
```
1. Search MYR reports WHERE method_name MATCH method OR method_context MATCH context
2. Filter for operator_rating <= threshold
3. Rank by rating ASC (worst first), recency DESC
4. Return warnings if any found
5. Format with clear warning indicators
```

**Exit codes:**
- `0` - No warnings (safe to proceed)
- `1` - Warnings found (review recommended)
- `2` - Critical warnings (rating=1, strongly recommend review)

**Output:** Warning list with recommendations (see Integration Point 2)

### `myr-routing-hints.js`

**Purpose:** Model/agent selection hints based on network intelligence

**Usage:**
```bash
node myr-routing-hints.js --method <name> [--model <name>] [--agent <name>]
```

**Algorithm:**
```
1. Search MYR reports WHERE:
   - method_name MATCH method
   - AND (metadata->model = model OR metadata->agent = agent)
2. Group by rating
3. Calculate recommendation:
   - Count reports at each rating level
   - Apply policy thresholds
   - Suggest alternatives if available
4. Return JSON with recommendation + evidence
```

**Output:** JSON recommendation (see Integration Point 4)

## Visibility and Feedback

### Operator Visibility

**After task completion, show impact:**
```
[Polemarch] Deployment complete. 

MYR Intelligence Used:
✓ Avoided port binding issue (Jared's report, rating 1/5)
✓ Added rate limiting (Gary's report, rating 2/5)
✓ Used claude-sonnet-4-5 instead of gemini (network recommendation)

Impact: Prevented 2 likely failures based on network learnings.
```

**Benefits:**
- Operator sees reports are actively used
- Builds trust in network intelligence
- Reinforces value of sharing reports

### Operational Metrics

**Track and report:**
- How many tasks consulted network intelligence
- How many warnings surfaced
- How many failures prevented (estimated)
- Which peers' reports were most valuable
- Report coverage (% of tasks with relevant intelligence)

**Example weekly summary:**
```
=== MYR Network Intelligence Summary (Week of 2026-03-02) ===

Tasks executed: 47
Network intelligence consulted: 23 (49%)
Warnings surfaced: 8
Failures prevented (estimated): 3

Most valuable peer reports:
  1. gary: 5 reports prevented issues
  2. jared: 3 reports improved approaches
  
Coverage gaps (tasks with no relevant reports):
  - PostgreSQL schema migrations
  - Kubernetes deployment
  - OAuth integration
```

## Configuration

### Per-Node Policy

`myr-config.json`:
```javascript
{
  // ... network config from Protocol Spec
  
  "operations": {
    "startup_context_enabled": true,
    "startup_context_limit": 5,
    
    "pre_exec_warnings_enabled": true,
    "pre_exec_warning_threshold": 2,  // Warn for ratings <= 2
    "pre_exec_block_threshold": 1,     // Block for ratings <= 1 (requires confirmation)
    
    "memory_search_network": true,     // Include network reports in memory search
    
    "routing_hints_enabled": true,
    "routing_hints_min_reports": 2,    // Need 2+ reports for "avoid" recommendation
    
    "feedback_visibility": "always"    // always | summary | never
  }
}
```

### Per-Agent Override

Agents can override policy in their AGENTS.md:
```bash
# Polemarch: stricter warnings for deployments
export MYR_PRE_EXEC_THRESHOLD=3  # Warn for ratings <=3
```

## Security Considerations

### Trust Boundaries

Network reports influence decisions but **never execute code automatically**.

**Safe operations:**
- Surface warnings to operator
- Suggest alternative models/agents
- Include in search results
- Track metrics

**Unsafe operations (NEVER):**
- Auto-execute remediation from network report
- Trust unverified code in report metadata
- Allow network reports to modify local config

### Verification

All network reports MUST have:
- Valid `operator_signature` (verified against peer's public key)
- `source_peer` attribution
- Marked as `[network]` in all output

Operators MUST be able to distinguish local vs network intelligence.

## Migration Path

### Phase 1: Query Engine (v0.1.0)
- Implement `myr-context.js`
- Implement `myr-check.js`
- Implement `myr-routing-hints.js`
- Database queries for local + network reports

### Phase 2: Agent Integration (v0.2.0)
- Update agent AGENTS.md templates with startup context
- Add pre-execution warning hooks to deterministic execution policy
- Extend `memory-search.js` with `--include-network`

### Phase 3: Feedback Loop (v0.3.0)
- Post-task impact reporting
- Operational metrics tracking
- Weekly summary reports

### Phase 4: Routing Integration (v0.4.0)
- Mission Control dispatcher uses routing hints
- Gateway model selection consults network intelligence
- Sub-agent spawning considers network recommendations

## Success Criteria

After implementation, operators should observe:

1. **Agents proactively warn before repeating known failures**
   ```
   [Polemarch] Gary's report warns this approach failed (rating 1/5). 
   Should I try a different method first?
   ```

2. **Network intelligence appears in memory search naturally**
   ```
   [54%] Port binding failures (network:jared)
   Operator: jared | Rating: 1/5 | Date: 1 week ago
   ```

3. **Visible feedback on report usage**
   ```
   Impact: Prevented 2 likely failures based on network learnings.
   ```

4. **Routing decisions informed by network**
   ```
   [Samuel] Routing to claude-sonnet-4-5 instead of gemini 
   (network intelligence: 3 reports rated ≤2 for gemini on this task type)
   ```

**Key outcome:** Network intelligence actively prevents repeat failures and improves operational quality, with clear visibility to operators.

---

## Appendix A: Example Workflow

### Scenario: Deploying MYR Node HTTP Server

**1. Agent startup (Polemarch session begins):**
```bash
node $MYR_HOME/scripts/myr-context.js \
  --agent polemarch \
  --query "deployment HTTP server operations" \
  --limit 5

# Output:
=== MYR Network Intelligence ===
Found 2 relevant reports:

[gary] HTTP server deployment (2026-02-20) [rating: 2/5] [network]
  Decision: Add rate limiting before production
  Notes: Server crashed under moderate load
  
[jared] Port binding failures (2026-02-15) [rating: 1/5] [network]
  Decision: Test port accessibility first
  Notes: Firewall blocked port 3719
```

**2. Agent reads task: "Deploy MYR node HTTP server"**

**3. Pre-execution check:**
```bash
node $MYR_HOME/scripts/myr-check.js \
  --method "deploy HTTP server" \
  --context "MYR node API port 3719" \
  --threshold 2

# Output:
⚠️  Warning: Network intelligence found 2 reports rated ≤2:

[gary] HTTP server deployment [rating: 2/5] [network]
  Issue: Server crashed under load without rate limiting
  
[jared] Port binding failures [rating: 1/5] [network]
  Issue: Port 3719 blocked by firewall

Exit code: 2 (critical warnings)
```

**4. Agent surfaces to operator:**
```
[Polemarch] Before deploying the HTTP server, I found critical network warnings:

⚠️  Jared's deployment failed (rating 1/5): firewall blocked port 3719
⚠️  Gary's deployment crashed (rating 2/5): no rate limiting under load

Recommended changes:
1. Test port 3719 accessibility BEFORE deploying
2. Add rate limiting (60 req/min) to server config

Proceed with these modifications, or deploy as originally planned?
```

**5. Operator approves modifications**

**6. Agent executes deployment (with modifications)**

**7. Post-completion feedback:**
```
[Polemarch] HTTP server deployed and verified operational.

MYR Intelligence Used:
✓ Tested port 3719 accessibility (prevented Jared's failure, rating 1/5)
✓ Added rate limiting 60/min (prevented Gary's crash, rating 2/5)

Impact: Prevented 2 likely failures based on network learnings.
```

**Result:** Deployment succeeds on first attempt, avoiding two known failure modes from the network.

---

**Next Steps:** Review by Jordan, Gary, Jared. Revise based on feedback, then implement Phase 1 (Query Engine).
