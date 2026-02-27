# MYR System — Phase 2 Specification
## Cross-Node Yield Compounding

**Status:** Greenlit 2026-02-26  
**Builds on:** Phase 1 (single-node capture, search, weekly, verify)

---

## Architecture Decisions (locked before build)

### 1. ID Scheme Fix

**Problem:** `myr-YYYY-MM-DD-001` collides on cross-node import.  
**Solution:** `{node_id}-{YYYYMMDD}-{seq}` — e.g., `n1-20260226-001`

- `node_id` set in config (short, e.g., `n1`, `n2`, `n3`)
- Date is compact (no dashes: `YYYYMMDD`)
- Seq is zero-padded 3 digits, resets per node per day
- Globally unique: no two nodes share the same `node_id`
- Migration: update existing test records to use `n1-` prefix

### 2. GitHub-First

The myr-system must be installable by nodes that are NOT on the same physical network.

**Requirements:**
- No hardcoded paths anywhere — all paths via env vars or config
- `config.json` (local, gitignored) for node-specific settings
- `config.example.json` (tracked) as the template
- Standalone install: `git clone {repo} && npm install && cp config.example.json config.json`
- README covers install story end-to-end

**Current home:** `https://github.com/JordanGreenhall/samuel-workspace` at `projects/starfighter/infrastructure/myr-system/`
**Future:** Extract to standalone repo when going fully multi-node.

### 3. Database Portability

**Now:** SQLite at path set by `MYR_DB_PATH` env var (default: `./db/myr.db`)  
**Later:** Turso/LibSQL as drop-in replacement when going distributed  
**Key insight:** The signed JSON artifact is the canonical portable unit. SQLite is a local cache/index. You can reconstruct the db from artifacts.

---

## Phase 2 Components

### Config System

`config.json` (gitignored, node-specific):
```json
{
  "node_id": "n1",
  "node_name": "Node 1 - Jordan/Polemarch",
  "db_path": "./db/myr.db",
  "keys_path": "./keys/",
  "export_path": "./exports/",
  "import_path": "./imports/",
  "peers": []
}
```

`config.example.json` (tracked):
```json
{
  "node_id": "nX",
  "node_name": "Node X - Name",
  "db_path": "./db/myr.db",
  "keys_path": "./keys/",
  "export_path": "./exports/",
  "import_path": "./imports/",
  "peers": []
}
```

Config resolution order: env vars > config.json > defaults

### scripts/myr-keygen.js
Generate Ed25519 keypair for this node.

```bash
node scripts/myr-keygen.js
# Writes: keys/node_id.private.pem, keys/node_id.public.pem
# keys/ dir is gitignored — never commit private keys
```

Output on stdout: public key (for sharing with peers).

### scripts/myr-sign.js
Sign a MYR report. Produces a signed artifact.

**Signed artifact format:**
```json
{
  "version": "1",
  "artifact_type": "myr",
  "payload": { ...full MYR report... },
  "signature": {
    "algorithm": "Ed25519",
    "node_id": "n1",
    "public_key": "base64-encoded-public-key",
    "signed_at": "ISO8601",
    "value": "base64-encoded-signature"
  }
}
```

The signature is over `JSON.stringify(payload)` (canonical, sorted keys).

```bash
node scripts/myr-sign.js --id n1-20260226-001
# Outputs signed artifact JSON to stdout or --out file
```

### scripts/myr-export.js
Export signed MYR artifacts for sharing with peers.

```bash
node scripts/myr-export.js --all               # export all verified MYRs
node scripts/myr-export.js --since 2026-02-01  # export since date
node scripts/myr-export.js --ids "n1-...,n1-..." # specific IDs
# Output: ./exports/{timestamp}-{node_id}.myr.json (array of signed artifacts)
```

Only exports Jordan-verified MYRs (rating >= 3). Unverified yield stays local.

### scripts/myr-import.js
Verify and import signed artifacts from another node.

```bash
node scripts/myr-import.js --file ./imports/n2-20260226.myr.json
node scripts/myr-import.js --file ./imports/n2-20260226.myr.json --peer-key ./keys/n2.public.pem
```

