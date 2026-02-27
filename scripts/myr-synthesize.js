'use strict';

const { program } = require('commander');
const fs = require('fs');
const { getDb } = require('./db');

program
  .name('myr-synthesize')
  .description('Cross-node synthesis of MYR yield by domain')
  .option('--tags <tags>', 'Comma-separated domain tags to match')
  .option('--min-nodes <n>', 'Minimum contributing nodes for a cluster (default 2)', parseInt, 2)
  .option('--out <path>', 'Write synthesis report to file');

program.parse();
const opts = program.opts();

function main() {
  if (!opts.tags) {
    console.error('Provide --tags "tag1,tag2" to specify domains for synthesis.');
    process.exit(1);
  }

  const db = getDb();
  const tags = opts.tags.split(',').map(t => t.trim().toLowerCase());
  const minNodes = opts.minNodes || 2;

  // Find all MYRs matching any of the requested tags
  const allRows = db.prepare('SELECT * FROM myr_reports ORDER BY created_at DESC').all();
  const matching = allRows.filter(row => {
    const rowTags = JSON.parse(row.domain_tags || '[]').map(t => t.toLowerCase());
    return tags.some(t => rowTags.includes(t));
  });

  if (matching.length === 0) {
    console.log('No MYRs found matching those tags.');
    db.close();
    return;
  }

  // Group by overlapping domain tags (cluster = set of shared tags)
  const clusters = {};
  for (const row of matching) {
    const rowTags = JSON.parse(row.domain_tags || '[]').map(t => t.toLowerCase());
    const clusterKey = rowTags.filter(t => tags.includes(t)).sort().join('+');
    if (!clusters[clusterKey]) clusters[clusterKey] = [];
    clusters[clusterKey].push(row);
  }

  const now = new Date().toISOString();
  let md = `# MYR Cross-Node Synthesis\n`;
  md += `**Generated:** ${now}\n`;
  md += `**Tags queried:** ${tags.join(', ')}\n`;
  md += `**Minimum nodes:** ${minNodes}\n\n`;
  md += `---\n\n`;

  let clusterCount = 0;

  for (const [clusterKey, rows] of Object.entries(clusters)) {
    const nodes = [...new Set(rows.map(r => r.node_id))];
    if (nodes.length < minNodes) continue;
    clusterCount++;

    md += `## Cluster: ${clusterKey}\n`;
    md += `**Nodes contributing:** ${nodes.join(', ')} (${nodes.length})\n`;
    md += `**MYRs in cluster:** ${rows.length}\n\n`;

    // Convergent: same or similar question_answered from different nodes
    const byQuestion = {};
    for (const row of rows) {
      const q = row.question_answered.toLowerCase().trim();
      if (!byQuestion[q]) byQuestion[q] = [];
      byQuestion[q].push(row);
    }

    const convergent = Object.entries(byQuestion)
      .filter(([_, rs]) => new Set(rs.map(r => r.node_id)).size >= 2);

    const divergent = [];
    const unique = [];

    for (const [q, rs] of Object.entries(byQuestion)) {
      const nodeSet = new Set(rs.map(r => r.node_id));
      if (nodeSet.size >= 2) continue; // already in convergent
      if (nodeSet.size === 1) unique.push(...rs);
    }

    // Divergent: different answers to similar questions across nodes
    // Simple heuristic: same yield_type + overlapping tags but different answers
    const byType = {};
    for (const row of rows) {
      if (!byType[row.yield_type]) byType[row.yield_type] = [];
      byType[row.yield_type].push(row);
    }
    for (const [_, typeRows] of Object.entries(byType)) {
      const nodeGroups = {};
      for (const r of typeRows) {
        if (!nodeGroups[r.node_id]) nodeGroups[r.node_id] = [];
        nodeGroups[r.node_id].push(r);
      }
      const nodeIds = Object.keys(nodeGroups);
      if (nodeIds.length >= 2) {
        for (let i = 0; i < nodeIds.length; i++) {
          for (let j = i + 1; j < nodeIds.length; j++) {
            const a = nodeGroups[nodeIds[i]];
            const b = nodeGroups[nodeIds[j]];
            for (const ra of a) {
              for (const rb of b) {
                if (ra.question_answered.toLowerCase() !== rb.question_answered.toLowerCase() &&
                    ra.what_changes_next !== rb.what_changes_next) {
                  divergent.push({ a: ra, b: rb });
                }
              }
            }
          }
        }
      }
    }

    // Falsifications — always surfaced
    const falsifications = rows.filter(r => r.yield_type === 'falsification' || r.what_was_falsified);

    if (convergent.length > 0) {
      md += `### Convergent Findings\n\n`;
      for (const [q, rs] of convergent) {
        const cNodes = [...new Set(rs.map(r => r.node_id))].join(', ');
        md += `**Q:** ${rs[0].question_answered}\n`;
        md += `**Confirmed by:** ${cNodes}\n`;
        for (const r of rs) {
          md += `- [${r.id}] (${r.node_id}): ${r.evidence}\n`;
        }
        md += '\n';
      }
    }

    if (divergent.length > 0) {
      md += `### Divergent Findings (requires human adjudication)\n\n`;
      const seen = new Set();
      for (const { a, b } of divergent) {
        const key = [a.id, b.id].sort().join(':');
        if (seen.has(key)) continue;
        seen.add(key);
        md += `- **${a.node_id}** [${a.id}]: ${a.question_answered}\n`;
        md += `  vs **${b.node_id}** [${b.id}]: ${b.question_answered}\n\n`;
      }
    }

    if (unique.length > 0) {
      md += `### Unique Contributions (not yet cross-validated)\n\n`;
      for (const r of unique) {
        md += `- [${r.id}] (${r.node_id}, ${r.yield_type}): ${r.question_answered}\n`;
      }
      md += '\n';
    }

    if (falsifications.length > 0) {
      md += `### Falsifications (always surfaced)\n\n`;
      for (const r of falsifications) {
        md += `- [${r.id}] (${r.node_id}): ${r.what_was_falsified || r.evidence}\n`;
      }
      md += '\n';
    }

    md += `---\n\n`;
  }

  if (clusterCount === 0) {
    md += `No clusters found with >= ${minNodes} contributing nodes.\n`;
    md += `\nMYRs found: ${matching.length} across ${[...new Set(matching.map(r => r.node_id))].length} node(s).\n`;
    md += `Consider lowering --min-nodes or waiting for more peer imports.\n`;
  }

  // Store synthesis record
  if (clusterCount > 0) {
    const synthId = `synth-${Date.now()}`;
    const sourceIds = matching.map(r => r.id);
    const nodeIds = [...new Set(matching.map(r => r.node_id))];

    db.prepare(`
      INSERT INTO myr_syntheses (id, timestamp, source_myr_ids, node_ids, domain_tags, synthesis_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(synthId, now, JSON.stringify(sourceIds), JSON.stringify(nodeIds), JSON.stringify(tags), md, now);
  }

  db.close();

  if (opts.out) {
    fs.writeFileSync(opts.out, md, 'utf8');
    console.log(`Synthesis written to ${opts.out}`);
  } else {
    console.log(md);
  }
}

main();
