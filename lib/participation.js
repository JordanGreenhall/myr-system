'use strict';

/**
 * Progressive participation stages for MYR network nodes.
 *
 * Four stages, each with explicit capabilities, restrictions,
 * promotion criteria, and containment/rollback behavior.
 *
 * Trust is domain-qualified: a peer may be trusted in "networking"
 * but not yet in "cryptography". Global stage is the minimum floor.
 */

// --- Stage definitions ---

const STAGES = {
  'local-only': {
    order: 0,
    label: 'Local Only',
    description: 'Node operates as a personal intelligence machine. No network sync.',
    capabilities: {
      canReceiveYield: false,
      canSendYield: false,
      canSync: false,
      canRelay: false,
      canDiscover: true,    // Can discover peers via DHT
      canAnnounce: true,    // Can announce identity
      canIntroduce: true,   // Can send/receive introductions
      maxSyncPeers: 0,
      visibleToNetwork: false,
    },
    restrictions: [
      'Cannot send or receive yield',
      'Cannot participate in sync',
      'Cannot relay for others',
    ],
  },
  'provisional': {
    order: 1,
    label: 'Provisional Participant',
    description: 'First peer connection. Can receive yield, limited sending.',
    capabilities: {
      canReceiveYield: true,
      canSendYield: true,
      canSync: true,
      canRelay: false,
      canDiscover: true,
      canAnnounce: true,
      canIntroduce: true,
      maxSyncPeers: 3,         // Limited peer count
      visibleToNetwork: true,
    },
    restrictions: [
      'Max 3 sync peers',
      'Cannot relay for others',
      'Yield subject to higher scrutiny by receivers',
      'Rate-limited sync (max 1 sync per hour)',
    ],
  },
  'bounded': {
    order: 2,
    label: 'Bounded Contributor',
    description: 'Trusted by 3+ peers. Bidirectional sync with DHT active.',
    capabilities: {
      canReceiveYield: true,
      canSendYield: true,
      canSync: true,
      canRelay: true,          // Can relay for trusted peers
      canDiscover: true,
      canAnnounce: true,
      canIntroduce: true,
      maxSyncPeers: 20,
      visibleToNetwork: true,
    },
    restrictions: [
      'Max 20 sync peers',
      'Relay only between mutually trusted peers',
    ],
  },
  'trusted-full': {
    order: 3,
    label: 'Trusted Full Participant',
    description: 'Deep coupling. Cross-cluster synthesis, unrestricted routing.',
    capabilities: {
      canReceiveYield: true,
      canSendYield: true,
      canSync: true,
      canRelay: true,
      canDiscover: true,
      canAnnounce: true,
      canIntroduce: true,
      maxSyncPeers: Infinity,
      visibleToNetwork: true,
    },
    restrictions: [],
  },
};

// --- Promotion criteria ---

const PROMOTION_CRITERIA = {
  // local-only → provisional
  'local-only→provisional': {
    description: 'First mutual peer approval',
    check(peerStats) {
      return peerStats.mutualApprovals >= 1;
    },
  },
  // provisional → bounded
  'provisional→bounded': {
    description: 'Trusted by 3+ peers, 10+ shared MYRs, avg rating ≥ 3.0',
    check(peerStats) {
      return (
        peerStats.mutualApprovals >= 3 &&
        peerStats.sharedMyrCount >= 10 &&
        peerStats.avgRating >= 3.0
      );
    },
  },
  // bounded → trusted-full
  'bounded→trusted-full': {
    description: '10+ peers, 50+ shared MYRs, avg rating ≥ 3.5, 30+ days active, 0 rejections in last 30 days',
    check(peerStats) {
      return (
        peerStats.mutualApprovals >= 10 &&
        peerStats.sharedMyrCount >= 50 &&
        peerStats.avgRating >= 3.5 &&
        peerStats.activeDays >= 30 &&
        peerStats.recentRejections === 0
      );
    },
  },
};

const STAGE_SEQUENCE = ['local-only', 'provisional', 'bounded', 'trusted-full'];

const PROMOTION_CHECKS = {
  'local-only→provisional': [
    { id: 'mutualApprovals', label: 'trusted peer approvals', required: 1, comparator: '>=' },
  ],
  'provisional→bounded': [
    { id: 'mutualApprovals', label: 'trusted peer approvals', required: 3, comparator: '>=' },
    { id: 'sharedMyrCount', label: 'shared MYR reports', required: 10, comparator: '>=' },
    { id: 'avgRating', label: 'average operator rating', required: 3.0, comparator: '>=' },
  ],
  'bounded→trusted-full': [
    { id: 'mutualApprovals', label: 'trusted peer approvals', required: 10, comparator: '>=' },
    { id: 'sharedMyrCount', label: 'shared MYR reports', required: 50, comparator: '>=' },
    { id: 'avgRating', label: 'average operator rating', required: 3.5, comparator: '>=' },
    { id: 'activeDays', label: 'active days', required: 30, comparator: '>=' },
    { id: 'recentRejections', label: 'recent rejections', required: 0, comparator: '==' },
  ],
};