**Verification steps:**
1. Check artifact version and structure
2. Verify Ed25519 signature against peer's public key
3. Check node_id matches key on file
4. Reject duplicates (id already exists in db)
5. Check for node_id collisions (reject if node_id conflicts with our own)
6. Write to db with `imported_from = source_node_id`

**On failure:** Print specific error, skip artifact, continue with rest.

### scripts/myr-synthesize.js
Find overlapping domains across nodes, produce composite yield.

```bash
node scripts/myr-synthesize.js --tags "starfighter,theory" --min-nodes 2
```

**Algorithm:**
1. Find all MYRs (local + imported) matching tag query
2. Group by domain cluster
3. For each cluster with contributions from ≥2 nodes:
   - Collect: all `question_answered`, `evidence`, `what_changes_next`, `what_was_falsified`
   - Identify: convergent findings (same answer from multiple nodes)
   - Identify: divergent findings (different answers — flag for human review)
   - Identify: unique contributions (only one node has this)
4. Output synthesis as Markdown report

**Synthesis report structure:**
- **Convergent findings** — confirmed by ≥2 nodes (high confidence)
- **Divergent findings** — nodes disagree (requires human adjudication)
- **Unique contributions** — one node only (valuable, not yet cross-validated)
- **Falsifications** — always listed, all nodes, always surfaced
- **Source attribution** — which node contributed which yield

Synthesis is stored locally as a `myr_syntheses` record. Not auto-shared — Jordan reviews first.

---

## Database Schema Changes

```sql
-- Add to myr_reports table:
ALTER TABLE myr_reports ADD COLUMN imported_from TEXT;  -- null if local, node_id if imported
ALTER TABLE myr_reports ADD COLUMN signed_artifact TEXT; -- full signed artifact JSON
ALTER TABLE myr_reports ADD COLUMN import_verified INTEGER DEFAULT 0; -- 1 if sig verified

-- Peer registry
CREATE TABLE IF NOT EXISTS myr_peers (
  node_id TEXT PRIMARY KEY,
  node_name TEXT,
  public_key TEXT NOT NULL,
  public_key_format TEXT DEFAULT 'pem',
  added_at TEXT NOT NULL,
  last_import_at TEXT,
  myr_count INTEGER DEFAULT 0
);
```

---

## Network Joining Gate

**Requirement for cross-node yield access:**
- ≥10 MYRs with Jordan-verified avg rating ≥3.0
- Valid Ed25519 keypair generated and public key shared
- At least one verified export artifact produced

**Rationale:** Proves the node is running real OODA cycles. Prevents performance of yield without actual second-order operation.

---

## File Structure (Phase 2 additions)

```
infrastructure/myr-system/
├── config.json              ← gitignored, node-specific
├── config.example.json      ← tracked, template
├── keys/                    ← gitignored
│   ├── .gitkeep
│   └── {node_id}.{private,public}.pem
├── exports/                 ← gitignored (runtime artifacts)
│   └── .gitkeep
├── imports/                 ← gitignored (received artifacts)  
│   └── .gitkeep
├── scripts/
│   ├── config.js            ← config loader (env > config.json > defaults)
│   ├── myr-keygen.js
│   ├── myr-sign.js
│   ├── myr-export.js
│   ├── myr-import.js
│   └── myr-synthesize.js
└── README.md                ← full install + usage story for other nodes
```

---

## Upgrade Path: Database Portability

When going truly distributed, replace SQLite with Turso/LibSQL:
- Same better-sqlite3-compatible API via `@libsql/client`
- `MYR_DB_URL` and `MYR_DB_TOKEN` env vars
- Zero code changes in scripts if db.js abstracts the connection

The signed artifact format remains the canonical source of truth regardless of backend.

---

## Testability Criteria (Phase 2)

**T5:** Node 1 keypair generated, public key exportable  
**T6:** MYR export produces valid signed artifact JSON  
**T7:** Import correctly rejects tampered/invalid signatures  
**T8:** Import correctly rejects duplicate IDs  
**T9:** Synthesis correctly identifies convergent findings across 2 simulated nodes  
**T10:** README enables a new node to install and run from zero  
