# MYR System — Methodological Yield Reports

A pistis-native intelligence compounding system. Captures, structures, stores, and retrieves methodological yield from OODA cycles — techniques that work, insights that shift orientation, falsifications that prevent repeat failure, patterns that emerge across domains.

Single-node capture and search. Multi-node signed artifact exchange via Ed25519. Cross-node synthesis identifies convergent and divergent findings across the network.

## Install

```bash
git clone https://github.com/JordanGreenhall/myr-system.git
cd myr-system
npm install
cp config.example.json config.json
# Edit config.json — set your node_id
node scripts/myr-keygen.js
```

## Quick Start

### Capture yield

```bash
node scripts/myr-store.js \
  --intent "What was being attempted" \
  --type technique \
  --question "What question did this resolve?" \
  --evidence "Observable evidence" \
  --changes "What will be different next cycle" \
  --tags "domain1,domain2"
```

Types: `technique` (reusable method), `insight` (orientation shift), `falsification` (what doesn't work), `pattern` (recurring structure).

Or use `--interactive` for guided prompts, or `--stdin` for piped JSON.

### Search prior yield

```bash
node scripts/myr-search.js --query "topic"
node scripts/myr-search.js --tags "domain" --type falsification
node scripts/myr-search.js --unverified
```

### Verify (operator review)

```bash
node scripts/myr-verify.js --queue
node scripts/myr-verify.js --id n1-20260226-001 --rating 4 --notes "Solid"
```

Rating 1-5. Only verified MYRs (≥3) can be exported to the network.

### Weekly digest

```bash
node scripts/myr-weekly.js
```

## Cross-Node Operations

### Export signed artifacts

```bash
node scripts/myr-export.js --all
```

Exports verified MYRs (rating ≥3) as Ed25519-signed JSON to `exports/`.

### Import from peer

```bash
node scripts/myr-import.js --file ./imports/peer-export.myr.json --peer-key ./keys/n2.public.pem
```

Verifies signatures, rejects duplicates and tampered artifacts.

### Cross-node synthesis

```bash
node scripts/myr-synthesize.js --tags "domain" --min-nodes 2
```

## Verify Installation

Run the ping test after install to confirm everything works:

```bash
node scripts/myr-store.js --intent "Installation test" --type technique \
  --question "Does MYR work on this node?" --evidence "Store succeeded" \
  --changes "MYR is operational" --tags "test"
node scripts/myr-search.js --query "installation test"
node scripts/myr-keygen.js  # if not already done
node scripts/myr-sign.js --all
node scripts/myr-export.js --all
```

If all five commands succeed, the node is operational.

## Integration with Agent Memory Systems

MYR can be wired into existing agent memory systems so yield capture is automatic — no new habit required. See `docs/INTEGRATION-EXAMPLES.md` for a reference implementation showing how Node 1 (the first network node) solved this.

**Environment variable:** Set `MYR_HOME` to the absolute path of your myr-system installation. Agent scripts that integrate with MYR use this to locate the system.

## Config

`config.json` (gitignored, node-specific):

| Field | Default | Env Override |
|-------|---------|-------------|
| `node_id` | `nX` | `MYR_NODE_ID` |
| `node_name` | `""` | `MYR_NODE_NAME` |
| `db_path` | `./db/myr.db` | `MYR_DB_PATH` |
| `keys_path` | `./keys/` | — |
| `export_path` | `./exports/` | — |
| `import_path` | `./imports/` | — |

## File Structure

```
myr-system/
├── config.example.json      ← template (tracked)
├── config.json              ← your config (gitignored)
├── scripts/
│   ├── config.js            ← config loader
│   ├── db.js                ← database + migrations
│   ├── myr-store.js         ← capture
│   ├── myr-search.js        ← search/retrieve
│   ├── myr-weekly.js        ← weekly digest
│   ├── myr-verify.js        ← operator review
│   ├── myr-draft.js         ← auto-draft from memory events
│   ├── myr-keygen.js        ← Ed25519 keypair
│   ├── myr-sign.js          ← sign artifacts
│   ├── myr-export.js        ← export signed artifacts
│   ├── myr-import.js        ← import + verify peer artifacts
│   └── myr-synthesize.js    ← cross-node synthesis
├── db/                      ← SQLite (gitignored)
├── keys/                    ← keypairs (gitignored)
├── exports/                 ← signed exports (gitignored)
├── imports/                 ← received imports (gitignored)
└── docs/
    ├── INTEGRATION-EXAMPLES.md
    ├── PHASE-2-SPEC.md
    └── NETWORK-ARCHITECTURE.md
```
