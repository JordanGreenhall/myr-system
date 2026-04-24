#!/usr/bin/env node
'use strict';

/**
 * myr-capture — Extract methodological yield from a work session log.
 *
 * Low-burden yield extraction: takes a session transcript, summary, or log
 * and uses local Ollama to extract multiple yield candidates.
 *
 * Usage:
 *   # From stdin (pipe a session log)
 *   cat session.log | node scripts/myr-capture.js --tags "networking,sync"
 *
 *   # From a file
 *   node scripts/myr-capture.js --file session.log --tags "auth"
 *
 *   # With explicit session context
 *   node scripts/myr-capture.js --file session.log --session-intent "debug sync timeouts" --tags "sync"
 *
 *   # Dry run (show what would be captured, don't store)
 *   cat session.log | node scripts/myr-capture.js --tags "test" --dry-run
 *
 * Designed for fire-and-forget agent integration:
 *   - Silent on LLM failure (exit 0)
 *   - Stores all extractions as auto_draft=1
 *   - --json flag for structured output
 */

const fs = require('fs');
const http = require('http');
const { program } = require('commander');
const chalk = require('chalk');
const { getDb, generateId } = require('./db');
const config = require('./config');

config.validateConfig();

program
  .name('myr-capture')
  .description('Extract methodological yield from a work session')
  .option('--file <path>', 'Read session log from file')
  .option('--session-intent <text>', 'What the session was attempting')
  .option('--tags <tags>', 'Comma-separated domain tags')
  .option('--agent <id>', 'Agent ID', 'unknown')
  .option('--session-ref <ref>', 'Session reference identifier')
  .option('--dry-run', 'Show extractions without storing')
  .option('--json', 'Output as JSON')
  .option('--max-yields <n>', 'Max yield candidates to extract (default 5)', parseInt, 5);

program.parse();
const opts = program.opts();