// --- Demotion triggers ---

const DEMOTION_TRIGGERS = {
  // trusted-full → bounded
  'trusted-full→bounded': {
    description: 'Rejection rate > 10% in trailing window, or 3+ consecutive rejected syncs',
    check(peerStats) {
      return (
        peerStats.recentRejectionRate > 0.10 ||
        peerStats.consecutiveRejectedSyncs >= 3
      );
    },
  },
  // bounded → provisional
  'bounded→provisional': {
    description: 'Mutual approvals drop below 3, or avg rating drops below 2.5',
    check(peerStats) {
      return (
        peerStats.mutualApprovals < 3 ||
        peerStats.avgRating < 2.5
      );
    },
  },
  // provisional → local-only
  'provisional→local-only': {
    description: 'All peers revoked or rejected, or zero mutual approvals',
    check(peerStats) {
      return peerStats.mutualApprovals === 0;
    },
  },
};

// --- Domain trust ---

/**
 * Domain trust score for a specific peer in a specific domain.
 * Range: 0.0 (no trust) to 1.0 (full trust).
 *
 * Computed from:
 *   - Number of verified MYRs in that domain from this peer
 *   - Average rating of those MYRs
 *   - Whether any falsifications from this peer were confirmed
 *   - Recency of contributions
 */
