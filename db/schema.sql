-- MYR Database Schema (v1.2.0)
-- Canonical schema for myr-system. Apply migrations for upgrades from prior versions.

CREATE TABLE IF NOT EXISTS myr_reports (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  session_ref TEXT,

  cycle_intent TEXT NOT NULL,
  domain_tags TEXT NOT NULL,
  cycle_context TEXT,

  yield_type TEXT NOT NULL CHECK(yield_type IN ('technique','insight','falsification','pattern')),
  question_answered TEXT NOT NULL,
  evidence TEXT NOT NULL,
  what_changes_next TEXT NOT NULL,
  what_was_falsified TEXT,
  transferable_to TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,

  operator_rating INTEGER,
  operator_notes TEXT,
  verified_at TEXT,

  signed_by TEXT,
  shared_with TEXT,
  synthesis_id TEXT,

  imported_from TEXT,
  signed_artifact TEXT,
  import_verified INTEGER DEFAULT 0,
  auto_draft INTEGER DEFAULT 0,
  source_memory_id INTEGER,
  share_network INTEGER DEFAULT 0,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Full-text search index for reports
CREATE VIRTUAL TABLE IF NOT EXISTS myr_fts USING fts5(
  id,
  cycle_intent,
  cycle_context,
  question_answered,
  evidence,
  what_changes_next,
  what_was_falsified,
  domain_tags,
  content=myr_reports,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS myr_fts_insert AFTER INSERT ON myr_reports BEGIN
  INSERT INTO myr_fts(rowid, id, cycle_intent, cycle_context, question_answered, evidence, what_changes_next, what_was_falsified, domain_tags)
  VALUES (new.rowid, new.id, new.cycle_intent, new.cycle_context, new.question_answered, new.evidence, new.what_changes_next, new.what_was_falsified, new.domain_tags);
END;

CREATE TRIGGER IF NOT EXISTS myr_fts_delete AFTER DELETE ON myr_reports BEGIN
  INSERT INTO myr_fts(myr_fts, rowid, id, cycle_intent, cycle_context, question_answered, evidence, what_changes_next, what_was_falsified, domain_tags)
  VALUES ('delete', old.rowid, old.id, old.cycle_intent, old.cycle_context, old.question_answered, old.evidence, old.what_changes_next, old.what_was_falsified, old.domain_tags);
END;

CREATE TRIGGER IF NOT EXISTS myr_fts_update AFTER UPDATE ON myr_reports BEGIN
  INSERT INTO myr_fts(myr_fts, rowid, id, cycle_intent, cycle_context, question_answered, evidence, what_changes_next, what_was_falsified, domain_tags)
  VALUES ('delete', old.rowid, old.id, old.cycle_intent, old.cycle_context, old.question_answered, old.evidence, old.what_changes_next, old.what_was_falsified, old.domain_tags);
  INSERT INTO myr_fts(rowid, id, cycle_intent, cycle_context, question_answered, evidence, what_changes_next, what_was_falsified, domain_tags)
  VALUES (new.rowid, new.id, new.cycle_intent, new.cycle_context, new.question_answered, new.evidence, new.what_changes_next, new.what_was_falsified, new.domain_tags);
END;

CREATE TABLE IF NOT EXISTS myr_syntheses (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  source_myr_ids TEXT NOT NULL,
  node_ids TEXT NOT NULL,
  domain_tags TEXT NOT NULL,
  synthesis_text TEXT NOT NULL,
  signed_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS myr_peers (
  node_id TEXT PRIMARY KEY,
  node_name TEXT,
  public_key TEXT NOT NULL,
  public_key_format TEXT DEFAULT 'pem',
  added_at TEXT NOT NULL,
  last_import_at TEXT,
  myr_count INTEGER DEFAULT 0,
  peer_url TEXT,
  operator_name TEXT,
  trust_level TEXT DEFAULT 'pending',
  approved_at TEXT,
  last_sync_at TEXT,
  auto_sync INTEGER DEFAULT 1,
  notes TEXT,
  -- v1.2.0 columns
  node_uuid TEXT,
  verification_evidence TEXT,
  auto_approved INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS myr_nonces (
  nonce TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nonces_expires ON myr_nonces(expires_at);

CREATE TABLE IF NOT EXISTS myr_traces (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_key TEXT,
  peer_name TEXT,
  artifact_sig TEXT,
  outcome TEXT NOT NULL,
  rejection_reason TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON myr_traces(timestamp);
CREATE INDEX IF NOT EXISTS idx_traces_event_type ON myr_traces(event_type);

CREATE TABLE IF NOT EXISTS myr_contradictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  yield_a_id TEXT NOT NULL,
  yield_b_id TEXT NOT NULL,
  domain_tag TEXT,
  contradiction_type TEXT NOT NULL CHECK(contradiction_type IN ('observation_vs_falsification','opposing_confidence')),
  details TEXT DEFAULT '{}',
  detected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(yield_a_id, yield_b_id, contradiction_type, domain_tag)
);

CREATE INDEX IF NOT EXISTS idx_contradictions_domain ON myr_contradictions(domain_tag);
CREATE INDEX IF NOT EXISTS idx_contradictions_updated ON myr_contradictions(updated_at DESC);

CREATE TABLE IF NOT EXISTS myr_applications (
  id TEXT PRIMARY KEY,
  source_yield_id TEXT NOT NULL,
  applied_by_node_id TEXT NOT NULL,
  downstream_use TEXT NOT NULL,
  outcome TEXT,
  applied_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  signed_by TEXT NOT NULL,
  signature TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_applications_source ON myr_applications(source_yield_id);
CREATE INDEX IF NOT EXISTS idx_applications_created ON myr_applications(created_at DESC);

CREATE TABLE IF NOT EXISTS myr_subscriptions (
  signal_id TEXT PRIMARY KEY,
  owner_public_key TEXT NOT NULL,
  owner_fingerprint TEXT NOT NULL,
  owner_operator_name TEXT,
  tags_json TEXT NOT NULL,
  intent_description TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local','remote')),
  signal_signature TEXT NOT NULL,
  last_received_from TEXT,
  hops_remaining INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_owner_status
  ON myr_subscriptions(owner_public_key, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_updated
  ON myr_subscriptions(updated_at DESC);
