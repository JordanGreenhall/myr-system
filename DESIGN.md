# MYR System Design
## Methodological Yield Reports — Starfighter Intelligence Machine

**Status:** Phase 1 Specification  
**Owner:** Polemarch  
**Date:** 2026-02-26  
**Context:** Project 3 in Starfighter development sequence

---

## Purpose

Every meaningful OODA cycle produces Methodological Yield. Currently that yield disappears at session end. The MYR system captures, structures, stores, and retrieves it — turning isolated sessions into a compounding intelligence machine.

Phase 1 operates at a single node (Node 1: Jordan + Polemarch). Phase 2 extends to multi-node signed artifact exchange.

---

## Theoretical Grounding

From `Transition to Abundance, OODA.md`:
- Anti-rivalrous compounding is the dominant growth engine in abundance-era systems
- Methodological yield is the primary anti-rivalrous product of any OODA cycle
- Systems that capture and compound yield outcompete those that produce exhaust only

From `THEORY-CONTENT-CREATION.md`:
- Second-order cybernetics: the system observes and updates its own methodology
- Methodological yield is the primary product; operational outputs are exhaust
- The intelligence-machine is always the real product

From `DARKNET-MINING-PISTIS.md`:
- Methodological Yield Reports are the fifth CLAWDBOT artifact type
- Yield flows anti-rivalrously — sharing costs nothing, receiving adds compounding
- Cross-node yield synthesis is a network joining requirement (Phase 2)

---

## MYR Report Schema

```json
{
  "id": "myr-{YYYY-MM-DD}-{seq}",
  "timestamp": "ISO8601",
  "agent_id": "polemarch",
  "node_id": "node-1",
  "session_ref": "optional session identifier",

  "cycle": {
    "intent": "What was being attempted in this OODA cycle",
    "domain_tags": ["tag1", "tag2"],
    "context": "Brief situation description (1-3 sentences)"
  },

  "yield": {
    "type": "technique | insight | falsification | pattern",
    "question_answered": "The specific question this cycle resolved",
    "evidence": "What supports this answer (observable, not claimed)",
    "what_changes_next": "What will be different in the next cycle because of this",
    "what_was_falsified": "What was proven NOT to work (null if none)",
    "transferable_to": ["other_domain1", "other_domain2"],
    "confidence": 0.85
  },

  "verification": {
    "operator_rating": null,
    "operator_notes": null,
    "verified_at": null
  },

  "network": {
    "signed_by": null,
    "shared_with": [],
    "synthesis_id": null
  }
}
```

**yield.type definitions:**
- `technique` — a method that works, reusable procedure
- `insight` — a conceptual understanding that changes orientation
- `falsification` — something proven NOT to work (invaluable — prevents repeat failure)
- `pattern` — a recurring structure observed across multiple cycles

---

## Phase 1 Components

### 1. myr-store.js
CLI to capture a new MYR.

**Modes:**
- Interactive: guided prompts through each field
- Quick: `--intent "..." --question "..." --evidence "..." --changes "..."` flags
- Stdin: pipe JSON directly for CLAWDBOT automation

**Output:** Writes to SQLite, prints MYR ID on success.

**Usage:**
```bash
node scripts/myr-store.js --interactive
node scripts/myr-store.js --intent "..." --type insight --question "..." --evidence "..." --changes "..." --tags "starfighter,theory"
echo '{"cycle":{"intent":"..."},...}' | node scripts/myr-store.js --stdin
```

### 2. myr-search.js
Retrieve relevant yield when starting a new cycle.

**Search modes:**
- `--query "text"` — FTS5 full-text search across all fields
- `--tags "tag1,tag2"` — filter by domain tags
- `--type technique|insight|falsification|pattern` — filter by yield type
- `--limit N` — max results (default 5)
- `--unverified` — show only unverified reports (for verification queue)

**Output:** Formatted list of matching MYRs with relevance indicators.

**Usage:**
```bash
node scripts/myr-search.js --query "A2A protocol node communication"
node scripts/myr-search.js --tags "starfighter" --type falsification
```

### 3. myr-weekly.js
Generate weekly synthesis for Jordan's review.

**Output:** Markdown report covering:
- Total MYRs this week by type
- Top 3 insights by confidence
- All falsifications (always surfaced — too valuable to bury)
- Patterns emerging across multiple cycles
- Unverified reports requiring Jordan's attention
- Cumulative yield by domain