function computeDomainTrust(db, peerNodeId, domain) {
  // Count MYRs from this peer in this domain
  const domainMYRs = db.prepare(`
    SELECT COUNT(*) as cnt,
      AVG(operator_rating) as avg_rating,
      MAX(created_at) as last_contribution
    FROM myr_reports
    WHERE imported_from = ?
      AND LOWER(domain_tags) LIKE ?
      AND operator_rating IS NOT NULL
  `).get(peerNodeId, `%${domain.toLowerCase()}%`);

  if (!domainMYRs || domainMYRs.cnt === 0) {
    return { score: 0, evidence: 'no verified contributions in this domain' };
  }

  const count = domainMYRs.cnt;
  const avgRating = domainMYRs.avg_rating || 0;
  const lastContribution = domainMYRs.last_contribution;

  // Count confirmed falsifications (high value)
  const falsifications = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM myr_reports
    WHERE imported_from = ?
      AND LOWER(domain_tags) LIKE ?
      AND yield_type = 'falsification'
      AND operator_rating >= 3
  `).get(peerNodeId, `%${domain.toLowerCase()}%`);

  const falsCount = falsifications ? falsifications.cnt : 0;

  // Score computation:
  // Base: min(count / 20, 0.5)  — contribution volume caps at 0.5
  // Rating: (avgRating / 5) * 0.3 — quality contributes 0.3
  // Falsifications: min(falsCount / 5, 0.1) — high-value contributions
  // Recency: 0.1 if contributed in last 30 days, else 0
  const volumeScore = Math.min(count / 20, 0.5);
  const ratingScore = (avgRating / 5) * 0.3;
  const falsScore = Math.min(falsCount / 5, 0.1);

  let recencyScore = 0;
  if (lastContribution) {
    const daysSince = (Date.now() - new Date(lastContribution).getTime()) / (1000 * 60 * 60 * 24);
    recencyScore = daysSince <= 30 ? 0.1 : 0;
  }

  const score = Math.min(1, volumeScore + ratingScore + falsScore + recencyScore);

  return {
    score: Math.round(score * 100) / 100,
    evidence: `${count} verified MYRs, avg rating ${avgRating.toFixed(1)}, ${falsCount} falsifications`,
    count,
    avgRating: Math.round(avgRating * 100) / 100,
    falsifications: falsCount,
    lastContribution,
  };
}

/**
 * Get all domain trust scores for a peer.
 */
function getPeerDomainTrust(db, peerNodeId) {
  // Get all unique domains from this peer's imports
  const rows = db.prepare(`
    SELECT DISTINCT domain_tags
    FROM myr_reports
    WHERE imported_from = ?
  `).all(peerNodeId);

  const domains = new Set();
  for (const row of rows) {
    try {
      const tags = JSON.parse(row.domain_tags || '[]');
      tags.forEach(t => domains.add(t.toLowerCase()));
    } catch (_) { /* skip malformed tags */ }
  }

  const result = {};
  for (const domain of domains) {
    result[domain] = computeDomainTrust(db, peerNodeId, domain);
  }
  return result;
}

// --- Stage computation ---

/**
 * Gather stats needed for promotion/demotion checks.
 */
function gatherPeerStats(db, peerPublicKey) {
  // Count mutual approvals (peers where we trust them AND they trust us)
  const mutualApprovals = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM myr_peers
    WHERE trust_level = 'trusted'
  `).get().cnt;

  // Shared MYR count
  const sharedMyrCount = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM myr_reports
    WHERE share_network = 1
  `).get().cnt;

  // Average rating
  const ratingRow = db.prepare(`
    SELECT AVG(operator_rating) as avg
    FROM myr_reports
    WHERE operator_rating IS NOT NULL
  `).get();
  const avgRating = ratingRow && ratingRow.avg !== null ? ratingRow.avg : 0;

  // Active days (days since first MYR)
  const firstMyr = db.prepare(`
    SELECT MIN(created_at) as first
    FROM myr_reports
  `).get();
  let activeDays = 0;
  if (firstMyr && firstMyr.first) {
    activeDays = Math.floor((Date.now() - new Date(firstMyr.first).getTime()) / (1000 * 60 * 60 * 24));
  }

  // Recent rejections (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recentRejections = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM myr_traces
    WHERE event_type IN ('reject', 'verify')
      AND outcome = 'rejected'
      AND timestamp > ?
  `).get(thirtyDaysAgo).cnt;

  // Recent rejection rate
  const recentTotal = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM myr_traces
    WHERE event_type IN ('reject', 'verify', 'sync_pull', 'sync_push')
      AND timestamp > ?
  `).get(thirtyDaysAgo).cnt;
  const recentRejectionRate = recentTotal > 0 ? recentRejections / recentTotal : 0;

  // Consecutive rejected syncs
  const recentSyncs = db.prepare(`
    SELECT outcome
    FROM myr_traces
    WHERE event_type IN ('sync_pull', 'sync_push')
    ORDER BY timestamp DESC
    LIMIT 10
  `).all();
  let consecutiveRejectedSyncs = 0;
  for (const sync of recentSyncs) {
    if (sync.outcome === 'rejected' || sync.outcome === 'failure') {
      consecutiveRejectedSyncs++;
    } else {
      break;
    }
  }

  return {
    mutualApprovals,
    sharedMyrCount,
    avgRating,
    activeDays,
    recentRejections,
    recentRejectionRate,
    consecutiveRejectedSyncs,
  };
}

/**
 * Compute the appropriate participation stage for a peer.
 * Returns the stage name and promotion/demotion evidence.
 */
function computeStage(db, peerPublicKey, currentStage) {
  const stats = gatherPeerStats(db, peerPublicKey);
  const currentIdx = STAGE_SEQUENCE.indexOf(currentStage || 'local-only');

  // Check promotion (one level at a time)
  if (currentIdx < STAGE_SEQUENCE.length - 1) {
    const nextStage = STAGE_SEQUENCE[currentIdx + 1];
    const key = `${currentStage || 'local-only'}→${nextStage}`;
    const criteria = PROMOTION_CRITERIA[key];
    if (criteria && criteria.check(stats)) {
      return {
        stage: nextStage,
        action: 'promote',
        reason: criteria.description,
        stats,
      };
    }
  }

  // Check demotion (one level at a time)
  if (currentIdx > 0) {
    const prevStage = STAGE_SEQUENCE[currentIdx - 1];
    const key = `${currentStage}→${prevStage}`;
    const trigger = DEMOTION_TRIGGERS[key];
    if (trigger && trigger.check(stats)) {
      return {
        stage: prevStage,
        action: 'demote',
        reason: trigger.description,
        stats,
      };
    }
  }

  return { stage: currentStage || 'local-only', action: 'hold', reason: 'No promotion or demotion criteria met', stats };
}

function evaluateCheck(check, stats) {
  const current = Number(stats[check.id] || 0);
  const required = Number(check.required);
  const met = check.comparator === '=='
    ? current === required
    : current >= required;
  const shortfall = met ? 0 : Math.max(0, required - current);

  return {
    id: check.id,
    label: check.label,
    comparator: check.comparator,
    required,
    current,
    met,
    shortfall,
  };
}

function formatActionableGuidance(checkResult) {
  if (checkResult.met) return null;

  switch (checkResult.id) {
    case 'mutualApprovals':
      return `Add ${checkResult.shortfall} more trusted peer approval${checkResult.shortfall === 1 ? '' : 's'}.`;
    case 'sharedMyrCount':
      return `Share ${checkResult.shortfall} more MYR report${checkResult.shortfall === 1 ? '' : 's'} with the network.`;
    case 'avgRating':
      return `Improve average operator rating by ${checkResult.shortfall.toFixed(1)} point${checkResult.shortfall.toFixed(1) === '1.0' ? '' : 's'}.`;
    case 'activeDays':
      return `Stay active for ${checkResult.shortfall} more day${checkResult.shortfall === 1 ? '' : 's'}.`;
    case 'recentRejections':
      return 'Clear recent rejections to qualify for the next stage.';
    default:
      return null;
  }
}

function getStageProgress(stageName, stats) {
  const stageKey = STAGES[stageName] ? stageName : 'local-only';
  const stageDef = STAGES[stageKey];
  const currentIdx = STAGE_SEQUENCE.indexOf(stageKey);
  const nextStageKey = currentIdx >= 0 && currentIdx < STAGE_SEQUENCE.length - 1
    ? STAGE_SEQUENCE[currentIdx + 1]
    : null;

  const minimumViable = {
    met: !!(stageDef.capabilities.canSync && stageDef.capabilities.canReceiveYield),
    description: 'Can sync with peers and receive network yield.',
  };

  if (!nextStageKey) {
    return {
      current: {
        key: stageKey,
        label: stageDef.label,
        description: stageDef.description,
      },
      minimumViable,
      nextStage: null,
      progress: {
        totalChecks: 0,
        metChecks: 0,
        percent: 100,
      },
      guidance: ['Maximum participation stage reached.'],
    };
  }

  const criteriaKey = `${stageKey}→${nextStageKey}`;
  const checks = (PROMOTION_CHECKS[criteriaKey] || []).map((check) => evaluateCheck(check, stats));
  const metChecks = checks.filter((check) => check.met).length;
  const totalChecks = checks.length;
  const percent = totalChecks > 0 ? Math.round((metChecks / totalChecks) * 100) : 0;
  const unmet = checks.filter((check) => !check.met);
  const guidance = unmet.map((check) => formatActionableGuidance(check)).filter(Boolean);

  return {
    current: {
      key: stageKey,
      label: stageDef.label,
      description: stageDef.description,
    },
    minimumViable,
    nextStage: {
      key: nextStageKey,
      label: STAGES[nextStageKey].label,
      criteria: PROMOTION_CRITERIA[criteriaKey] ? PROMOTION_CRITERIA[criteriaKey].description : null,
    },
    progress: {
      totalChecks,
      metChecks,
      percent,
      checks,
    },
    guidance: guidance.length > 0 ? guidance : ['All checks met. Stage promotion is eligible on next evaluation.'],
  };
}

/**
 * Check if a peer's participation stage allows a specific capability.
 */
function hasCapability(stage, capability) {
  const def = STAGES[stage];
  if (!def) return false;
  return !!def.capabilities[capability];
}

/**
 * Get the full stage definition for a stage name.
 */
function getStage(stageName) {
  return STAGES[stageName] || null;
}

/**
 * Get the stage order index (0-3).
 */
function stageOrder(stageName) {
  const def = STAGES[stageName];
  return def ? def.order : -1;
}

/**
 * Enforce participation stage for a server request.
 * Returns { allowed, stage, reason } or null if peer not found.
 */
function enforceStage(db, peerPublicKey, requiredCapability) {
  let peer;
  try {
    peer = db.prepare(
      'SELECT trust_level, participation_stage FROM myr_peers WHERE public_key = ?'
    ).get(peerPublicKey);
  } catch (_) {
    // Fallback for DBs without participation_stage column
    peer = db.prepare(
      'SELECT trust_level FROM myr_peers WHERE public_key = ?'
    ).get(peerPublicKey);
  }

  if (!peer) return null;

  const stage = peer.participation_stage || 'local-only';

  // Legacy compat: if trust_level is 'trusted' and no stage set, treat as 'provisional'
  const effectiveStage = stage === 'local-only' && peer.trust_level === 'trusted'
    ? 'provisional'
    : stage;

  const allowed = hasCapability(effectiveStage, requiredCapability);

  return {
    allowed,
    stage: effectiveStage,
    reason: allowed
      ? null
      : `Stage '${effectiveStage}' does not have capability '${requiredCapability}'`,
  };
}

module.exports = {
  STAGES,
  PROMOTION_CRITERIA,
  DEMOTION_TRIGGERS,
  computeDomainTrust,
  getPeerDomainTrust,
  gatherPeerStats,
  computeStage,
  getStageProgress,
  hasCapability,
  getStage,
  stageOrder,
  enforceStage,
};
