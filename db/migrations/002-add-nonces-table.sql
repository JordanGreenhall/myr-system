-- Migration 002: Add nonces table for replay protection
-- Part of Phase 1.3: Authentication Middleware

CREATE TABLE IF NOT EXISTS myr_nonces (
  nonce TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nonces_expires ON myr_nonces(expires_at);
