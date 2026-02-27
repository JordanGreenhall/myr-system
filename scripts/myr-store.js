'use strict';

const { program } = require('commander');
const chalk = require('chalk');
const readline = require('readline');
const { getDb, generateId, config } = require('./db');

program
  .name('myr-store')
  .description('Capture a Methodological Yield Report')
  .option('--interactive', 'Guided prompts through each field')
  .option('--stdin', 'Read JSON from stdin')
  .option('--intent <text>', 'What was being attempted in this OODA cycle')
  .option('--type <type>', 'Yield type: technique | insight | falsification | pattern')
  .option('--question <text>', 'The specific question this cycle resolved')
  .option('--evidence <text>', 'What supports the answer (observable, not claimed)')
  .option('--changes <text>', 'What will be different in the next cycle')
  .option('--falsified <text>', 'What was proven NOT to work')
  .option('--tags <tags>', 'Comma-separated domain tags')
  .option('--context <text>', 'Brief situation description')
  .option('--confidence <n>', 'Confidence 0-1 (default 0.7)', parseFloat)
  .option('--agent <id>', 'Agent ID (default: polemarch)', 'polemarch')
  .option('--node <id>', `Node ID (default: ${config.node_id})`, config.node_id)
  .option('--session <ref>', 'Session reference');

program.parse();
const opts = program.opts();

function ask(rl, question, required) {
  return new Promise((resolve) => {
    rl.question(chalk.cyan(question), (answer) => {
      const val = answer.trim();
      if (required && !val) {
        console.log(chalk.red('  This field is required.'));
        resolve(ask(rl, question, required));
      } else {
        resolve(val || null);
      }
    });
  });
}

async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(chalk.bold('\n— MYR Capture (Interactive) —\n'));

  const intent = await ask(rl, 'Intent (what were you attempting?): ', true);
  const typeRaw = await ask(rl, 'Type (technique/insight/falsification/pattern): ', true);
  const yieldType = typeRaw.toLowerCase();
  if (!['technique', 'insight', 'falsification', 'pattern'].includes(yieldType)) {
    console.error(chalk.red(`Invalid type: ${typeRaw}. Must be technique, insight, falsification, or pattern.`));
    rl.close();
    process.exit(1);
  }
  const question = await ask(rl, 'Question answered: ', true);
  const evidence = await ask(rl, 'Evidence (observable, not claimed): ', true);
  const changes = await ask(rl, 'What changes next: ', true);
  const falsified = await ask(rl, 'What was falsified (empty if none): ', false);
  const tagsRaw = await ask(rl, 'Domain tags (comma-separated): ', false);
  const context = await ask(rl, 'Context (brief situation, optional): ', false);
  const confRaw = await ask(rl, 'Confidence 0-1 (default 0.7): ', false);

  rl.close();

  return {
    intent,
    yieldType,
    question,
    evidence,
    changes,
    falsified,
    tags: tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [],
    context,
    confidence: confRaw ? parseFloat(confRaw) : 0.7,
    agent: 'polemarch',
    node: config.node_id,
    session: null,
  };
}

function fromFlags() {
  if (!opts.intent) { console.error(chalk.red('--intent is required')); process.exit(1); }
  if (!opts.type) { console.error(chalk.red('--type is required')); process.exit(1); }
  if (!opts.question) { console.error(chalk.red('--question is required')); process.exit(1); }
  if (!opts.evidence) { console.error(chalk.red('--evidence is required')); process.exit(1); }
  if (!opts.changes) { console.error(chalk.red('--changes is required')); process.exit(1); }

  const yieldType = opts.type.toLowerCase();
  if (!['technique', 'insight', 'falsification', 'pattern'].includes(yieldType)) {
    console.error(chalk.red(`Invalid type: ${opts.type}. Must be technique, insight, falsification, or pattern.`));
    process.exit(1);
  }

  return {
    intent: opts.intent,
    yieldType,
    question: opts.question,
    evidence: opts.evidence,
    changes: opts.changes,
    falsified: opts.falsified || null,
    tags: opts.tags ? opts.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    context: opts.context || null,
    confidence: opts.confidence != null ? opts.confidence : 0.7,
    agent: opts.agent,
    node: opts.node,
    session: opts.session || null,
  };
}

function fromStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        const obj = JSON.parse(data);
        const cycle = obj.cycle || {};
        const y = obj.yield || {};
        resolve({
          intent: cycle.intent,
          yieldType: y.type,
          question: y.question_answered,
          evidence: y.evidence,
          changes: y.what_changes_next,
          falsified: y.what_was_falsified || null,
          tags: cycle.domain_tags || [],
          context: cycle.context || null,
          confidence: y.confidence != null ? y.confidence : 0.7,
          agent: obj.agent_id || 'polemarch',
          node: obj.node_id || config.node_id,
          session: obj.session_ref || null,
        });
      } catch (err) {
        reject(new Error('Invalid JSON on stdin'));
      }
    });
  });
}

function store(data) {
  const db = getDb();
  const id = generateId(db);
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(data.tags);

  db.prepare(`
    INSERT INTO myr_reports (
      id, timestamp, agent_id, node_id, session_ref,
      cycle_intent, domain_tags, cycle_context,
      yield_type, question_answered, evidence, what_changes_next,
      what_was_falsified, transferable_to, confidence,
      jordan_rating, jordan_notes, verified_at,
      signed_by, shared_with, synthesis_id,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      NULL, NULL, NULL,
      NULL, '[]', NULL,
      ?, ?
    )
  `).run(
    id, now, data.agent, data.node, data.session,
    data.intent, tagsJson, data.context,
    data.yieldType, data.question, data.evidence, data.changes,
    data.falsified, '[]', data.confidence,
    now, now
  );

  db.close();
  return id;
}

async function main() {
  try {
    let data;
    if (opts.stdin) {
      data = await fromStdin();
    } else if (opts.interactive) {
      data = await interactive();
    } else {
      data = fromFlags();
    }

    if (!data.intent || !data.yieldType || !data.question || !data.evidence || !data.changes) {
      console.error(chalk.red('Missing required fields: intent, type, question, evidence, changes'));
      process.exit(1);
    }

    const id = store(data);
    console.log(chalk.green(`✓ MYR captured: ${id}`));
    console.log(chalk.gray(`  Type: ${data.yieldType} | Tags: ${data.tags.join(', ') || 'none'} | Confidence: ${data.confidence}`));
  } catch (err) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

main();
