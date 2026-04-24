# ADR: Trust-Weighted Yield Scoring and Selective Routing

**Status:** Implemented
**Date:** 2026-04-24

## Context

MYR network yield was distributed and retrieved without quality differentiation. All synced reports were treated equally regardless of source trust, freshness, downstream usage, or contradiction status. Recall search used only FTS relevance and a simple operator-rating boost. The reports listing endpoint served reports in chronological order without quality ranking.

This meant:
- Imported reports from unknown/untrusted peers ranked equally with verified local yield
- Stale reports received the same weight as recent contributions
- Reports that had been applied downstream (proving usefulness) got no advantage
- Contradicted reports were not penalized in retrieval or distribution
- No explainability — operators could not understand why specific yield was surfaced

## Decision

Implement a unified yield scoring module (`lib/yield-scoring.js`) that computes a composite relevance score for any MYR report, incorporating six weighted factors:

| Factor | Weight | Range | Source |
|--------|--------|-------|--------|
| Source trust | 0.30 | 0-1 | `computeDomainTrust()` from participation.js |
| Operator rating | 0.20 | 0-1 | Normalized from 1-5 scale |
| Freshness | 0.15 | 0-1 | Exponential decay, 30-day half-life |
| Confidence | 0.15 | 0-1 | Report's stated confidence |
| Application feedback | 0.10 | 0-1 | Count of downstream applications (diminishing returns) |
| Contradiction penalty | 0.10 | 0-1 | Reduces score per active contradiction |

**Composite formula:** `score = sum(weight_i * factor_i) - contradiction_weight * penalty`

### Integration points

1. **Recall (lib/recall.js)**: All FTS and tag-based search results are now scored and sorted by composite yield score instead of raw FTS rank. New parameters: `explain` (boolean) for per-result explainability, `minScore` (float) for threshold filtering.

2. **Reports distribution (GET /myr/reports)**: Sync responses are now ranked by yield score descending. Higher-quality reports are served first, enabling bandwidth-constrained sync to get the most valuable content. Response includes `trust_weighted: true` and per-report `yield_score`.

3. **Explainability (GET /myr/reports/:reportId/explain)**: New endpoint returns structured explanation of why a report would be surfaced or withheld, including all scoring factors and human-readable reasons.

4. **Application feedback loop**: The existing `myr_applications` table (POST /myr/applications) now feeds directly into yield scoring. Reports with downstream applications receive higher scores. This creates a positive feedback loop where useful yield compounds.

### Design choices

- **No new database tables**: Scoring is computed at query time from existing tables (myr_reports, myr_applications, myr_contradictions, myr_peers). This avoids schema migration and cache invalidation complexity.
- **Deterministic scoring**: Same inputs always produce same score. No randomness or learned models.
- **Backward compatible**: Existing APIs return the same structure with additional fields. No breaking changes.
- **Freshness half-life of 30 days**: Chosen to match the participation system's recency window. Reports lose half their freshness score every 30 days.
- **Source trust uses domain trust**: Leverages the existing `computeDomainTrust()` which considers volume, rating, falsifications, and recency per domain per peer.

## Consequences

- Retrieval and distribution are now bounded, explainable, and trust-weighted
- Reports from untrusted/unknown peers score lower but are not excluded (threshold is configurable via `minScore`)
- Application feedback creates genuine compounding: useful yield gets surfaced more, generating more applications
- Contradicted yield is penalized but not hidden (operators can still access it)
- Scoring is computed per-query which adds ~1-2ms per report; acceptable for current scale

## Evidence

- 25 new tests in `test/yield-scoring.test.js` covering all scoring functions, ranking, explainability, and recall integration
- All 18 existing reports-list tests pass (ordering test updated to reflect score-based ranking)
- All 17 existing recall tests pass (backward compatible)
- All 3 existing subscription routing tests pass
- All 19 existing server tests pass
