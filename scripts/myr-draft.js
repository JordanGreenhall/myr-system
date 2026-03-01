#!/usr/bin/env node
/**
 * Auto-draft a MYR from a memory-store event.
 * Called as a fire-and-forget child process by memory-store.js.
 * Uses local Ollama (llama3.1:8b) for structured extraction.
 * Failures are silent — this must never affect the parent process.
 */
'use strict';

const http = require('http');
const { getDb, generateId } = require('./db');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { label: null, content: null, category: null, agent: null, tags: '', memoryId: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--label') out.label = args[++i] ?? null;
    else if (a === '--content') out.content = args[++i] ?? null;
    else if (a === '--category') out.category = args[++i] ?? null;
    else if (a === '--agent') out.agent = args[++i] ?? null;
    else if (a === '--tags') out.tags = args[++i] ?? '';
    else if (a === '--memory-id') out.memoryId = args[++i] ?? null;
  }
  if (!out.label || !out.content) throw new Error('Missing --label or --content');
  return out;
}

function ollamaGenerate(prompt) {
  const body = JSON.stringify({
    model: 'llama3.1:8b',
    prompt,
    format: 'json',
    stream: false,
    options: { temperature: 0.1 },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: 11434,
        path: '/api/generate',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (ch) => (data += ch));
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

async function main() {
  validateConfig();
  const opts = parseArgs();

  const prompt = `You are extracting structured methodological yield from a memory record.

Memory label: ${opts.label}
Memory content: ${opts.content}
Category: ${opts.category}

Extract the following fields as JSON. If a field cannot be inferred, use null.

{
  "intent": "What was being attempted in the work that produced this memory",
  "yield_type": "One of: technique, insight, falsification, pattern",
  "question_answered": "The specific question this work resolved",
  "evidence": "Observable evidence supporting the answer",
  "what_changes_next": "What will be different in future work because of this",
  "what_was_falsified": "What was proven NOT to work (null if nothing)",
  "confidence": 0.7,
  "domain_tags": ["tag1", "tag2"]
}

Return ONLY the JSON object.`;

  const raw = await ollamaGenerate(prompt);
  const cleaned = stripFences(raw);
  let extracted;
  try {
    extracted = JSON.parse(cleaned);
  } catch (_) {
    // LLM returned unparseable JSON — exit silently
    process.exit(0);
  }

  // Validate and apply defaults/placeholders
  const yieldType = VALID_TYPES.includes(extracted.yield_type) ? extracted.yield_type : 'insight';
  const intent = extracted.intent || opts.label || PLACEHOLDER;
  const questionAnswered = extracted.question_answered || PLACEHOLDER;
  const evidence = extracted.evidence || opts.content.slice(0, 500) || PLACEHOLDER;
  const whatChangesNext = extracted.what_changes_next || PLACEHOLDER;
  const whatWasFalsified = extracted.what_was_falsified || null;
  const confidence = typeof extracted.confidence === 'number' ? Math.min(1, Math.max(0, extracted.confidence)) : 0.5;

  // Domain tags: merge LLM-extracted with memory tags
  const memTags = opts.tags ? opts.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  const llmTags = Array.isArray(extracted.domain_tags) ? extracted.domain_tags.filter(t => typeof t === 'string') : [];
  const allTags = [...new Set([...memTags, ...llmTags])];

  const db = getDb();
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
      ?, ?, ?, ?, NULL,
      ?, ?, NULL,
      ?, ?, ?, ?,
      ?, '[]', ?,
      1, ?,
      ?, ?
    )
  `).run(
    id, now, opts.agent || 'unknown', require('./config').node_id,
    intent, JSON.stringify(allTags),
    yieldType, questionAnswered, evidence, whatChangesNext,
    whatWasFalsified, confidence,
    opts.memoryId ? parseInt(opts.memoryId, 10) : null,
    now, now
  );

  db.close();
}

main().catch(() => {
  // Silent exit — this is fire-and-forget
  process.exit(0);
});