**Usage:**
```bash
node scripts/myr-weekly.js                    # current week
node scripts/myr-weekly.js --week 2026-02-17  # specific week
node scripts/myr-weekly.js --output report.md # write to file
```

### 4. myr-verify.js
Jordan's interface to review and rate MYR quality.

**Purpose:** Jordan's verification closes the feedback loop. Unverified MYRs are stored but flagged. Verified MYRs are the trusted corpus. Rating affects retrieval weighting.

**Rating scale:** 1-5
- 1: Inaccurate or useless
- 2: Partially captures what happened
- 3: Accurate, adequate
- 4: Accurate, genuinely useful
- 5: Accurate, high-value, highly transferable

**Usage:**
```bash
node scripts/myr-verify.js --queue           # show all unverified, one at a time
node scripts/myr-verify.js --id myr-2026-... --rating 4 --notes "..."
```

---

## Database Schema

SQLite with FTS5 for full-text search.

```sql
CREATE TABLE myr_reports (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  session_ref TEXT,

  -- cycle
  cycle_intent TEXT NOT NULL,
  domain_tags TEXT NOT NULL,  -- JSON array stored as text
  cycle_context TEXT,

  -- yield
  yield_type TEXT NOT NULL CHECK(yield_type IN ('technique','insight','falsification','pattern')),
  question_answered TEXT NOT NULL,
  evidence TEXT NOT NULL,
  what_changes_next TEXT NOT NULL,
  what_was_falsified TEXT,
  transferable_to TEXT,  -- JSON array
  confidence REAL NOT NULL DEFAULT 0.7,

  -- verification
  operator_rating INTEGER,
  operator_notes TEXT,
  verified_at TEXT,

  -- network (Phase 2)
  signed_by TEXT,
  shared_with TEXT,  -- JSON array
  synthesis_id TEXT,

  -- metadata
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE myr_fts USING fts5(
  id,
  cycle_intent,
  cycle_context,
  question_answered,
  evidence,
  what_changes_next,
  what_was_falsified,
  domain_tags,
  content=myr_reports,
  content_rowid=rowid
);

CREATE TABLE myr_syntheses (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  source_myr_ids TEXT NOT NULL,  -- JSON array
  node_ids TEXT NOT NULL,         -- JSON array
  domain_tags TEXT NOT NULL,
  synthesis_text TEXT NOT NULL,
  signed_by TEXT,
  created_at TEXT NOT NULL
);
```

---

## Phase 2 Extensions (design-ready, not yet built)

1. **Ed25519 signing** — each MYR signed by node keypair using trust-infrastructure
2. **myr-export.js** — export signed MYR artifacts as JSON
3. **myr-import.js** — verify signature, merge into local db
4. **myr-synthesize.js** — find overlapping domains across nodes, produce composite
5. **Distribution endpoint** — simple HTTPS server to serve signed artifacts

**Network joining requirement:**
New nodes must present ≥10 MYRs with Jordan-verified average rating ≥3.0 before receiving cross-node yield. This is the pistis-calibrating entry gate — proves the node is running real OODA cycles, not performing them.

---

## CLAWDBOT Integration

At end of significant sessions, Polemarch prompts:
> "This session produced yield. Capture now?"

Then generates a pre-filled MYR from session context and submits via stdin mode.

This makes capture nearly zero-friction.

---

## Testability Criteria

**T1:** MYR captured in <60 seconds via CLI  
**T2:** Search surfaces relevant prior yield when starting new cycle on known domain  
**T3:** Weekly synthesis accurately represents what was actually learned (Jordan recognition test)  
**T4:** Jordan's verification ratings correctly stored and affect retrieval weighting  
**T5:** Falsifications are always surfaced in weekly synthesis regardless of confidence  

---

## File Structure

```
infrastructure/myr-system/
├── DESIGN.md                 ← this file
├── package.json
├── schema/
│   └── myr-report.json       ← JSON schema for validation
├── scripts/
│   ├── myr-store.js
│   ├── myr-search.js
│   ├── myr-weekly.js
│   └── myr-verify.js
├── db/                       ← gitignored, runtime only
│   └── .gitkeep
└── docs/
    ├── PHASE-2-SPEC.md
    └── CLAWDBOT-INTEGRATION.md
```

---

**The intelligence-machine is the product. Build it right.**
