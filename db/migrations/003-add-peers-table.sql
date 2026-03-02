-- Migration 003: Update peers table and reports for network protocol v0.3
-- Part of Phase 1.4: Report Listing Endpoint
--
-- The original myr_peers table used (node_id, node_name, public_key_format,
-- last_import_at, myr_count). The v0.3 protocol requires trust-level columns
-- and share_network on reports. This migration adds the missing columns;
-- the try/catch approach in scripts/db.js handles idempotency.

-- Reports: control per-report network visibility
ALTER TABLE myr_reports ADD COLUMN share_network INTEGER DEFAULT 0;

-- Peers: trust-based peer management
ALTER TABLE myr_peers ADD COLUMN peer_url TEXT;
ALTER TABLE myr_peers ADD COLUMN operator_name TEXT;
ALTER TABLE myr_peers ADD COLUMN trust_level TEXT DEFAULT 'pending';
ALTER TABLE myr_peers ADD COLUMN approved_at TEXT;
ALTER TABLE myr_peers ADD COLUMN last_sync_at TEXT;
ALTER TABLE myr_peers ADD COLUMN auto_sync INTEGER DEFAULT 1;
ALTER TABLE myr_peers ADD COLUMN notes TEXT;
