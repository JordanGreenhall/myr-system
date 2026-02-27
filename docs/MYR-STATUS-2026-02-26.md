# MYR System Status Report — 2026-02-26

## What Was Built Today

### Phase 2 (Cursor, previous session)
Cross-node infrastructure: config-driven paths, Ed25519 signing, export/import/synthesize CLIs.

**Commit:** `e13e1b5` — `[starfighter/polemarch] myr-system Phase 2: config-driven, Ed25519 signing, export/import/synthesize`

### Auto-Draft Integration (Polemarch, this session)
MYR capture piggybacked on the existing memory-store habit. No new agent behavior required.

**Commit:** `5ccb219` — `[starfighter/polemarch] MYR auto-draft: piggyback on memory-store, extract via Ollama, surface in memory-search`

---

## Architecture

```
Agent calls memory-store.js (unchanged behavior)
  → Memory written to PostgreSQL (unchanged)
  → If category = lesson|decision:
      spawn('node', ['myr-draft.js', ...args], { detached, stdio: 'ignore' }).unref()
      (fire-and-forget, zero blast radius on memory-store)

myr-draft.js (async child process):
  → Calls Ollama llama3.1:8b locally (JSON mode, temp 0.1)
  → Extracts: intent, yield_type, question_answered, evidence, what_changes_next, domain_tags
  → NOT NULL fields get '[AUTO-DRAFT]' placeholder if LLM returns null
  → yield_type defaults to 'insight' if invalid
  → Writes to MYR SQLite DB with auto_draft=1, source_memory_id=<id>
  → Silent exit on any failure (Ollama down, parse error, DB error)

Agent calls memory-search.js (unchanged behavior)
  → Queries PostgreSQL (pgvector semantic search) — unchanged
  → ALSO queries MYR SQLite DB (FTS5 keyword search) — NEW
  → Results tagged [MYR] (verified) or [MYR-DRAFT] (auto-extracted)
```

## Files Changed

### memory-system (projects/core/infrastructure/memory-system/scripts/)
- `memory-store.js` — +12 lines: spawn hook for lesson/decision categories
- `memory-search.js` — +45 lines: MYR FTS query, result formatting

### myr-system (projects/starfighter/infrastructure/myr-system/scripts/)
- `myr-draft.js` — NEW (120 lines): Ollama extraction, draft insertion
- `db.js` — +2 lines: `auto_draft` and `source_memory_id` columns in migration
- `myr-verify.js` — +2 lines: `[AUTO-DRAFT]` label in verification queue
- `myr-weekly.js` — +10 lines: separate auto-draft count in weekly digest

## What Works (verified)

1. ✅ `memory-store --category lesson` triggers myr-draft.js spawn
2. ✅ myr-draft.js calls Ollama, extracts structured fields, writes to MYR DB
3. ✅ `memory-search --query "X"` returns both memory results and MYR results
4. ✅ MYR results tagged `[MYR-DRAFT]` with correct metadata
5. ✅ Auto-drafts have `auto_draft=1` and `source_memory_id` linking back to memory
6. ✅ Placeholder strategy works for null required fields
7. ✅ myr-verify shows `[AUTO-DRAFT]` label
8. ✅ myr-export still only exports jordan_rating ≥ 3 (drafts never export)

## What Needs Review

1. **Path coupling** — memory-store.js and memory-search.js use relative paths to myr-system (`../../../../starfighter/infrastructure/myr-system/scripts/`). If either project moves, these break. Consider env var or config for the myr-system root.

2. **FTS vs semantic search** — memory results are pgvector cosine similarity (semantic). MYR results are FTS5 keyword match. Different paradigms, different ranking. Results are mixed in output without explaining the difference.

3. **Ollama dependency** — if Ollama isn't running, drafts silently don't get created. No alerting, no retry. Acceptable for now but invisible failure mode.

4. **LLM extraction quality** — tested with 2 memories. `question_answered` fell back to `[AUTO-DRAFT]` placeholder on one. Need more data to assess extraction fidelity at scale.

5. **MYR skill** — installed at `~/.openclaw/skills/myr/` but not yet visible in `openclaw skills` list. Needs gateway restart to pick up. Skill doc still describes manual CLI usage; should be updated to reflect the auto-draft architecture.

6. **No CLAWDBOT-INTEGRATION.md** — referenced in DESIGN.md, never written. The auto-draft hook replaces the original concept (end-of-session prompt) but the doc gap remains.

## Open Architecture Questions (flagged by Jordan)

**Node-to-node comms is not built.** The Phase 2 export/import scripts exist but there is no transport, discovery, or protocol layer. Jordan flagged this as fundamental: "Comms between Nodes is almost as fundamental as the Nodes themselves." The MYR system was designed node-first, network-second — that ordering needs revisiting before building more transport-level code. See memory #545.

## DB State

- 8 total MYR records (6 manual from Phase 1/2 testing, 2 auto-drafts)
- 2 auto-drafts with `source_memory_id` links
- Node ID: n1
- ID format: `n1-YYYYMMDD-SEQ`

## File Locations

```
MYR system:     projects/starfighter/infrastructure/myr-system/
MYR skill:      ~/.openclaw/skills/myr/
Memory system:  projects/core/infrastructure/memory-system/
MYR DB:         projects/starfighter/infrastructure/myr-system/db/myr.db
Phase 2 spec:   projects/starfighter/infrastructure/myr-system/docs/PHASE-2-SPEC.md
Design doc:     projects/starfighter/infrastructure/myr-system/DESIGN.md
```
