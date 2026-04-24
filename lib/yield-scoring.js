'use strict';

/**
 * Yield scoring — computes composite relevance scores for MYR reports.
 *
 * Combines: source trust, freshness, application feedback, contradiction
 * penalties, confidence, and operator rating into a single bounded score
 * with full explainability.
 */

const { computeDomainTrust } = require('./participation');

const WEIGHTS = {
  sourceTrust: 0.30,
  freshness: 0.15,
  confidence: 0.15,
  operatorRating: 0.20,
  applicationFeedback: 0.10,
  contradictionPenalty: 0.10,
};

const FRESHNESS_HALF_LIFE_DAYS = 30;

/**
 * Compute freshness score with exponential decay.
 * Returns 0.0–1.0 where 1.0 is brand new.
 */
function freshnessScore(createdAt, now) {
  if (!createdAt) return 0.5;
  const ageMs = (now || Date.now()) - new Date(createdAt).getTime();
  if (ageMs <= 0) return 1.0;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS);
}

/**
 * Compute application feedback score for a report.
 * More downstream applications = higher value. Diminishing returns.
 */
function applicationScore(db, reportId) {
  let appCount = 0;
  let positiveOutcomes = 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt,
        SUM(CASE WHEN outcome IS NOT NULL AND outcome != '' THEN 1 ELSE 0 END) as with_outcome
      FROM myr_applications
      WHERE source_yield_id = ?
    `).get(reportId);
    appCount = row ? row.cnt : 0;
    positiveOutcomes = row ? row.with_outcome : 0;
  } catch {
    return { score: 0, applications: 0, evidence: 'applications table unavailable' };
  }

  if (appCount === 0) {
    return { score: 0, applications: 0, evidence: 'no downstream applications' };
  }

  // Diminishing returns: log2(1 + count) / log2(11) caps at ~1.0 for 10 applications
  const rawScore = Math.log2(1 + appCount) / Math.log2(11);
  const outcomeBonus = positiveOutcomes > 0 ? 0.1 : 0;
  const score = Math.min(1.0, rawScore + outcomeBonus);

  return {
    score: Math.round(score * 100) / 100,
    applications: appCount,
    positiveOutcomes,
    evidence: `${appCount} application(s), ${positiveOutcomes} with recorded outcome`,
  };
}

/**
 * Compute contradiction penalty for a report.
 * Returns 0.0 (no contradictions) to 1.0 (heavily contradicted).
 */
function contradictionPenalty(db, reportId) {
  let count = 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM myr_contradictions
      WHERE yield_a_id = ? OR yield_b_id = ?
    `).get(reportId, reportId);
    count = row ? row.cnt : 0;
  } catch {
    return { penalty: 0, contradictions: 0, evidence: 'contradictions table unavailable' };
  }

  if (count === 0) {
    return { penalty: 0, contradictions: 0, evidence: 'no contradictions detected' };
  }

  // Each contradiction reduces score; cap at 1.0 (fully contradicted)
  const penalty = Math.min(1.0, count * 0.3);
  return {
    penalty: Math.round(penalty * 100) / 100,
    contradictions: count,
    evidence: `${count} contradiction(s) detected`,
  };
}

/**
 * Normalize operator rating (1–5) to 0.0–1.0 score.
 */
function ratingScore(operatorRating) {
  if (operatorRating == null) return { score: 0.5, evidence: 'unrated (default 0.5)' };
  const clamped = Math.max(1, Math.min(5, operatorRating));
  const score = (clamped - 1) / 4;
  return { score: Math.round(score * 100) / 100, evidence: `rated ${operatorRating}/5` };
}

/**
 * Normalize confidence (0.0–1.0) directly.
 */
function confidenceScore(confidence) {
  if (confidence == null) return { score: 0.7, evidence: 'default confidence 0.7' };
  return {
    score: Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100,
    evidence: `confidence ${confidence}`,
  };
}

/**
 * Compute source trust score for a report based on the originating peer's
 * domain trust in the report's domains.
 */
function sourceTrustScore(db, report) {
  if (!report.imported_from) {
    // Local report — full self-trust
    return { score: 1.0, evidence: 'local report (self-trust)' };
  }

  let tags;
  try {
    tags = JSON.parse(report.domain_tags || '[]');
  } catch {
    tags = [];
  }

  if (tags.length === 0) {
    return { score: 0.5, evidence: 'no domain tags for trust evaluation' };
  }

  // Average domain trust across all tags
  let totalTrust = 0;
  let tagCount = 0;
  const domainScores = {};

  for (const tag of tags) {
    const dt = computeDomainTrust(db, report.imported_from, tag);
    domainScores[tag] = dt.score;
    totalTrust += dt.score;
    tagCount++;
  }

  const avgTrust = tagCount > 0 ? totalTrust / tagCount : 0;

  return {
    score: Math.round(avgTrust * 100) / 100,
    domainScores,
    evidence: `avg trust ${avgTrust.toFixed(2)} across ${tagCount} domain(s) from ${report.imported_from}`,
  };
}

