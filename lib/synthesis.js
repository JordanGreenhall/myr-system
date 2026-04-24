'use strict';

/**
 * Cross-node synthesis: convergence/divergence analysis for MYR yield.
 *
 * Discovers overlapping yields across nodes, classifies them as convergent,
 * divergent, unique, or falsification, and produces a synthesis record with
 * full source provenance.
 */

/**
 * Find reports matching any of the given domain tags.
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} tags - Lowercased domain tags to match
 * @returns {object[]} Matching rows from myr_reports
 */
function findMatchingReports(db, tags) {
  if (!tags || tags.length === 0) return [];

  const allRows = db.prepare('SELECT * FROM myr_reports ORDER BY created_at DESC').all();
  return allRows.filter(row => {
    let rowTags;
    try {
      rowTags = JSON.parse(row.domain_tags || '[]').map(t => t.toLowerCase());
    } catch {
      return false;
    }
    return tags.some(t => rowTags.includes(t));
  });
}

/**
 * Group matching reports into clusters by overlapping domain tags.
 * @param {object[]} reports
 * @param {string[]} tags - The query tags
 * @returns {Record<string, object[]>} Keyed by sorted tag intersection
 */
function clusterByTags(reports, tags) {
  const clusters = {};
  for (const row of reports) {
    let rowTags;
    try {
      rowTags = JSON.parse(row.domain_tags || '[]').map(t => t.toLowerCase());
    } catch {
      continue;
    }
    const overlap = rowTags.filter(t => tags.includes(t));
    if (overlap.length === 0) continue;
    const clusterKey = overlap.sort().join('+');
    if (!clusters[clusterKey]) clusters[clusterKey] = [];
    clusters[clusterKey].push(row);
  }
  return clusters;
}

/**
 * Analyze a cluster of reports for convergence, divergence, unique contributions,
 * and falsifications.
 *
 * @param {object[]} rows - Reports in a single cluster
 * @returns {{ convergent: Array, divergent: Array, unique: Array, falsifications: Array, nodes: string[] }}
 */
function analyzeCluster(rows) {
  if (!rows || rows.length === 0) {
    return { convergent: [], divergent: [], unique: [], falsifications: [], nodes: [] };
  }

  const nodes = [...new Set(rows.map(r => r.node_id))];

  // Group by normalized question_answered
  const byQuestion = {};
  for (const row of rows) {
    const q = (row.question_answered || '').toLowerCase().trim();
    if (!q) continue;
    if (!byQuestion[q]) byQuestion[q] = [];
    byQuestion[q].push(row);
  }

  // Convergent: same question answered by >= 2 distinct nodes
  const convergent = [];
  const unique = [];

  for (const [q, rs] of Object.entries(byQuestion)) {
    const nodeSet = new Set(rs.map(r => r.node_id));
    if (nodeSet.size >= 2) {
      // Check for conflicting ratings within a convergent group
      const rated = rs.filter(r => r.operator_rating != null);
      let ratingConflict = false;
      if (rated.length >= 2) {
        const ratings = rated.map(r => r.operator_rating);
        const spread = Math.max(...ratings) - Math.min(...ratings);
        ratingConflict = spread >= 3; // 5-point scale: 3+ spread = conflict
      }

      convergent.push({
        question: rs[0].question_answered,
        reports: rs,
        nodes: [...nodeSet],
        ratingConflict,
      });
    } else {
      unique.push(...rs);
    }
  }

  // Divergent: same yield_type + overlapping tags but different answers from different nodes
  const divergent = [];
  const seenPairs = new Set();

  const byType = {};
  for (const row of rows) {
    if (!byType[row.yield_type]) byType[row.yield_type] = [];
    byType[row.yield_type].push(row);
  }

  for (const [, typeRows] of Object.entries(byType)) {
    const nodeGroups = {};
    for (const r of typeRows) {
      if (!nodeGroups[r.node_id]) nodeGroups[r.node_id] = [];
      nodeGroups[r.node_id].push(r);
    }
    const nodeIds = Object.keys(nodeGroups);
    if (nodeIds.length < 2) continue;

    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const groupA = nodeGroups[nodeIds[i]];
        const groupB = nodeGroups[nodeIds[j]];
        for (const ra of groupA) {
          for (const rb of groupB) {
            const qA = (ra.question_answered || '').toLowerCase().trim();
            const qB = (rb.question_answered || '').toLowerCase().trim();
            // Only divergent if different questions with different next-steps
            if (qA !== qB && ra.what_changes_next !== rb.what_changes_next) {
              const pairKey = [ra.id, rb.id].sort().join(':');
              if (!seenPairs.has(pairKey)) {
                seenPairs.add(pairKey);
                divergent.push({ a: ra, b: rb });
              }
            }
          }
        }
      }
    }
  }

  // Falsifications — always surfaced
  const falsifications = rows.filter(
    r => r.yield_type === 'falsification' || (r.what_was_falsified && r.what_was_falsified.trim())
  );

  return { convergent, divergent, unique, falsifications, nodes };
}

/**
 * Build provenance chain for a synthesis record.
 * Maps each source report to its origin node, import chain, and signature status.
 *
 * @param {object[]} reports
 * @returns {object[]} Provenance entries
 */
function buildProvenanceChain(reports) {
  return reports.map(r => ({
    id: r.id,
    nodeId: r.node_id,
    importedFrom: r.imported_from || null,
    signedBy: r.signed_by || null,
    importVerified: !!r.import_verified,
    createdAt: r.created_at,
  }));
}

