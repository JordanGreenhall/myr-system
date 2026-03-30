-- Migration 004: Add columns for v1.2.0 in-band fingerprint verification
-- Adds node_uuid, verification_evidence, and auto_approved to myr_peers

ALTER TABLE myr_peers ADD COLUMN node_uuid TEXT;
ALTER TABLE myr_peers ADD COLUMN verification_evidence TEXT;
ALTER TABLE myr_peers ADD COLUMN auto_approved INTEGER DEFAULT 0;
