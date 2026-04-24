'use strict';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'does', 'for', 'from',
  'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'what', 'when', 'where', 'which', 'why', 'with',
]);

function normalizeDomain(domain) {
  if (!domain || typeof domain !== 'string') return null;
  const value = domain.trim().toLowerCase();
  return value || null;
}

function parseDomainTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
      }
    } catch {
      return raw.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean);
    }
  }
  return [];
}

function tokenizeQuestion(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return [];
  return normalized
    .split(' ')
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function isRelatedQuestion(questionA, questionB) {
  const tokensA = tokenizeQuestion(questionA);
  const tokensB = tokenizeQuestion(questionB);
  if (tokensA.length === 0 || tokensB.length === 0) return false;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  if (intersection === 0) return false;

  const unionSize = new Set([...setA, ...setB]).size;
  const jaccard = unionSize > 0 ? (intersection / unionSize) : 0;
  return jaccard >= 0.3 || intersection >= 2;
}

function confidenceDirection(confidence) {
  const value = Number(confidence);
  if (!Number.isFinite(value)) return 'neutral';
  if (value >= 0.67) return 'high';
  if (value <= 0.33) return 'low';
  return 'neutral';
}

function normalizePairIds(idA, idB) {
  return String(idA) <= String(idB) ? [String(idA), String(idB)] : [String(idB), String(idA)];
}

function ensureContradictionsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS myr_contradictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      yield_a_id TEXT NOT NULL,
      yield_b_id TEXT NOT NULL,
      domain_tag TEXT,
      contradiction_type TEXT NOT NULL CHECK(contradiction_type IN ('observation_vs_falsification','opposing_confidence')),
      details TEXT DEFAULT '{}',
      detected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_note TEXT,
      UNIQUE(yield_a_id, yield_b_id, contradiction_type, domain_tag)
    );
    CREATE INDEX IF NOT EXISTS idx_contradictions_domain ON myr_contradictions(domain_tag);
    CREATE INDEX IF NOT EXISTS idx_contradictions_updated ON myr_contradictions(updated_at DESC);
    CREATE TABLE IF NOT EXISTS myr_contradiction_resolutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contradiction_id INTEGER NOT NULL,
      resolved_at TEXT NOT NULL,
      resolved_by TEXT NOT NULL,
      resolution_note TEXT,
      resolution_signature TEXT,
      resolution_record TEXT NOT NULL,
      FOREIGN KEY(contradiction_id) REFERENCES myr_contradictions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_contradiction_resolutions_id ON myr_contradiction_resolutions(contradiction_id, resolved_at DESC);
  `);

  const columns = db.prepare('PRAGMA table_info(myr_contradictions)').all();
  const columnSet = new Set(columns.map((column) => column.name));
  if (!columnSet.has('resolved_at')) {
    db.exec('ALTER TABLE myr_contradictions ADD COLUMN resolved_at TEXT');
  }
  if (!columnSet.has('resolved_by')) {
    db.exec('ALTER TABLE myr_contradictions ADD COLUMN resolved_by TEXT');
  }
  if (!columnSet.has('resolution_note')) {
    db.exec('ALTER TABLE myr_contradictions ADD COLUMN resolution_note TEXT');
  }
}

function getStoredContradictions(db, domain, { includeResolved = false } = {}) {
  ensureContradictionsSchema(db);
  const normalizedDomain = normalizeDomain(domain);
  const resolvedClause = includeResolved ? '' : 'AND c.resolved_at IS NULL';
  if (normalizedDomain) {
    return db.prepare(`
      SELECT
        c.id,
        c.yield_a_id,
        c.yield_b_id,
        c.domain_tag,
        c.contradiction_type,
        c.details,
        c.detected_at,
        c.updated_at,
        c.resolved_at,
        c.resolved_by,
        c.resolution_note
      FROM myr_contradictions c
      WHERE c.domain_tag = ?
      ${resolvedClause}
      ORDER BY c.updated_at DESC, c.id DESC
    `).all(normalizedDomain);
  }
  return db.prepare(`
    SELECT
      c.id,
      c.yield_a_id,
      c.yield_b_id,
      c.domain_tag,
      c.contradiction_type,
      c.details,
      c.detected_at,
      c.updated_at,
      c.resolved_at,
      c.resolved_by,
      c.resolution_note
    FROM myr_contradictions c
    WHERE 1=1
    ${resolvedClause}
    ORDER BY c.updated_at DESC, c.id DESC
  `).all();
}

function detectContradictions(db, { domain = null } = {}) {
  ensureContradictionsSchema(db);
  const normalizedDomain = normalizeDomain(domain);
  const rows = db.prepare(`
    SELECT
      id,
      node_id,
      yield_type,
      domain_tags,
      question_answered,
      confidence,
      created_at
    FROM myr_reports
    ORDER BY created_at ASC
  `).all();

  const upsert = db.prepare(`
    INSERT INTO myr_contradictions (
      yield_a_id,
      yield_b_id,
      domain_tag,
      contradiction_type,
      details,
      detected_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(yield_a_id, yield_b_id, contradiction_type, domain_tag) DO UPDATE SET
      details = excluded.details,
      updated_at = excluded.updated_at,
      resolved_at = NULL,
      resolved_by = NULL,
      resolution_note = NULL
  `);

  let detectedCount = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < rows.length; i++) {
    const left = rows[i];
    const leftTags = parseDomainTags(left.domain_tags);
    const leftTagSet = new Set(leftTags);

    for (let j = i + 1; j < rows.length; j++) {
      const right = rows[j];
      const rightTags = parseDomainTags(right.domain_tags);
      const overlap = [...leftTagSet].filter((tag) => rightTags.includes(tag));
      if (overlap.length === 0) continue;
      if (normalizedDomain && !overlap.includes(normalizedDomain)) continue;
      if (!isRelatedQuestion(left.question_answered, right.question_answered)) continue;

      const domainTag = normalizedDomain || overlap[0];
      const [yieldA, yieldB] = normalizePairIds(left.id, right.id);
      const leftType = String(left.yield_type || '').toLowerCase();
      const rightType = String(right.yield_type || '').toLowerCase();

      const hasFalsification = leftType === 'falsification' || rightType === 'falsification';
      const hasObservation = leftType !== 'falsification' || rightType !== 'falsification';

      if (hasFalsification && hasObservation) {
        const details = {
          overlap_tags: overlap,
          node_ids: [left.node_id, right.node_id],
          question_pair: [left.question_answered, right.question_answered],
          yield_types: [left.yield_type, right.yield_type],
        };
        upsert.run(
          yieldA,
          yieldB,
          domainTag,
          'observation_vs_falsification',
          JSON.stringify(details),
          now,
          now
        );
        detectedCount++;
      }

      const leftDirection = confidenceDirection(left.confidence);
      const rightDirection = confidenceDirection(right.confidence);
      const opposingDirections = (
        (leftDirection === 'high' && rightDirection === 'low') ||
        (leftDirection === 'low' && rightDirection === 'high')
      );

      if (opposingDirections) {
        const details = {
          overlap_tags: overlap,
          node_ids: [left.node_id, right.node_id],
          question_pair: [left.question_answered, right.question_answered],
          confidence_pair: [left.confidence, right.confidence],
          confidence_direction_pair: [leftDirection, rightDirection],
        };
        upsert.run(
          yieldA,
          yieldB,
          domainTag,
          'opposing_confidence',
          JSON.stringify(details),
          now,
          now
        );
        detectedCount++;
      }
    }
  }

  return {
    scannedReports: rows.length,
    detectedCount,
    contradictions: getStoredContradictions(db, normalizedDomain, { includeResolved: false }),
  };
}

function resolveContradiction(
  db,
  {
    contradictionId,
    resolvedBy,
    resolutionNote = null,
    resolutionSignature = null,
    resolvedAt = null,
  }
) {
  ensureContradictionsSchema(db);
  const id = Number(contradictionId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid contradictionId');
  }
  if (!resolvedBy || typeof resolvedBy !== 'string') {
    throw new Error('resolvedBy is required');
  }
  const existing = db.prepare('SELECT * FROM myr_contradictions WHERE id = ?').get(id);
  if (!existing) {
    return null;
  }

  const now = resolvedAt || new Date().toISOString();
  const record = JSON.stringify({
    contradiction_id: id,
    yield_a_id: existing.yield_a_id,
    yield_b_id: existing.yield_b_id,
    contradiction_type: existing.contradiction_type,
    domain_tag: existing.domain_tag || null,
    resolved_at: now,
    resolved_by: resolvedBy,
    resolution_note: resolutionNote || null,
  });

  db.prepare(`
    UPDATE myr_contradictions
    SET resolved_at = ?, resolved_by = ?, resolution_note = ?, updated_at = ?
    WHERE id = ?
  `).run(now, resolvedBy, resolutionNote, now, id);

  db.prepare(`
    INSERT INTO myr_contradiction_resolutions (
      contradiction_id,
      resolved_at,
      resolved_by,
      resolution_note,
      resolution_signature,
      resolution_record
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, now, resolvedBy, resolutionNote, resolutionSignature, record);

  return db.prepare('SELECT * FROM myr_contradictions WHERE id = ?').get(id);
}

function listContradictionResolutions(db, { limit = 200, contradictionId = null } = {}) {
  ensureContradictionsSchema(db);
  const bounded = Math.max(1, Math.min(Number(limit) || 200, 2000));
  if (contradictionId) {
    return db.prepare(`
      SELECT *
      FROM myr_contradiction_resolutions
      WHERE contradiction_id = ?
      ORDER BY resolved_at DESC, id DESC
      LIMIT ?
    `).all(Number(contradictionId), bounded);
  }
  return db.prepare(`
    SELECT *
    FROM myr_contradiction_resolutions
    ORDER BY resolved_at DESC, id DESC
    LIMIT ?
  `).all(bounded);
}

module.exports = {
  ensureContradictionsSchema,
  detectContradictions,
  getStoredContradictions,
  resolveContradiction,
  listContradictionResolutions,
  normalizeDomain,
  parseDomainTags,
};
