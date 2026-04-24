# Operator Setup Checklist

Step-by-step checklist to install, configure, and verify a running MYR node.

---

## Phase 1: Install

- [ ] **Clone the repository**
  ```bash
  git clone https://github.com/JordanGreenhall/myr-system.git
  cd myr-system
  ```

- [ ] **Install dependencies**
  ```bash
  npm install
  ```
  Expected: no errors, `node_modules/` created.

- [ ] **Run the test suite**
  ```bash
  npm test
  ```
  Expected: 436+ tests pass, 0 failures.

## Phase 2: Configure

- [ ] **Create configuration file**
  ```bash
  cp config.example.json config.json
  ```

- [ ] **Edit `config.json`** with your node details:
  ```json
  {
    "node_id": "nX",
    "node_name": "Node X - Your Name",
    "db_path": "./db/myr.db",
    "keys_path": "./keys/",
    "export_path": "./exports/",
    "import_path": "./imports/",
    "peers": [],
    "auto_approve_verified_peers": false
  }
  ```
  Replace `nX` with your assigned node ID. Replace `Your Name` with your operator name.

- [ ] **Generate Ed25519 keypair**
  ```bash
  node scripts/myr-keygen.js
  ```
  Expected: `keys/` directory created with public and private key files.
  Verify:
  ```bash
  ls keys/
  ```
  Expected output: `node.public.pem  node.private.pem` (or similar).

- [ ] **Sign existing reports** (if any pre-seeded data)
  ```bash
  node scripts/myr-sign.js --all
  ```

## Phase 3: Network Reachability

- [ ] **Determine connectivity method**

  Option A — Direct public IP:
  ```bash
  # Ensure port 3719 is open in your firewall
  curl http://YOUR_PUBLIC_IP:3719/myr/health
  ```

  Option B — Tailscale:
  ```bash
  myr setup
  # Follow Tailscale prompts
  ```

  Option C — Cloudflare tunnel:
  ```bash
  myr setup
  # Follow Cloudflare tunnel prompts
  ```

- [ ] **Verify reachability** (from another machine or using your public URL):
  ```bash
  curl https://YOUR_NODE_URL/myr/health
  ```
  Expected: JSON with `"status": "ok"`, your `public_key`, and `peers_active` count.

## Phase 4: Start the Node

- [ ] **Start the server**
  ```bash
  node server/index.js
  ```
  Or use the CLI:
  ```bash
  myr start
  ```
  Expected: server listening on port 3719 (default).

- [ ] **Verify health endpoint**
  ```bash
  curl http://localhost:3719/myr/health
  ```
  Expected response includes:
  - `"status": "ok"`
  - `"public_key"` is present (hex string)
  - `"uptime_seconds"` is increasing

- [ ] **Verify node health status**
  ```bash
  curl http://localhost:3719/myr/health/node
  ```
  Expected: `"status": "green"` (queue_age <= 300s).

- [ ] **Verify discovery document**
  ```bash
  curl http://localhost:3719/.well-known/myr-node
  ```
  Expected: JSON with `protocol_version`, `public_key`, `capabilities`.

## Phase 5: Capture First Yield

- [ ] **Capture a test yield report**
  ```bash
  node scripts/myr-store.js --intent "Validate MYR setup" \
    --type technique \
    --question "Does the MYR node start and capture yield?" \
    --evidence "Node started, health endpoint returns ok" \
    --changes "Node is operational and ready for peer connections" \
    --tags "operations,setup"
  ```
  Expected: report ID printed (format: `nX-YYYYMMDD-001`).

- [ ] **Verify the report was stored**
  ```bash
  node scripts/myr-search.js --query "setup"
  ```
  Expected: your test report appears in results.

- [ ] **Verify the report (operator rating)**
  ```bash
  node scripts/myr-verify.js --queue
  ```
  Rate the test report (3 or higher to make it exportable).

## Phase 6: Deploy Reverse Proxy (Required)

MYR unauthenticated endpoints lack IP-based rate limiting. A reverse proxy is required.

- [ ] **Deploy nginx or Caddy** in front of your MYR node with:
  - IP-based rate limiting on unauthenticated endpoints (`/myr/health`, `/.well-known/myr-node`, `/myr/peer/introduce`)
  - TLS termination (Let's Encrypt or equivalent)
  - Recommended: 30 req/min per IP for unauthenticated endpoints

- [ ] **Verify TLS**
  ```bash
  curl https://YOUR_NODE_URL/myr/health
  ```
  Expected: valid TLS, JSON health response.

## Phase 7: Final Verification

- [ ] **Run the automated health check**
  ```bash
  bash scripts/pilot/verify-node-health.sh http://localhost:3719
  ```
  Expected: all checks PASS.

- [ ] **Run the release gate tests**
  ```bash
  npm run test:release
  ```
  Expected: all tests pass (regression + onboarding-truth).

---

## Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| Health returns 500 | `ls db/myr.db` | Run `npm install` and check `config.json` db_path |
| No public key | `ls keys/` | Run `node scripts/myr-keygen.js` |
| Port 3719 unreachable | Firewall rules | Open port or use Tailscale/Cloudflare |
| Tests fail | `npm test 2>&1 \| tail -20` | Check Node.js version (18+ required) |
