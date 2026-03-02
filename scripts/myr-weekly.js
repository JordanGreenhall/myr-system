'use strict';

const { program } = require('commander');
const chalk = require('chalk');
const fs = require('fs');
const { getDb } = require('./db');

program
  .name('myr-weekly')
  .description('Generate weekly MYR synthesis report')
  .option('--week <date>', 'Start of week (YYYY-MM-DD), defaults to current week')
  .option('--output <path>', 'Write report to file instead of stdout');

program.parse();
const opts = program.opts();

function getWeekBounds(startStr) {
  let start;
  if (startStr) {
    start = new Date(startStr + 'T00:00:00Z');
  } else {
    const now = new Date();
    const day = now.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    start = new Date(now);
    start.setUTCDate(now.getUTCDate() - diff);
    start.setUTCHours(0, 0, 0, 0);
  }
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    label: start.toISOString().slice(0, 10),
  };
}

function generate() {
  const db = getDb();
  const { start, end, label } = getWeekBounds(opts.week);

  const rows = db.prepare(
    'SELECT * FROM myr_reports WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC'
  ).all(start, end);

  if (rows.length === 0) {
    db.close();
    return `# Weekly MYR Synthesis — ${label}\n\nNo MYRs captured this week.\n`;
  }

  const byType = { technique: [], insight: [], falsification: [], pattern: [] };
  rows.forEach(r => byType[r.yield_type].push(r));

  const unverified = rows.filter(r => r.operator_rating == null && !r.auto_draft);
  const verified = rows.filter(r => r.operator_rating != null);
  const autoDrafts = rows.filter(r => r.auto_draft);

  const topInsights = rows
    .filter(r => r.yield_type === 'insight' || r.yield_type === 'technique')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  const allFalsifications = byType.falsification;

  const tagCounts = {};
  rows.forEach(r => {
    const tags = JSON.parse(r.domain_tags || '[]');
    tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
  });

  let md = `# Weekly MYR Synthesis — ${label}\n\n`;

  md += `## Summary\n\n`;
  md += `| Type | Count |\n|------|-------|\n`;
  for (const [type, list] of Object.entries(byType)) {
    if (list.length > 0) {
      md += `| ${type} | ${list.length} |\n`;
    }
  }
  md += `| **Total** | **${rows.length}** |\n`;
  md += `\nVerified: ${verified.length} | Unverified: ${unverified.length} | Auto-drafts: ${autoDrafts.length}\n\n`;

  if (topInsights.length > 0) {
    md += `## Top Insights (by confidence)\n\n`;
    topInsights.forEach((r, i) => {
      const rating = r.operator_rating != null ? ` | ★${r.operator_rating}` : '';
      md += `### ${i + 1}. ${r.cycle_intent}\n`;
      md += `**ID:** ${r.id} | **Confidence:** ${r.confidence}${rating}\n\n`;
      md += `- **Q:** ${r.question_answered}\n`;
      md += `- **Evidence:** ${r.evidence}\n`;
      md += `- **Changes next:** ${r.what_changes_next}\n\n`;
    });
  }

  if (allFalsifications.length > 0) {
    md += `## Falsifications (always surfaced)\n\n`;
    allFalsifications.forEach((r) => {
      md += `### ✗ ${r.cycle_intent}\n`;
      md += `**ID:** ${r.id} | **Confidence:** ${r.confidence}\n\n`;
      md += `- **Q:** ${r.question_answered}\n`;
      md += `- **Falsified:** ${r.what_was_falsified || r.evidence}\n`;
      md += `- **Changes next:** ${r.what_changes_next}\n\n`;
    });
  }

  if (byType.pattern.length > 0) {
    md += `## Patterns\n\n`;
    byType.pattern.forEach((r) => {
      md += `- **${r.cycle_intent}** (${r.id}): ${r.question_answered}\n`;
    });
    md += '\n';
  }

  if (autoDrafts.length > 0) {
    md += `## Auto-Drafts — Extracted from Agent Memories\n\n`;
    autoDrafts.forEach((r) => {
      md += `- **${r.id}** (${r.yield_type}): ${r.cycle_intent}\n`;
    });
    md += '\n';
  }

  if (unverified.length > 0) {
    md += `## Unverified — Awaiting Operator Review\n\n`;
    unverified.forEach((r) => {
      md += `- **${r.id}** (${r.yield_type}): ${r.cycle_intent}\n`;
    });
    md += '\n';
  }

  if (Object.keys(tagCounts).length > 0) {
    md += `## Yield by Domain\n\n`;
    const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
    sorted.forEach(([tag, count]) => {
      md += `- **${tag}**: ${count} report${count > 1 ? 's' : ''}\n`;
    });
    md += '\n';
  }

  md += `---\n*Generated ${new Date().toISOString()}*\n`;

  db.close();
  return md;
}

function main() {
  try {
    const report = generate();

    if (opts.output) {
      fs.writeFileSync(opts.output, report, 'utf8');
      console.log(chalk.green(`✓ Weekly report written to ${opts.output}`));
    } else {
      console.log(report);
    }
  } catch (err) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

main();