function readInput() {
  if (opts.file) {
    return fs.readFileSync(opts.file, 'utf8');
  }
  // Read from stdin
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function ollamaGenerate(prompt) {
  const body = JSON.stringify({
    model: 'llama3.1:8b',
    prompt,
    format: 'json',
    stream: false,
    options: { temperature: 0.15, num_predict: 2048 },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: 11434,
        path: '/api/generate',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 60000,
      },
      (res) => {
        let data = '';
        res.on('data', ch => { data += ch; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            resolve(j.response || '');
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function stripFences(s) {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

const VALID_TYPES = ['technique', 'insight', 'falsification', 'pattern'];
const PLACEHOLDER = '[AUTO-DRAFT]';

function buildPrompt(sessionLog, sessionIntent, maxYields) {
  const truncated = sessionLog.length > 8000 ? sessionLog.slice(0, 8000) + '\n...[truncated]' : sessionLog;

  return `You are extracting methodological yield from a work session log.
${sessionIntent ? `Session intent: ${sessionIntent}` : ''}

Work session log:
---
${truncated}
---

Extract up to ${maxYields} distinct methodological findings from this session. Each finding should be one of:
- technique: a reusable method that worked
- insight: an orientation shift or new understanding
- falsification: something proven NOT to work
- pattern: a recurring structure observed

Return a JSON object with a "yields" array. Each yield object must have:
{
  "yields": [
    {
      "intent": "What was being attempted",
      "yield_type": "technique|insight|falsification|pattern",
      "question_answered": "The specific question resolved",
      "evidence": "Observable evidence (not claimed)",
      "what_changes_next": "What will be different in future work",
      "what_was_falsified": "What was proven not to work (null if N/A)",
      "confidence": 0.7,
      "domain_tags": ["tag1", "tag2"]
    }
  ]
}

Rules:
- Only extract findings with clear evidence in the log
- Prefer falsifications (things that didn't work are highly valuable)
- Each finding must be distinct and non-overlapping
- confidence should reflect how well-evidenced the finding is
- Return {"yields": []} if no clear findings exist

Return ONLY the JSON object.`;
}

async function main() {
  const input = await readInput();
  if (!input || input.trim().length < 20) {
    if (opts.json) {
      console.log(JSON.stringify({ captured: [], error: 'Input too short' }));
    } else {
      console.error(chalk.yellow('Session log too short to extract yield from.'));
    }
    process.exit(0);
  }

  const prompt = buildPrompt(input, opts.sessionIntent, opts.maxYields);

  let raw;
  try {
    raw = await ollamaGenerate(prompt);
  } catch (err) {
    // LLM unavailable — silent exit (fire-and-forget pattern)
    if (opts.json) {
      console.log(JSON.stringify({ captured: [], error: `LLM unavailable: ${err.message}` }));
    }
    process.exit(0);
  }

  const cleaned = stripFences(raw);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    if (opts.json) {
      console.log(JSON.stringify({ captured: [], error: 'LLM returned unparseable JSON' }));
    }
    process.exit(0);
  }

  const yields = Array.isArray(parsed.yields) ? parsed.yields : [];
  if (yields.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ captured: [] }));
    } else {
      console.log(chalk.yellow('No yield candidates extracted from session.'));
    }
    process.exit(0);
  }

  const memTags = opts.tags ? opts.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  const captured = [];

  const db = opts.dryRun ? null : getDb();

  for (const y of yields.slice(0, opts.maxYields)) {
    const yieldType = VALID_TYPES.includes(y.yield_type) ? y.yield_type : 'insight';
    const intent = y.intent || opts.sessionIntent || PLACEHOLDER;
    const questionAnswered = y.question_answered || PLACEHOLDER;
    const evidence = y.evidence || PLACEHOLDER;
    const whatChangesNext = y.what_changes_next || PLACEHOLDER;
    const whatWasFalsified = y.what_was_falsified || null;
    const confidence = typeof y.confidence === 'number' ? Math.min(1, Math.max(0, y.confidence)) : 0.5;
    const llmTags = Array.isArray(y.domain_tags) ? y.domain_tags.filter(t => typeof t === 'string') : [];
    const allTags = [...new Set([...memTags, ...llmTags])];

    const entry = {
      type: yieldType,
      intent,
      question: questionAnswered,
      evidence,
      changes: whatChangesNext,
      falsified: whatWasFalsified,
      confidence,
      tags: allTags,
    };

    if (!opts.dryRun && db) {
      const id = generateId(db);
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO myr_reports (
          id, timestamp, agent_id, node_id, session_ref,
          cycle_intent, domain_tags, cycle_context,
          yield_type, question_answered, evidence, what_changes_next,
          what_was_falsified, transferable_to, confidence,
          auto_draft, source_memory_id,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, NULL,
          ?, ?, ?, ?,
          ?, '[]', ?,
          1, NULL,
          ?, ?
        )
      `).run(
        id, now, opts.agent, config.node_id, opts.sessionRef || null,
        intent, JSON.stringify(allTags),
        yieldType, questionAnswered, evidence, whatChangesNext,
        whatWasFalsified, confidence,
        now, now
      );

      entry.id = id;
    }

    captured.push(entry);
  }

  if (db) db.close();

  if (opts.json) {
    console.log(JSON.stringify({ captured }, null, 2));
    return;
  }

  // Human-readable output
  const verb = opts.dryRun ? 'Would capture' : 'Captured';
  console.log(chalk.bold(`\n— ${verb} ${captured.length} yield(s) —\n`));
  captured.forEach((c, i) => {
    const idStr = c.id ? `[${c.id}] ` : '';
    console.log(chalk.bold(`${i + 1}. ${idStr}${chalk.gray(c.type)} | conf: ${c.confidence}`));
    console.log(chalk.cyan('   Intent: ') + c.intent);
    console.log(chalk.cyan('   Q: ') + c.question);
    console.log(chalk.cyan('   Evidence: ') + c.evidence);
    console.log(chalk.cyan('   Changes: ') + c.changes);
    if (c.falsified) {
      console.log(chalk.red('   Falsified: ') + c.falsified);
    }
    if (c.tags.length) {
      console.log(chalk.gray(`   Tags: ${c.tags.join(', ')}`));
    }
    console.log('');
  });
}

main().catch((err) => {
  // Fire-and-forget: never crash the calling process
  if (opts.json) {
    console.log(JSON.stringify({ captured: [], error: err.message }));
  }
  process.exit(0);
});
