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

### Auto-draft from agent memory events

```bash
node scripts/myr-draft.js --label "event label" --content "event content" \
  --category "category" --agent "agent-name" --tags "tag1,tag2"
```

Called as a fire-and-forget child process by memory-store.js. Uses local Ollama (llama3.1:8b) to extract structured MYR fields from a memory event and store a draft. Failures are silent so the parent process is never affected.

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

### Show node identity

```bash
node scripts/myr-identity.js
```

Prints this node's identity card: node_id, node_uuid, and public key fingerprint. Share this with peers before exchanging MYR packages.

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

### Sync from all trusted peers

```bash
node scripts/myr-sync-all.js
```

Syncs verified MYRs from all peers marked `auto_sync=1` and `trust_level='trusted'` via peer-to-peer exchange.

### Sync from a single peer

```bash
node scripts/myr-sync-peer.js <peer_name>
```

Syncs verified MYRs from a specific peer by operator name.

### Sync registry

```bash
node scripts/myr-sync-registry.js
```

Fetches the signed node registry and revocation list from GitHub, verifies Ed25519 signatures, applies replay protection, upserts new peers, and applies revocations.

### Sign the network registry (operator only)

```bash
node scripts/myr-registry-sign.js --nodes network/nodes.json
node scripts/myr-registry-sign.js --revoked network/revoked.json
```

Signs or updates the MYR node registry and revocation list with the network operator key. Bumps version and re-signs canonical JSON.

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
| `node_url` | `""` | — |
| `node_uuid` | `""` | — |
| `db_path` | `./db/myr.db` | `MYR_DB_PATH` |
| `keys_path` | `./keys/` | — |
| `export_path` | `./exports/` | — |
| `import_path` | `./imports/` | — |
| `registry_version` | `1` | — |

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
│   ├── myr-identity.js      ← print node identity card
│   ├── myr-keygen.js        ← Ed25519 keypair
│   ├── myr-sign.js          ← sign artifacts
│   ├── myr-export.js        ← export signed artifacts
│   ├── myr-import.js        ← import + verify peer artifacts
│   ├── myr-synthesize.js    ← cross-node synthesis
│   ├── myr-registry-sign.js ← sign network registry (operator)
│   ├── myr-sync-all.js      ← sync from all trusted peers
│   ├── myr-sync-peer.js     ← sync from a single peer
│   └── myr-sync-registry.js ← fetch + verify node registry
├── db/                      ← SQLite (gitignored)
├── keys/                    ← keypairs (gitignored)
├── exports/                 ← signed exports (gitignored)
├── imports/                 ← received imports (gitignored)
└── docs/
    ├── INTEGRATION-EXAMPLES.md
    ├── PHASE-2-SPEC.md
    └── NETWORK-ARCHITECTURE.md
```
