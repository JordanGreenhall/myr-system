# MYR Operator Guide

**Version:** 1.2.0
**For:** Anyone setting up and running a MYR node

---

## What MYR Does

MYR captures what you learn from real work — techniques that work, insights that shift how you think, things proven not to work, patterns you notice across cycles — and makes it searchable, verifiable, and shareable with other nodes.

Your node is useful by itself. The network makes it compound.

---

## Install

### One-step (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/JordanGreenhall/myr-system/main/install.sh | bash
```

This clones the repo, installs dependencies, generates your Ed25519 keypair, prompts for your node ID, and runs a verification test.

### Manual

```bash
git clone https://github.com/JordanGreenhall/myr-system.git
cd myr-system
npm install
cp config.example.json config.json
# Edit config.json — set your node_id (must not be "n1")
node scripts/myr-keygen.js
export MYR_HOME=$(pwd)
```

### Verify installation

Run these five commands. If all succeed, your node is operational:

```bash
node scripts/myr-store.js --intent "Installation test" --type technique \
  --question "Does MYR work?" --evidence "Store succeeded" \
  --changes "MYR is operational" --tags "test"
node scripts/myr-search.js --query "installation test"
node scripts/myr-keygen.js    # no-op if keys exist
node scripts/myr-sign.js --all
node scripts/myr-export.js --all
```

---

## Setup Network Reachability

```bash
myr setup
```

Automatic reachability selection:
1. Tailscale funnel (if available)
2. Cloudflare tunnel (if available)
3. Bootstrap relay fallback

No manual tunnel/port configuration required. Relay fallback degrades cleanly if the relay is temporarily unreachable.

---

## Capture Yield

### Interactive mode

```bash
node scripts/myr-store.js --interactive
```

### Flag mode

```bash
node scripts/myr-store.js \
  --intent "What was being attempted" \
  --type technique \
  --question "What question did this resolve?" \
  --evidence "Observable evidence" \
  --changes "What will be different next cycle" \
  --tags "domain1,domain2"
```

### Yield types

| Type | Use when |
|------|----------|
| `technique` | A method that works and is reusable |
| `insight` | A conceptual shift that changes orientation |
| `falsification` | Something proven NOT to work |
| `pattern` | A recurring structure across cycles |

---

## Search

```bash
node scripts/myr-search.js --query "topic"
node scripts/myr-search.js --tags "domain" --type falsification
node scripts/myr-search.js --unverified
```

Search results are ranked by FTS5 relevance and boosted by operator rating.

---

## Verify

Review the queue, then rate individual reports:

```bash
node scripts/myr-verify.js --queue
node scripts/myr-verify.js --id n1-20260226-001 --rating 4 --notes "Solid"
```

Rating scale: 1 (inaccurate) to 5 (accurate, high-value, transferable). Only reports rated >= 3 can be exported to the network.

---

## Weekly Synthesis

```bash
node scripts/myr-weekly.js
```

Produces a summary by type, surfaces falsifications first, identifies convergent findings from imported yield, and lists unverified reports needing review.

---

## Join the Network

### Join via invite link

If someone shares a `myr://invite/...` URL:

```bash
myr join "myr://invite/<token>"
```

This introduces you to the inviting node, verifies fingerprints, and validates the invite signature.

### Add a peer manually

```bash
myr peer add --url https://peer-node-url:3719
```

This fetches their identity document, registers them as `pending`, and sends an introduce message.

### Verify and approve

```bash
myr node verify --url https://peer-node-url:3719   # 3-way fingerprint check
myr peer approve <peer-node-id>                      # grant trust
```

Verify the fingerprint out-of-band (Signal, phone, in person) before approving.

### List peers

```bash
myr peer list
```

### Discover peers on DHT

```bash
myr peer discover --timeout 30000
myr peer discover --timeout 30000 --auto-introduce
```

---

## Sync

### Manual sync

```bash
myr sync <peer-node-id>
myr sync-all
```

### Auto-sync

The server runs auto-sync every 15 minutes for all trusted peers when running.

### Start the server

```bash
node server/index.js
# or
myr start
```

---

## Export and Import (Manual Exchange)

If live sync isn't available, use file-based exchange:

### Export

```bash
node scripts/myr-export.js --all
# Output: exports/<date>-<node-id>.myr.json
```

### Import

```bash
node scripts/myr-import.js --file ./imports/peer-export.myr.json --peer-key ./keys/peer.public.pem
```

Verifies Ed25519 signatures, rejects duplicates and tampered artifacts.

---

## Cross-Node Synthesis

```bash
node scripts/myr-synthesize.js --tags "domain" --min-nodes 2
```

Identifies convergent findings (same question answered by multiple nodes), divergent findings (conflicting advice), and unique contributions.

---

## Configuration

`config.json` (gitignored, node-specific):

| Field | Default | Env Override |
|-------|---------|-------------|
| `node_id` | — | `MYR_NODE_ID` |
| `node_name` | `""` | `MYR_NODE_NAME` |
| `db_path` | `./db/myr.db` | `MYR_DB_PATH` |
| `keys_path` | `./keys/` | — |
| `export_path` | `./exports/` | — |
| `import_path` | `./imports/` | — |

Set `MYR_HOME` to your installation directory for agent integrations.

---

## Troubleshooting

**"node_id must not be n1"** — Edit `config.json` and set a unique node ID.

**Peer shows as `rejected`** — 3-way fingerprint verification failed. Check that the peer's server is running and their discovery document is reachable. Run `myr node verify --url <url>` for diagnostic output.

**Sync returns no new reports** — Both sides must be mutually trusted (`trust_level: trusted`). Check with `myr peer list`.

**Relay fallback not connecting** — The bootstrap relay must be reachable. Check network connectivity. Relay is a degraded mode — direct HTTPS or tunnel is preferred.
