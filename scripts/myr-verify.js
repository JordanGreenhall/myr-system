'use strict';

const { program } = require('commander');
const chalk = require('chalk');
const readline = require('readline');
const { getDb } = require('./db');

program
  .name('myr-verify')
  .description("Operator verification interface for MYR reports")
  .option('--queue', 'Review unverified MYRs one at a time')
  .option('--id <myr-id>', 'Verify a specific MYR by ID')
  .option('--rating <n>', 'Rating 1-5', parseInt)
  .option('--notes <text>', 'Optional verification notes');

program.parse();
const opts = program.opts();

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function displayMyr(row) {
  const tags = JSON.parse(row.domain_tags || '[]');
  console.log('');
  const draftLabel = row.auto_draft ? chalk.yellow(' [AUTO-DRAFT]') : '';
  console.log(chalk.bold(`═══ ${row.id}${draftLabel} ═══`));
  console.log(chalk.gray(`${row.yield_type} | confidence: ${row.confidence} | ${row.created_at}`));
  if (tags.length) console.log(chalk.gray(`Tags: ${tags.join(', ')}`));
  console.log('');
  console.log(chalk.cyan('Intent:    ') + row.cycle_intent);
  if (row.cycle_context) console.log(chalk.cyan('Context:   ') + row.cycle_context);
  console.log(chalk.cyan('Question:  ') + row.question_answered);
  console.log(chalk.cyan('Evidence:  ') + row.evidence);
  console.log(chalk.cyan('Changes:   ') + row.what_changes_next);
  if (row.what_was_falsified) console.log(chalk.red('Falsified: ') + row.what_was_falsified);
  console.log('');
  console.log(chalk.gray('Rating scale: 1=useless  2=partial  3=adequate  4=useful  5=high-value'));
}

function applyVerification(db, id, rating, notes) {
  if (rating < 1 || rating > 5) {
    console.error(chalk.red('Rating must be 1-5'));
    process.exit(1);
  }

  const now = new Date().toISOString();
  const result = db.prepare(
    'UPDATE myr_reports SET operator_rating = ?, operator_notes = ?, verified_at = ?, updated_at = ? WHERE id = ?'
  ).run(rating, notes || null, now, now, id);

  if (result.changes === 0) {
    console.error(chalk.red(`MYR not found: ${id}`));
    process.exit(1);
  }

  console.log(chalk.green(`✓ ${id} verified: ★${rating}${notes ? ' — ' + notes : ''}`));
}

async function queueMode() {
  const db = getDb();
  const unverified = db.prepare(
    'SELECT * FROM myr_reports WHERE operator_rating IS NULL ORDER BY created_at ASC'
  ).all();

  if (unverified.length === 0) {
    console.log(chalk.green('No unverified MYRs. All caught up.'));
    db.close();
    return;
  }

  console.log(chalk.bold(`\n${unverified.length} unverified MYR(s) in queue\n`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for (const row of unverified) {
    displayMyr(row);

    const ratingStr = await ask(rl, chalk.cyan('Rating (1-5, or "s" to skip, "q" to quit): '));

    if (ratingStr.toLowerCase() === 'q') {
      console.log(chalk.gray('Exiting queue.'));
      break;
    }
    if (ratingStr.toLowerCase() === 's') {
      console.log(chalk.gray('Skipped.'));
      continue;
    }

    const rating = parseInt(ratingStr, 10);
    if (isNaN(rating) || rating < 1 || rating > 5) {
      console.log(chalk.red('Invalid rating. Skipping.'));
      continue;
    }

    const notes = await ask(rl, chalk.cyan('Notes (optional, press Enter to skip): '));
    applyVerification(db, row.id, rating, notes || null);
  }

  rl.close();
  db.close();
}

function directMode() {
  if (!opts.id) {
    console.error(chalk.red('Provide --id with --rating'));
    process.exit(1);
  }
  if (!opts.rating) {
    console.error(chalk.red('Provide --rating (1-5)'));
    process.exit(1);
  }

  const db = getDb();
  applyVerification(db, opts.id, opts.rating, opts.notes || null);
  db.close();
}

async function main() {
  try {
    if (opts.queue) {
      await queueMode();
    } else if (opts.id) {
      directMode();
    } else {
      console.error(chalk.red('Use --queue to review unverified MYRs, or --id <myr-id> --rating <1-5> to verify directly.'));
      process.exit(1);
    }
  } catch (err) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

main();