/**
 * Run full cross-node synthesis for the given tags.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} options
 * @param {string[]} options.tags - Domain tags to match
 * @param {number}  [options.minNodes=2] - Minimum contributing nodes per cluster
 * @param {boolean} [options.store=true] - Whether to persist the synthesis record
 * @returns {{ markdown: string, clusters: object[], synthId: string|null, sourceCount: number }}
 */
function synthesize(db, { tags, minNodes = 2, store = true } = {}) {
  if (!tags || tags.length === 0) {
    return { markdown: '', clusters: [], synthId: null, sourceCount: 0 };
  }

  const normalizedTags = tags.map(t => t.trim().toLowerCase()).filter(Boolean);
  if (normalizedTags.length === 0) {
    return { markdown: '', clusters: [], synthId: null, sourceCount: 0 };
  }

  const matching = findMatchingReports(db, normalizedTags);
  if (matching.length === 0) {
    return {
      markdown: 'No MYRs found matching those tags.\n',
      clusters: [],
      synthId: null,
      sourceCount: 0,
    };
  }

  const rawClusters = clusterByTags(matching, normalizedTags);
  const now = new Date().toISOString();

  let md = `# MYR Cross-Node Synthesis\n`;
  md += `**Generated:** ${now}\n`;
  md += `**Tags queried:** ${normalizedTags.join(', ')}\n`;
  md += `**Minimum nodes:** ${minNodes}\n\n`;
  md += `---\n\n`;

  const analyzedClusters = [];

  for (const [clusterKey, rows] of Object.entries(rawClusters)) {
    const analysis = analyzeCluster(rows);

    if (analysis.nodes.length < minNodes) continue;

    analyzedClusters.push({ key: clusterKey, ...analysis, rows });

    md += `## Cluster: ${clusterKey}\n`;
    md += `**Nodes contributing:** ${analysis.nodes.join(', ')} (${analysis.nodes.length})\n`;
    md += `**MYRs in cluster:** ${rows.length}\n\n`;

    if (analysis.convergent.length > 0) {
      md += `### Convergent Findings\n\n`;
      for (const c of analysis.convergent) {
        md += `**Q:** ${c.question}\n`;
        md += `**Confirmed by:** ${c.nodes.join(', ')}\n`;
        if (c.ratingConflict) {
          md += `**Note:** Rating conflict detected across nodes\n`;
        }
        for (const r of c.reports) {
          md += `- [${r.id}] (${r.node_id}): ${r.evidence}\n`;
        }
        md += '\n';
      }
    }

    if (analysis.divergent.length > 0) {
      md += `### Divergent Findings (requires human adjudication)\n\n`;
      for (const { a, b } of analysis.divergent) {
        md += `- **${a.node_id}** [${a.id}]: ${a.question_answered}\n`;
        md += `  vs **${b.node_id}** [${b.id}]: ${b.question_answered}\n\n`;
      }
    }

    if (analysis.unique.length > 0) {
      md += `### Unique Contributions (not yet cross-validated)\n\n`;
      for (const r of analysis.unique) {
        md += `- [${r.id}] (${r.node_id}, ${r.yield_type}): ${r.question_answered}\n`;
      }
      md += '\n';
    }

    if (analysis.falsifications.length > 0) {
      md += `### Falsifications (always surfaced)\n\n`;
      for (const r of analysis.falsifications) {
        md += `- [${r.id}] (${r.node_id}): ${r.what_was_falsified || r.evidence}\n`;
      }
      md += '\n';
    }

    md += `---\n\n`;
  }

  if (analyzedClusters.length === 0) {
    md += `No clusters found with >= ${minNodes} contributing nodes.\n`;
    md += `\nMYRs found: ${matching.length} across ${[...new Set(matching.map(r => r.node_id))].length} node(s).\n`;
    md += `Consider lowering --min-nodes or waiting for more peer imports.\n`;
  }

  // Store synthesis record with provenance
  let synthId = null;
  if (store && analyzedClusters.length > 0) {
    synthId = `synth-${Date.now()}`;
    const sourceIds = matching.map(r => r.id);
    const nodeIds = [...new Set(matching.map(r => r.node_id))];
    const provenance = buildProvenanceChain(matching);

    db.prepare(`
      INSERT INTO myr_syntheses (id, timestamp, source_myr_ids, node_ids, domain_tags, synthesis_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      synthId,
      now,
      JSON.stringify({ ids: sourceIds, provenance }),
      JSON.stringify(nodeIds),
      JSON.stringify(normalizedTags),
      md,
      now
    );
  }

  return {
    markdown: md,
    clusters: analyzedClusters,
    synthId,
    sourceCount: matching.length,
  };
}

/**
 * Validate a synthesis request body for the POST /myr/synthesis endpoint.
 * @param {object} body
 * @returns {{ valid: boolean, error?: string, tags?: string[] }}
 */
function validateSynthesisRequest(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const { tags, minNodes } = body;

  if (!tags) {
    return { valid: false, error: 'tags is required (comma-separated string or array)' };
  }

  let parsedTags;
  if (typeof tags === 'string') {
    parsedTags = tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  } else if (Array.isArray(tags)) {
    parsedTags = tags.map(t => String(t).trim().toLowerCase()).filter(Boolean);
  } else {
    return { valid: false, error: 'tags must be a string or array' };
  }

  if (parsedTags.length === 0) {
    return { valid: false, error: 'At least one non-empty tag is required' };
  }

  if (minNodes !== undefined) {
    const n = Number(minNodes);
    if (!Number.isInteger(n) || n < 1) {
      return { valid: false, error: 'minNodes must be a positive integer' };
    }
  }

  return { valid: true, tags: parsedTags };
}

module.exports = {
  findMatchingReports,
  clusterByTags,
  analyzeCluster,
  buildProvenanceChain,
  synthesize,
  validateSynthesisRequest,
};
