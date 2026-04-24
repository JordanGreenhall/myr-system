'use strict';

/**
 * Core recall library — surfaces relevant prior MYR yield given a work context.
 *
 * Used by:
 *   - scripts/myr-recall.js (CLI)
 *   - server /myr/recall endpoint (HTTP)
 *   - Any agent integration that needs context-aware prior material
 *
 * Trust-weighted retrieval: results are scored and ranked by a composite of
 * source trust, freshness, confidence, operator rating, application feedback,
 * and contradiction penalties. Each result includes an explanation of why
 * it was surfaced.
 */

const { scoreReport, explainYield } = require('./yield-scoring');

/**
 * Recall relevant prior MYRs for a given work context.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} params
 * @param {string} [params.intent] - Current work intent (used for FTS)
 * @param {string[]} [params.tags] - Domain tags to match
 * @param {string} [params.query] - Explicit search query (used instead of intent for FTS)
 * @param {number} [params.limit=10] - Max results
 * @param {boolean} [params.verifiedOnly=false] - Only return verified (rated) MYRs
 * @param {boolean} [params.includeFalsifications=true] - Always include relevant falsifications
 * @param {boolean} [params.explain=false] - Include scoring explanation per result
 * @param {number} [params.minScore=0] - Minimum yield score to include (0.0–1.0)
 * @returns {{ results: Array, falsifications: Array, meta: Object }}
 */
function recall(db, {
  intent = null,
  tags = [],
  query = null,
  limit = 10,
  verifiedOnly = false,
  includeFalsifications = true,
  explain = false,
  minScore = 0,
} = {}) {
  const searchText = query || intent;
  if (!searchText && tags.length === 0) {
    return { results: [], falsifications: [], meta: { query: null, tags: [], totalMatches: 0 } };
  }

  const results = [];
  const falsifications = [];
  const quarantineTableExists = !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='myr_quarantined_yields'"
  ).get();

  // Primary search: FTS + tag filtering
  if (searchText) {
    const ftsTerms = searchText
      .replace(/[^\w\s]/g, '')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 1)
      .map(w => `"${w}"`)
      .join(' OR ');

    if (ftsTerms) {
      const conditions = [];
      const params = [ftsTerms];

      if (verifiedOnly) {
        conditions.push('r.operator_rating IS NOT NULL');
      }
      if (quarantineTableExists) {
        conditions.push(
          "NOT EXISTS (SELECT 1 FROM myr_quarantined_yields q WHERE q.yield_id = r.id AND q.status = 'active')"
        );
      }

      if (tags.length > 0) {
        const tagClauses = tags.map(() => 'LOWER(r.domain_tags) LIKE ?');
        conditions.push(`(${tagClauses.join(' OR ')})`);
        tags.forEach(t => params.push(`%${t.toLowerCase()}%`));
      }

      const where = conditions.length ? 'AND ' + conditions.join(' AND ') : '';

      const rows = db.prepare(`
        SELECT r.*,
          myr_fts.rank AS fts_rank
        FROM myr_fts
        JOIN myr_reports r ON myr_fts.id = r.id
        WHERE myr_fts MATCH ?
        ${where}
        ORDER BY myr_fts.rank ASC
        LIMIT ?
      `).all(...params, limit * 4); // Fetch extra for scoring + separating falsifications

      // Score and rank by composite yield score
      const scored = rows.map(row => {
        const { score, factors, explanation } = scoreReport(db, row);
        return { row, score, factors, explanation };
      }).filter(s => s.score >= minScore)
        .sort((a, b) => b.score - a.score);

      for (const { row, score, factors, explanation } of scored) {
        const entry = formatResult(row);
        if (explain) {
          entry.yieldScore = score;
          entry.yieldExplanation = explanation;
          entry.yieldFactors = factors;
        } else {
          entry.yieldScore = score;
        }
        if (row.yield_type === 'falsification' && includeFalsifications) {
          falsifications.push(entry);
        } else {
          if (results.length < limit) results.push(entry);
        }
      }
    }
  }

  // Supplementary: tag-only search when FTS results are sparse
  if (tags.length > 0 && results.length < limit) {
    const existingIds = new Set([...results, ...falsifications].map(r => r.id));
    const tagClauses = tags.map(() => 'LOWER(r.domain_tags) LIKE ?');
    const tagParams = tags.map(t => `%${t.toLowerCase()}%`);

    const conditions = [`(${tagClauses.join(' OR ')})`];
    if (verifiedOnly) {
      conditions.push('r.operator_rating IS NOT NULL');
    }
    if (quarantineTableExists) {
      conditions.push(
        "NOT EXISTS (SELECT 1 FROM myr_quarantined_yields q WHERE q.yield_id = r.id AND q.status = 'active')"
      );
    }

    const tagRows = db.prepare(`
      SELECT r.*
      FROM myr_reports r
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.created_at DESC
      LIMIT ?
    `).all(...tagParams, limit * 2);

    // Score and rank by composite yield score
    const tagScored = tagRows
      .filter(row => !existingIds.has(row.id))
      .map(row => {
        const { score, factors, explanation } = scoreReport(db, row);
        return { row, score, factors, explanation };
      })
      .filter(s => s.score >= minScore)
      .sort((a, b) => b.score - a.score);

    for (const { row, score, factors, explanation } of tagScored) {
      const entry = formatResult(row);
      if (explain) {
        entry.yieldScore = score;
        entry.yieldExplanation = explanation;
        entry.yieldFactors = factors;
      } else {
        entry.yieldScore = score;
      }
      if (row.yield_type === 'falsification' && includeFalsifications) {
        falsifications.push(entry);
      } else {
        if (results.length < limit) results.push(entry);
      }
    }
  }

  return {
    results,
    falsifications,
    meta: {
      query: searchText,
      tags,
      totalMatches: results.length + falsifications.length,
    },
  };
}

/**
 * Format a database row into a clean recall result.
 */
function formatResult(row) {
  let tags;
  try {
    tags = JSON.parse(row.domain_tags || '[]');
  } catch (_) {
    tags = [];
  }

  return {
    id: row.id,
    type: row.yield_type,
    intent: row.cycle_intent,
    question: row.question_answered,
    evidence: row.evidence,
    changes: row.what_changes_next,
    falsified: row.what_was_falsified || null,
    confidence: row.confidence,
    tags,
    rating: row.operator_rating || null,
    autoDraft: row.auto_draft === 1,
    createdAt: row.created_at,
    nodeId: row.node_id,
    importedFrom: row.imported_from || null,
  };
}

module.exports = { recall, formatResult, explainYield };
