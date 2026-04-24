# MYR System — Methodological Yield Reports

A pistis-native intelligence compounding system. Captures, structures, stores, and retrieves methodological yield from OODA cycles — techniques that work, insights that shift orientation, falsifications that prevent repeat failure, patterns that emerge across domains.

Single-node capture and search. Multi-node signed artifact exchange via Ed25519. Cross-node synthesis identifies convergent and divergent findings across the network.

## Install

### One-step (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/JordanGreenhall/myr-system/main/install.sh | bash
```

Clones, installs deps, generates keypair, sets node ID, runs ping test. Node is operational when it completes.

Already have the repo? `bash install.sh`

### Manual

```bash
git clone https://github.com/JordanGreenhall/myr-system.git
cd myr-system
npm install
cp config.example.json config.json
# Edit config.json — set your node_id (not "n1")
node scripts/myr-keygen.js
export MYR_HOME=$(pwd)
```

## Quick Start

### Zero-config setup reachability (normal path)

```bash
myr setup
```

Default reachability selection is automatic and requires no tunnel/port strategy choice:

1. Try Tailscale funnel if available.
2. Fall back to Cloudflare tunnel.
3. Fall back to bootstrap relay-backed mode.

If relay-backed mode is used, the node config is written with relay fallback enabled and startup degrades cleanly if the relay is temporarily unreachable.

### Capture yield

```bash
myr capture
```

Interactive mode opens guided prompts (`scripts/myr-store.js --interactive`).

For low-burden automatic candidate extraction from a work log:

```bash
myr capture --from-log ./session.log --session-intent "debug sync timeouts" --tags "sync,networking"
cat session.log | myr capture --session-intent "debug sync timeouts" --json
```

Direct store path is still available:

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

### Recall prior yield before work

```bash
myr recall --intent "debug peer sync timeouts"
myr recall --tags "networking,hyperswarm"
myr recall --intent "optimize search" --tags "fts,performance" --json
```

Search path remains available:

```bash
node scripts/myr-search.js --query "topic"
node scripts/myr-search.js --tags "domain" --type falsification
```

### Verify (operator review)

```bash
node scripts/myr-verify.js --queue
node scripts/myr-verify.js --id n1-20260226-001 --rating 4 --notes "Solid"
```

Rating 1-5.

- Auto-drafts enter local queue with `auto_draft=1` and `operator_rating=NULL`
- Operator review sets `operator_rating`
- Network eligibility threshold is `operator_rating >= 3` (export gate)

### Weekly digest

```bash
node scripts/myr-weekly.js
```

## Cross-Node Operations

### Invite-link onboarding (normal path)

Create an invite URL on an existing node:

```bash
myr invite create
```

Share the resulting `myr://invite/...` link with the new node operator.

Join from the receiving node:

```bash
myr join "myr://invite/<token>"
```

This path performs peer introduction from a single link, verifies fingerprint consistency, and validates the invite signature before trust is granted.

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

## Test Truth

Use two explicit gates:

- Default developer truth (fast regression suite):

```bash
npm test
```

- Release truth (default suite + onboarding acceptance truth):

```bash
npm run test:release
```

`npm test` is the default day-to-day suite. `npm run test:release` is the publish gate and deliberately includes `test/onboarding-truth-test.js`.

## Release Authority

- npm publish artifact/version authority: `myr-system@1.2.2` (`myr-system-1.2.2.tgz`)
- source/release-documentation authority: tag `v1.2.2` (non-destructive correction tag)

Normal operating path is invite-link onboarding plus live/background sync. Manual export/import exchange is an advanced/offline fallback mode.

## Integration with Agent Memory Systems

MYR can be wired into existing agent memory systems so yield capture is automatic — no new habit required. See `docs/INTEGRATION-EXAMPLES.md` for two reference implementations:

- **Node 1 (OpenClaw + PostgreSQL + Ollama):** Node.js hook into an existing memory-store pipeline
- **Node 2 (Hermes agent + Python):** Python subprocess integration with a Nous Research Hermes model — no OpenClaw, no shared memory stack

Two implementations from two different systems. MYR is not OpenClaw-specific.

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