/**
 * Compute a composite yield score for a single report.
 *
 * Returns { score, factors, explanation } where:
 *   - score: 0.0–1.0 composite relevance score
 *   - factors: breakdown of each scoring dimension
 *   - explanation: human-readable reason for the score
 */
function scoreReport(db, report, { now = null } = {}) {
  const timestamp = now || Date.now();

  const trust = sourceTrustScore(db, report);
  const fresh = {
    score: freshnessScore(report.created_at, timestamp),
    evidence: `age decay from ${report.created_at}`,
  };
  const conf = confidenceScore(report.confidence);
  const rating = ratingScore(report.operator_rating);
  const appFeedback = applicationScore(db, report.id);
  const contradiction = contradictionPenalty(db, report.id);

  // Weighted composite (contradiction is inverted — higher penalty = lower score)
  const composite =
    WEIGHTS.sourceTrust * trust.score +
    WEIGHTS.freshness * fresh.score +
    WEIGHTS.confidence * conf.score +
    WEIGHTS.operatorRating * rating.score +
    WEIGHTS.applicationFeedback * appFeedback.score -
    WEIGHTS.contradictionPenalty * contradiction.penalty;

  const score = Math.round(Math.max(0, Math.min(1, composite)) * 1000) / 1000;

  const factors = {
    sourceTrust: { weight: WEIGHTS.sourceTrust, ...trust },
    freshness: { weight: WEIGHTS.freshness, ...fresh },
    confidence: { weight: WEIGHTS.confidence, ...conf },
    operatorRating: { weight: WEIGHTS.operatorRating, ...rating },
    applicationFeedback: { weight: WEIGHTS.applicationFeedback, ...appFeedback },
    contradictionPenalty: { weight: WEIGHTS.contradictionPenalty, ...contradiction },
  };

  const topFactor = Object.entries(factors)
    .filter(([k]) => k !== 'contradictionPenalty')
    .sort((a, b) => (b[1].weight * b[1].score) - (a[1].weight * a[1].score))[0];

  let explanation = `Score ${score}: `;
  if (contradiction.penalty > 0) {
    explanation += `contradicted (${contradiction.evidence}), `;
  }
  explanation += `primary signal is ${topFactor[0]} (${topFactor[1].evidence})`;

  return { score, factors, explanation };
}

/**
 * Score and rank an array of reports, returning them sorted by composite score.
 * Includes explainability for each report.
 */
function rankReports(db, reports, { now = null, minScore = 0 } = {}) {
  const scored = reports.map(report => {
    const { score, factors, explanation } = scoreReport(db, report, { now });
    return { ...report, _yieldScore: score, _yieldFactors: factors, _yieldExplanation: explanation };
  });

  return scored
    .filter(r => r._yieldScore >= minScore)
    .sort((a, b) => b._yieldScore - a._yieldScore);
}

/**
 * Explain why a report was surfaced or withheld.
 * Returns a structured explanation suitable for API responses.
 */
function explainYield(db, report, { now = null } = {}) {
  const { score, factors, explanation } = scoreReport(db, report, { now });

  const surfaced = score >= 0.2;
  const reasons = [];

  if (factors.sourceTrust.score < 0.3) {
    reasons.push(`Low source trust (${factors.sourceTrust.evidence})`);
  }
  if (factors.contradictionPenalty.penalty > 0) {
    reasons.push(`Has contradictions (${factors.contradictionPenalty.evidence})`);
  }
  if (factors.freshness.score < 0.3) {
    reasons.push(`Aging content (freshness ${factors.freshness.score})`);
  }
  if (factors.operatorRating.score < 0.25) {
    reasons.push(`Low rating (${factors.operatorRating.evidence})`);
  }
  if (factors.applicationFeedback.score > 0) {
    reasons.push(`Applied downstream (${factors.applicationFeedback.evidence})`);
  }

  return {
    reportId: report.id,
    score,
    surfaced,
    decision: surfaced ? 'surfaced' : 'withheld',
    explanation,
    reasons: reasons.length > 0 ? reasons : ['Standard scoring — no notable signals'],
    factors,
  };
}

module.exports = {
  WEIGHTS,
  FRESHNESS_HALF_LIFE_DAYS,
  freshnessScore,
  applicationScore,
  contradictionPenalty,
  ratingScore,
  confidenceScore,
  sourceTrustScore,
  scoreReport,
  rankReports,
  explainYield,
};
