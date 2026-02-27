# MYR Integration Examples

## The Problem

MYR only compounds if yield is captured consistently. Asking agents to remember a new habit doesn't work — behavioral rules decay across sessions. The solution is to piggyback on an existing habit: wire MYR capture into whatever memory/logging system your agents already use.

## Node 1 Reference Implementation (OpenClaw + PostgreSQL + Ollama)

### Environment

- OpenClaw agents storing memories via `memory-store.js` (PostgreSQL + pgvector)
- Ollama running locally with `llama3.1:8b` for structured extraction
- Memory search via `memory-search.js` (semantic search)

### How it works

**Capture (memory-store.js → myr-draft.js):**

When an agent stores a memory with category `lesson` or `decision`, memory-store.js spawns a fire-and-forget child process:

```javascript
// Added to memory-store.js after the memory is written successfully
if (status === 'stored' && ['lesson', 'decision'].includes(opts.category)) {
  try {
    const { spawn } = require('child_process');
    const path = require('path');
    const myrHome = process.env.MYR_HOME || '/default/path/to/myr-system';
    const draftScript = path.join(myrHome, 'scripts/myr-draft.js');
    spawn('node', [
      draftScript,
      '--label', opts.label,
      '--content', opts.content,
      '--category', opts.category,
      '--agent', opts.agent,
      '--tags', (opts.tags || []).join(','),
      '--memory-id', String(id),
    ], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) { /* never fail the parent */ }
}
```

**Key design decisions:**

1. **Fire-and-forget.** The spawn is detached with stdio ignored. The parent process (memory-store) exits immediately. If myr-draft.js fails, hangs, or the MYR DB is unavailable, memory-store is unaffected. Zero blast radius.

2. **LLM extraction.** myr-draft.js calls Ollama locally to extract structured MYR fields from flat memory content. The prompt asks for: intent, yield_type, question_answered, evidence, what_changes_next, domain_tags. If any field can't be inferred, a `[AUTO-DRAFT]` placeholder is used.

3. **NOT NULL safety.** The MYR schema has NOT NULL constraints on required fields. The extraction uses placeholder values (`[AUTO-DRAFT]`) for null fields and defaults `yield_type` to `insight` if the LLM returns an invalid value.

4. **Agent attribution.** The originating agent ID comes from the memory record, not hardcoded. When brain-surgeon stores a lesson, the MYR draft is attributed to brain-surgeon.

**Retrieval (memory-search.js → MYR FTS):**

Memory search also queries the MYR database (FTS5 keyword search) and includes results tagged `[MYR]` or `[MYR-DRAFT]`:

```javascript
// Added to memory-search.js after the PostgreSQL query
try {
  const path = require('path');
  const myrHome = process.env.MYR_HOME || '/default/path/to/myr-system';
  const myrDbMod = require(path.join(myrHome, 'scripts/db'));
  const myrDb = myrDbMod.getDb();
  const ftsQuery = opts.query.split(/\s+/).filter(Boolean)
    .map(w => `"${w.replace(/"/g, '')}"`).join(' OR ');
  myrRows = myrDb.prepare(`
    SELECT m.* FROM myr_fts f
    JOIN myr_reports m ON f.rowid = m.rowid
    WHERE myr_fts MATCH ? ORDER BY rank LIMIT ?
  `).all(ftsQuery, 5);
  myrDb.close();
} catch (_) {
  // MYR DB unavailable — continue with memory results only
}
```

### What this achieves

- Agents never call myr-store directly
- Every lesson/decision memory automatically generates a MYR draft
- Every memory search automatically surfaces relevant MYR yield
- The MYR system is invisible to agents — they use their existing tools

## Adapting to Your Environment

The pattern is:

1. **Find the existing habit.** What do your agents already do consistently? Store memories? Write logs? Commit to git? That's your hook point.

2. **Spawn myr-draft.js as a side effect.** Pass the relevant text (label/content/tags) as CLI args. Fire-and-forget. Never let MYR capture block the primary operation.

3. **Wire MYR search into your retrieval path.** Whatever your agents use to search prior knowledge, add an FTS query against the MYR database. Tag results so agents know they're seeing yield.

4. **Use `MYR_HOME` env var.** Set it to the absolute path of your myr-system installation. Both the capture hook and the search integration use this to find the MYR scripts and database.

### If you don't use Ollama

myr-draft.js uses Ollama (`llama3.1:8b`) for extraction. If you use a different local model or API:

- Edit `myr-draft.js`, replace the `ollamaGenerate()` function with your preferred LLM call
- The prompt and JSON parsing logic stay the same
- Any model that can do structured extraction from a paragraph works

### If you don't have an agent memory system

Use the MYR skill directly. Agents call `myr-store.js` via the skill after significant work. This requires the behavioral habit — it works, but less reliably than the automatic hook.

### If your agents use a different language

myr-draft.js accepts CLI args and writes to SQLite. You can spawn it from any language:

```bash
node /path/to/myr-system/scripts/myr-draft.js \
  --label "What was learned" \
  --content "Details of the lesson" \
  --category lesson \
  --agent agent-name \
  --tags "domain1,domain2" \
  --memory-id 123
```
