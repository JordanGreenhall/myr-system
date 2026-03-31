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

---

## Node 2 Reference Implementation (Hermes Agent + Python)

This example shows MYR integration from a completely different stack: a Python-based agent running a Nous Research Hermes model (via Ollama or vLLM). No OpenClaw, no Node memory system, no PostgreSQL — just a Python agent loop calling MYR's CLI scripts as subprocesses.

This is intentional. **MYR is system-agnostic.** If it only worked with OpenClaw's memory stack, it would be a plugin, not a protocol. Two reference implementations from two different systems makes that concrete.

### Environment

- Python 3.11+ agent using `ollama` Python library with `NousResearch/Hermes-3-Llama-3.1-8B`
- No external memory system — the agent uses in-context history
- MYR node cloned at `/home/user/myr-system`, `MYR_HOME` set in environment

### How it works

**Capture (agent loop → subprocess):**

When the Hermes agent completes a research or reasoning cycle, it checks whether the output contains a lesson, falsification, or technique worth persisting. If so, it calls `myr-store.js` via subprocess before yielding its response.

```python
import subprocess
import os
import json

MYR_HOME = os.environ.get("MYR_HOME", "/home/user/myr-system")

def myr_store(intent: str, yield_type: str, question: str,
              evidence: str, changes: str, tags: list[str],
              agent: str = "hermes") -> bool:
    """Fire-and-forget MYR capture. Returns True if store succeeded."""
    try:
        result = subprocess.run(
            [
                "node",
                f"{MYR_HOME}/scripts/myr-store.js",
                "--intent", intent,
                "--type", yield_type,
                "--question", question,
                "--evidence", evidence,
                "--changes", changes,
                "--tags", ",".join(tags),
                "--agent", agent,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False  # never fail the agent loop


def myr_search(query: str, limit: int = 5) -> list[dict]:
    """Query MYR before starting new work on a known domain."""
    try:
        result = subprocess.run(
            [
                "node",
                f"{MYR_HOME}/scripts/myr-search.js",
                "--query", query,
                "--limit", str(limit),
                "--json",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout)
    except Exception:
        pass
    return []
```

**Agent loop integration:**

```python
import ollama

def hermes_agent_turn(user_message: str, history: list[dict]) -> str:
    # 1. Before research — recall prior yield
    prior_yield = myr_search(user_message)
    context_injection = ""
    if prior_yield:
        yield_text = "\n".join(
            f"[MYR:{r['yield_type']}] {r['question_answered']}: {r['evidence']}"
            for r in prior_yield[:3]
        )
        context_injection = f"\n\n<prior_yield>\n{yield_text}\n</prior_yield>"

    messages = history + [
        {"role": "user", "content": user_message + context_injection}
    ]

    response = ollama.chat(
        model="hf.co/NousResearch/Hermes-3-Llama-3.1-8B-GGUF",
        messages=messages,
    )
    reply = response["message"]["content"]

    # 2. After reasoning — extract and store yield (heuristic)
    if any(marker in reply.lower() for marker in
           ["learned", "doesn't work", "discovered", "confirmed", "pattern:"]):
        myr_store(
            intent=user_message[:120],
            yield_type="insight",
            question=f"What did this cycle resolve about: {user_message[:80]}?",
            evidence=reply[:300],
            changes="Carry this forward in future cycles on this domain.",
            tags=["hermes", "auto-captured"],
            agent="hermes",
        )

    return reply
```

**Key design decisions:**

1. **Subprocess, not import.** MYR is Node.js; the agent is Python. Subprocess keeps the boundary clean. No native bindings, no FFI — just stdin/stdout/exit codes.

2. **Recall before action.** `myr_search` runs at the start of each turn for domain-relevant queries. The result is injected into the prompt as a `<prior_yield>` block. The Hermes model sees prior network yield as context, not as a tool result.

3. **Heuristic capture.** The agent doesn't require an explicit "store this" command. A simple keyword heuristic flags likely yield-bearing turns. False positives are filtered at operator review (`myr-verify.js`). This trades precision for consistency.

4. **Fire-and-forget.** Capture runs in a subprocess with a 10-second timeout. If MYR is unavailable (disk full, DB locked, wrong path), the agent loop continues. The user never sees a MYR error.

5. **Attribution flows naturally.** The `--agent hermes` tag means all yield from this node is traceable back to the Hermes agent, not the operator. Cross-node synthesis (`myr-synthesize.js`) can isolate Hermes-sourced findings.

### What this achieves

- A Hermes agent on a Python stack compounds yield across sessions without learning new habits
- The agent recalls network yield from other nodes (including OpenClaw nodes) before starting work
- MYR's trust and signing properties apply identically — no special treatment for Python or Hermes
- A new network participant can set up this integration in ~20 lines of Python

---

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
