'use strict';

/**
 * Database loader for home-dir-based myr configuration.
 * Uses the same schema as scripts/db.js but resolves paths from ~/.myr/.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function getHomeDb(config) {
  const dbPath = config.db_path;
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  ensureSchema(db);

  return db;
}

function ensureSchema(db) {
  db.exec(`
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      imported_from TEXT,
      signed_artifact TEXT,
      import_verified INTEGER DEFAULT 0,
      auto_draft INTEGER DEFAULT 0,
      source_memory_id INTEGER,
      share_network INTEGER DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS myr_peers (
      public_key TEXT PRIMARY KEY,
      peer_url TEXT,
      operator_name TEXT,
      trust_level TEXT DEFAULT 'pending',
      added_at TEXT NOT NULL,
      approved_at TEXT,
      last_sync_at TEXT,
      auto_sync INTEGER DEFAULT 1,
      notes TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS myr_nonces (
      nonce TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nonces_expires ON myr_nonces(expires_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS myr_traces (
      trace_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('introduce','approve','share','sync_pull','sync_push','verify','reject')),
      actor_fingerprint TEXT NOT NULL,
      target_fingerprint TEXT,
      artifact_signature TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','rejected')),
      rejection_reason TEXT,
      metadata TEXT
    );
  `);
}

module.exports = { getHomeDb };
