'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

function getDb() {
  const dbDir = path.dirname(config.db_path);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(config.db_path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  ensureSchema(db);
  migratePhase2Columns(db);
  migrateOperatorColumns(db);
  migrateIdScheme(db);

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
      updated_at TEXT NOT NULL
    );
  `);

  const ftsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='myr_fts'"
  ).get();

  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE myr_fts USING fts5(
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
    `);
  }

  db.exec(`
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
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS myr_peers (
      node_id TEXT PRIMARY KEY,
      node_name TEXT,
      public_key TEXT NOT NULL,
      public_key_format TEXT DEFAULT 'pem',
      added_at TEXT NOT NULL,
      last_import_at TEXT,
      myr_count INTEGER DEFAULT 0
    );
  `);
}

function migratePhase2Columns(db) {
  const addColumn = (table, col, typedef) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${typedef}`);
    } catch (_) {
      // column already exists
    }
  };

  addColumn('myr_reports', 'imported_from', 'TEXT');
  addColumn('myr_reports', 'signed_artifact', 'TEXT');
  addColumn('myr_reports', 'import_verified', 'INTEGER DEFAULT 0');
  addColumn('myr_reports', 'auto_draft', 'INTEGER DEFAULT 0');
  addColumn('myr_reports', 'source_memory_id', 'INTEGER');
}

function migrateOperatorColumns(db) {
  // Rename jordan_rating -> operator_rating and jordan_notes -> operator_notes
  const cols = db.prepare("PRAGMA table_info(myr_reports)").all();
  const hasJordanRating = cols.some(c => c.name === 'jordan_rating');
  const hasOperatorRating = cols.some(c => c.name === 'operator_rating');

  if (hasJordanRating && !hasOperatorRating) {
    db.exec('ALTER TABLE myr_reports RENAME COLUMN jordan_rating TO operator_rating');
    db.exec('ALTER TABLE myr_reports RENAME COLUMN jordan_notes TO operator_notes');
    console.log('Migrated jordan_rating/jordan_notes -> operator_rating/operator_notes.');
  }
}

function migrateIdScheme(db) {
  const oldRows = db.prepare(
    "SELECT id FROM myr_reports WHERE id LIKE 'myr-%'"
  ).all();

  if (oldRows.length === 0) return;

  const nodeId = config.node_id;
  const update = db.prepare('UPDATE myr_reports SET id = ?, node_id = ? WHERE id = ?');
  const updateFts = db.prepare('UPDATE myr_fts SET id = ? WHERE id = ?');

  const migrate = db.transaction(() => {
    for (const row of oldRows) {
      const old = row.id;
      // myr-YYYY-MM-DD-SEQ -> {node_id}-YYYYMMDD-SEQ
      const match = old.match(/^myr-(\d{4})-(\d{2})-(\d{2})-(\d{3})$/);
      if (!match) continue;
      const newId = `${nodeId}-${match[1]}${match[2]}${match[3]}-${match[4]}`;
      update.run(newId, nodeId, old);
      try { updateFts.run(newId, old); } catch (_) { /* fts may not have direct update */ }
    }
  });

  migrate();

  // Rebuild FTS index after ID migration
  try {
    db.exec("INSERT INTO myr_fts(myr_fts) VALUES('rebuild')");
  } catch (_) {
    // ignore if rebuild fails
  }

  console.log(`Migrated ${oldRows.length} record(s) from myr-YYYY-MM-DD to ${nodeId}-YYYYMMDD format.`);
}

function generateId(db) {
  const nodeId = config.node_id;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `${nodeId}-${today}-`;

  const row = db.prepare(
    "SELECT id FROM myr_reports WHERE id LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(`${prefix}%`);

  let seq = 1;
  if (row) {
    const lastSeq = parseInt(row.id.split('-').pop(), 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}${String(seq).padStart(3, '0')}`;
}

module.exports = { getDb, generateId, config };
