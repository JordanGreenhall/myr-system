#!/usr/bin/env node
'use strict';

/**
 * myr-recall — Surface relevant prior MYR yield for a work context.
 *
 * Usage:
 *   # By intent (what you're about to do)
 *   node scripts/myr-recall.js --intent "debug peer sync timeouts"
 *
 *   # By tags
 *   node scripts/myr-recall.js --tags "networking,hyperswarm"
 *
 *   # Combined, JSON output for agent consumption
 *   node scripts/myr-recall.js --intent "optimize search" --tags "fts,performance" --json
 *
 *   # Pipe into agent context
 *   node scripts/myr-recall.js --intent "refactor auth" --json | jq .
 *
 * Designed for zero-friction agent integration:
 *   - --json flag outputs structured JSON (default: human-readable)
 *   - Exit code 0 even with no results (empty results are normal)
 *   - Falsifications are always surfaced separately (too valuable to miss)
 */

const { program } = require('commander');
const chalk = require('chalk');
const { getDb } = require('./db');
const { recall } = require('../lib/recall');

program
  .name('myr-recall')
  .description('Surface relevant prior yield for a work context')
  .option('--intent <text>', 'Current work intent')
  .option('--query <text>', 'Explicit search query')
  .option('--tags <tags>', 'Comma-separated domain tags')
  .option('--limit <n>', 'Max results (default 10)', parseInt, 10)
  .option('--verified-only', 'Only show verified MYRs')
  .option('--json', 'Output as JSON (for agent consumption)');

program.parse();
const opts = program.opts();

function main() {
  if (!opts.intent && !opts.query && !opts.tags) {
    if (opts.json) {
      console.log(JSON.stringify({ results: [], falsifications: [], meta: { error: 'No search context provided' } }));
    } else {
      console.error(chalk.red('Provide at least one: --intent, --query, or --tags'));
    }
    process.exit(0);
  }

  const db = getDb();
  const tags = opts.tags ? opts.tags.split(',').map(t => t.trim()).filter(Boolean) : [];

  const result = recall(db, {
    intent: opts.intent || null,
    query: opts.query || null,
    tags,
    limit: opts.limit,
    verifiedOnly: opts.verifiedOnly || false,
  });

  db.close();

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable output
  if (result.falsifications.length > 0) {
    console.log(chalk.red.bold('\n⚠ Relevant falsifications (things proven NOT to work):\n'));
    result.falsifications.forEach((f, i) => {
      console.log(chalk.red(`  ${i + 1}. [${f.id}] ${f.falsified || f.intent}`));
      console.log(chalk.gray(`     Evidence: ${f.evidence}`));
      console.log(chalk.gray(`     Tags: ${f.tags.join(', ')}`));
      console.log('');
    });
  }

  if (result.results.length === 0) {
    console.log(chalk.yellow('\nNo matching prior yield found.\n'));
    return;
  }

  console.log(chalk.bold(`\n— ${result.results.length} relevant MYR(s) —\n`));
  result.results.forEach((r, i) => {
    const ratingStr = r.rating ? `★${r.rating}` : chalk.yellow('unverified');
    const draftStr = r.autoDraft ? chalk.gray(' [auto-draft]') : '';
    const importStr = r.importedFrom ? chalk.blue(` ← ${r.importedFrom}`) : '';

    console.log(chalk.bold(`${i + 1}. [${r.id}]`) + ` ${chalk.gray(r.type)} | ${ratingStr} | conf: ${r.confidence}${draftStr}${importStr}`);
    console.log(chalk.cyan('   Intent: ') + r.intent);
    console.log(chalk.cyan('   Q: ') + r.question);
    console.log(chalk.cyan('   Changes: ') + r.changes);
    if (r.tags.length) {
      console.log(chalk.gray(`   Tags: ${r.tags.join(', ')}`));
    }
    console.log('');
  });
}

main();
