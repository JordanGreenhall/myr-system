'use strict';

const { program } = require('commander');
const chalk = require('chalk');
const { getDb } = require('./db');

program
  .name('myr-search')
  .description('Search and retrieve Methodological Yield Reports')
  .option('--query <text>', 'Full-text search across all fields')
  .option('--tags <tags>', 'Filter by comma-separated domain tags')
  .option('--type <type>', 'Filter by yield type')
  .option('--limit <n>', 'Max results (default 5)', parseInt, 5)
  .option('--unverified', 'Show only unverified reports');

program.parse();
const opts = program.opts();

function search() {
  const db = getDb();
  const conditions = [];
  const params = [];

  let usesFts = false;
  let query = '';

  if (opts.query) {
    usesFts = true;
    query = opts.query;
  }

  if (opts.tags) {
    const tags = opts.tags.split(',').map(t => t.trim().toLowerCase());
    const tagClauses = tags.map(() => "LOWER(r.domain_tags) LIKE ?");
    conditions.push(`(${tagClauses.join(' OR ')})`);
    tags.forEach(t => params.push(`%${t}%`));
  }

  if (opts.type) {
    conditions.push('r.yield_type = ?');
    params.push(opts.type.toLowerCase());
  }

  if (opts.unverified) {
    conditions.push('r.jordan_rating IS NULL');
  }

  const limit = opts.limit || 5;
  let rows;

  if (usesFts) {
    const ftsTerms = query.replace(/[^\w\s]/g, '').trim().split(/\s+/).map(w => `"${w}"`).join(' OR ');
    const where = conditions.length ? 'AND ' + conditions.join(' AND ') : '';

    rows = db.prepare(`
      SELECT r.*,
        myr_fts.rank AS fts_rank,
        CASE
          WHEN r.jordan_rating >= 4 THEN 2.0
          WHEN r.jordan_rating >= 3 THEN 1.5
          WHEN r.jordan_rating IS NOT NULL THEN 1.0
          ELSE 0.8
        END AS verification_boost
      FROM myr_fts
      JOIN myr_reports r ON myr_fts.id = r.id
      WHERE myr_fts MATCH ?
      ${where}
      ORDER BY (myr_fts.rank * verification_boost) ASC
      LIMIT ?
    `).all(ftsTerms, ...params, limit);
  } else {
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    rows = db.prepare(`
      SELECT r.*,
        CASE
          WHEN r.jordan_rating >= 4 THEN 2
          WHEN r.jordan_rating >= 3 THEN 1
          ELSE 0
        END AS sort_weight
      FROM myr_reports r
      ${where}
      ORDER BY sort_weight DESC, r.created_at DESC
      LIMIT ?
    `).all(...params, limit);
  }

  db.close();
  return rows;
}

function formatRow(row, idx) {
  const tags = JSON.parse(row.domain_tags || '[]');
  const verified = row.jordan_rating != null;
  const ratingStr = verified ? `★${row.jordan_rating}` : chalk.yellow('unverified');

  const lines = [
    chalk.bold(`${idx + 1}. [${row.id}]`) + ` ${chalk.gray(row.yield_type)} | ${ratingStr} | conf: ${row.confidence}`,
    chalk.cyan('   Intent: ') + row.cycle_intent,
    chalk.cyan('   Q: ') + row.question_answered,
    chalk.cyan('   Evidence: ') + row.evidence,
    chalk.cyan('   Changes: ') + row.what_changes_next,
  ];

  if (row.what_was_falsified) {
    lines.push(chalk.red('   Falsified: ') + row.what_was_falsified);
  }

  if (tags.length) {
    lines.push(chalk.gray(`   Tags: ${tags.join(', ')}`));
  }

  return lines.join('\n');
}

function main() {
  try {
    if (!opts.query && !opts.tags && !opts.type && !opts.unverified) {
      console.error(chalk.red('Provide at least one search criterion: --query, --tags, --type, or --unverified'));
      process.exit(1);
    }

    const rows = search();

    if (rows.length === 0) {
      console.log(chalk.yellow('No matching MYRs found.'));
      return;
    }

    console.log(chalk.bold(`\n— ${rows.length} MYR(s) found —\n`));
    rows.forEach((row, i) => {
      console.log(formatRow(row, i));
      console.log('');
    });
  } catch (err) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

main();
