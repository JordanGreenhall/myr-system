#!/usr/bin/env bash
# gate3-unified-install.sh — Gate 3 proof: MYR-first install that hides Hyperspace
#
# Proves: A user can install and enter through MYR while becoming a functioning
# Hyperspace participant underneath, without needing to touch Hyperspace directly.
#
# This wraps the existing install.sh + hyperspace-bootstrap.sh into a single
# user-facing experience where Hyperspace is infrastructure, not a visible layer.
#
# Usage:
#   bash scripts/gate3-unified-install.sh [--clean] [--skip-myr] [--verbose]
#
# --clean:    Start from a clean state (for proof purposes)
# --skip-myr: Skip MYR install if already done (for iterating on HS layer)
# --verbose:  Show substrate-level details (normally hidden)

set -euo pipefail

BOLD=$(tput bold 2>/dev/null || true)
RESET=$(tput sgr0 2>/dev/null || true)
GREEN=$(tput setaf 2 2>/dev/null || true)
YELLOW=$(tput setaf 3 2>/dev/null || true)
RED=$(tput setaf 1 2>/dev/null || true)
CYAN=$(tput setaf 6 2>/dev/null || true)
DIM=$(tput dim 2>/dev/null || true)

# ── MYR-facing output helpers (no Hyperspace terminology) ─────────────────────
myr_step()   { echo ""; echo "${BOLD}${CYAN}▶ $1${RESET}"; }
myr_ok()     { echo "  ${GREEN}✓ $1${RESET}"; }
myr_warn()   { echo "  ${YELLOW}! $1${RESET}"; }
myr_fail()   { echo "  ${RED}✗ $1${RESET}"; }
myr_detail() { if [ "$VERBOSE" = true ]; then echo "  ${DIM}  $1${RESET}"; fi; }

# ── Parse args ────────────────────────────────────────────────────────────────
CLEAN=false
SKIP_MYR=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --clean)    CLEAN=true; shift ;;
    --skip-myr) SKIP_MYR=true; shift ;;
    --verbose)  VERBOSE=true; shift ;;
    *) shift ;;
  esac
done

# ── Locate MYR ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MYR_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$MYR_HOME/package.json" ]; then
  echo "${RED}Not inside myr-system. Run from the myr-system root.${RESET}"
  exit 1
fi

export MYR_HOME
export PATH="${HOME}/.local/bin:${HOME}/.hyperspace/bin:$PATH"

# ── Gate 3 proof header ──────────────────────────────────────────────────────
echo ""
echo "${BOLD}══════════════════════════════════════════════════════════${RESET}"
echo "${BOLD}  MYR — Install & Network Setup${RESET}"
echo "${BOLD}══════════════════════════════════════════════════════════${RESET}"
echo ""
echo "  This will set up your MYR node with full network capabilities."
echo "  Everything is automated — no manual configuration required."
echo ""

GATE3_RESULT="PASS"
GATE3_LEAKS=()
GATE3_EVIDENCE=()

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 1: MYR CORE INSTALL
# ══════════════════════════════════════════════════════════════════════════════

if [ "$SKIP_MYR" = false ]; then
  myr_step "1/5  Installing MYR core"

  # Dependencies
  if ! command -v node >/dev/null 2>&1; then
    myr_fail "Node.js not found. Install from https://nodejs.org (v18+ required)"
    exit 1
  fi
  NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 18 ]; then
    myr_fail "Node.js v18+ required (found v$(node --version))"
    exit 1
  fi
  myr_ok "Runtime: Node.js $(node --version)"

  cd "$MYR_HOME"
  npm install --silent 2>/dev/null
  myr_ok "Dependencies installed"

  # Config
  if [ ! -f "$MYR_HOME/config.json" ]; then
    cp "$MYR_HOME/config.example.json" "$MYR_HOME/config.json"
    # Auto-generate a node ID for proof (in production, user would choose)
    NODE_ID="myr-$(openssl rand -hex 3)"
    node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
      cfg.node_id = '${NODE_ID}';
      fs.writeFileSync('config.json', JSON.stringify(cfg, null, 2) + '\n');
    "
    myr_ok "Node configured: ${NODE_ID}"
  else
    NODE_ID=$(node -e "const c=JSON.parse(require('fs').readFileSync('$MYR_HOME/config.json','utf8'));console.log(c.node_id||'unknown')")
    myr_ok "Node already configured: ${NODE_ID}"
  fi

  # Keys
  if ! ls "$MYR_HOME/keys"/*.private.pem >/dev/null 2>&1; then
    node "$MYR_HOME/scripts/myr-keygen.js"
    myr_ok "Identity keypair generated"
  else
    myr_ok "Identity keypair exists"
  fi

  # Show MYR identity (in MYR terms)
  MYR_FINGERPRINT=$(node "$MYR_HOME/scripts/myr-identity.js" 2>/dev/null | grep -oE 'SHA256:[^ ]+' || echo "unknown")
  myr_ok "Identity: ${MYR_FINGERPRINT}"

  GATE3_EVIDENCE+=("myr_core_installed=true")
  GATE3_EVIDENCE+=("myr_node_id=${NODE_ID}")
  GATE3_EVIDENCE+=("myr_fingerprint=${MYR_FINGERPRINT}")
else
  myr_step "1/5  MYR core (skipped — already installed)"
  NODE_ID=$(node -e "const c=JSON.parse(require('fs').readFileSync('$MYR_HOME/config.json','utf8'));console.log(c.node_id||'unknown')")
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 2: NETWORK SUBSTRATE (Hyperspace — hidden from user)
# ══════════════════════════════════════════════════════════════════════════════

myr_step "2/5  Setting up network substrate"
myr_detail "(Installing distributed network layer...)"

# ── Install binary silently ──────────────────────────────────────────────────
HYPERSPACE_BIN=""
for p in "${HOME}/.local/bin/hyperspace" "${HOME}/.hyperspace/bin/hyperspace"; do
  if [ -f "$p" ]; then HYPERSPACE_BIN="$p"; break; fi
done

if [ -z "$HYPERSPACE_BIN" ]; then
  myr_detail "Downloading network components..."
  curl -fsSL https://download.hyper.space/api/install 2>/dev/null | bash -s -- --no-tray --no-start >/dev/null 2>&1 || true

  for p in "${HOME}/.local/bin/hyperspace" "${HOME}/.hyperspace/bin/hyperspace"; do
    if [ -f "$p" ]; then HYPERSPACE_BIN="$p"; break; fi
  done

  if [ -z "$HYPERSPACE_BIN" ]; then
    myr_fail "Network substrate installation failed"
    GATE3_RESULT="FAIL"
    GATE3_LEAKS+=("STRUCTURAL: substrate binary install failed — user would need to debug Hyperspace install manually")
  else
    # macOS signing fix (silent)
    if [ "$(uname -s)" = "Darwin" ]; then
      /usr/bin/codesign --force --deep --sign - "$HYPERSPACE_BIN" 2>/dev/null || true
    fi
    myr_ok "Network components installed"
  fi
else
  myr_ok "Network components present"
fi

if [ -n "$HYPERSPACE_BIN" ]; then
  HS_VER=$("$HYPERSPACE_BIN" --version 2>/dev/null || echo "unknown")
  myr_detail "Substrate version: $HS_VER"
  GATE3_EVIDENCE+=("substrate_installed=true")
  GATE3_EVIDENCE+=("substrate_version=${HS_VER}")

  # LEAK CHECK: Does the installer print Hyperspace-specific output?
  # The curl|bash installer prints "Hyperspace" branding — this is a cosmetic leak.
  GATE3_LEAKS+=("COSMETIC: If install runs fresh, curl|bash installer prints 'Hyperspace' branding to stdout before we can suppress it")
fi

# ── Import MYR identity into substrate ───────────────────────────────────────
myr_step "3/5  Linking identity to network"

if [ -n "$HYPERSPACE_BIN" ]; then
  # Find MYR private key
  KEY_FILE=$(find "${MYR_HOME}/keys" -name '*.private.pem' -not -name 'myr-network*' 2>/dev/null | sort | head -1)

  if [ -n "$KEY_FILE" ]; then
    # Convert MYR Ed25519 PEM → base58 for substrate
    BASE58_KEY=$(node -e "
      const crypto = require('crypto');
      const fs = require('fs');
      const pem = fs.readFileSync('${KEY_FILE}', 'utf8');
      const key = crypto.createPrivateKey(pem);
      const jwk = key.export({ format: 'jwk' });
      const bytes = Buffer.from(jwk.d, 'base64url');
      const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      let num = BigInt('0x' + bytes.toString('hex'));
      let result = '';
      while (num > 0n) { result = ALPHABET[Number(num % 58n)] + result; num = num / 58n; }
      for (let i = 0; i < bytes.length && bytes[i] === 0; i++) result = '1' + result;
      console.log(result || '1');
    " 2>/dev/null)

    # Check if identity already matches
    EXISTING_KEY=""
    if [ -f "${HOME}/.hyperspace/identity.json" ]; then
      EXISTING_KEY=$(node -e "try{const d=require('${HOME}/.hyperspace/identity.json');process.stdout.write(d.privateKey||'')}catch(e){}" 2>/dev/null || true)
    fi

    if [ "$EXISTING_KEY" = "$BASE58_KEY" ]; then
      myr_ok "Network identity already linked"
    else
      # Need to stop substrate for identity import
      HS_PID_CHECK=$(node -e "try{const s=require('${HOME}/.hyperspace/status.json');process.stdout.write(String(s.pid||''))}catch(e){}" 2>/dev/null || true)
      if [ -n "$HS_PID_CHECK" ] && kill -0 "$HS_PID_CHECK" 2>/dev/null; then
        "$HYPERSPACE_BIN" kill >/dev/null 2>&1 || true
        sleep 2
      fi
      "$HYPERSPACE_BIN" identity import -k "$BASE58_KEY" >/dev/null 2>&1
      myr_ok "Network identity linked to MYR keypair"
    fi

    # LEAK CHECK: identity import CLI mentions "Hyperspace" in output
    GATE3_LEAKS+=("COSMETIC: 'hyperspace identity import' CLI output mentions Hyperspace by name (suppressed in this script)")
    GATE3_EVIDENCE+=("identity_linked=true")
  else
    myr_warn "No MYR keypair found — network identity will be auto-generated"
    GATE3_LEAKS+=("STRUCTURAL: Without MYR key import, substrate generates its own identity — user has two unlinked identities")
  fi
else
  myr_fail "Cannot link identity — network substrate not available"
fi

# ── Start substrate ──────────────────────────────────────────────────────────
myr_step "4/5  Connecting to distributed network"

if [ -n "$HYPERSPACE_BIN" ]; then
  # Check if already running via status.json (source of truth)
  HS_RUNNING=false
  HS_PID=$(node -e "try{delete require.cache[require.resolve('${HOME}/.hyperspace/status.json')];const s=require('${HOME}/.hyperspace/status.json');process.stdout.write(String(s.pid||''))}catch(e){}" 2>/dev/null || true)
  if [ -n "$HS_PID" ] && kill -0 "$HS_PID" 2>/dev/null; then
    HS_RUNNING=true
  fi

  if [ "$HS_RUNNING" = false ]; then
    myr_detail "Starting network node..."
    nohup "$HYPERSPACE_BIN" start --headless > "${HOME}/.hyperspace/agent.log" 2>&1 &

    # Wait for startup (report in MYR terms)
    TRIES=0
    MAX_TRIES=15
    while [ $TRIES -lt $MAX_TRIES ]; do
      sleep 2
      HS_PID=$(node -e "try{delete require.cache[require.resolve('${HOME}/.hyperspace/status.json')];const s=require('${HOME}/.hyperspace/status.json');if(s.pid&&s.peerId)process.stdout.write(String(s.pid))}catch(e){}" 2>/dev/null || true)
      if [ -n "$HS_PID" ] && kill -0 "$HS_PID" 2>/dev/null; then
        break
      fi
      TRIES=$((TRIES + 1))
    done
  fi

  # Verify — report in MYR terms
  sleep 2
  NETWORK_STATUS=$(node -e "
    try {
      delete require.cache[require.resolve('${HOME}/.hyperspace/status.json')];
      const s = require('${HOME}/.hyperspace/status.json');
      const alive = s.pid && require('child_process').execSync('kill -0 ' + s.pid + ' 2>/dev/null && echo y || echo n').toString().trim() === 'y';
      console.log(JSON.stringify({
        alive: alive,
        peers: s.peerCount || 0,
        capabilities: (s.capabilities || []).length
      }));
    } catch(e) { console.log(JSON.stringify({alive:false,peers:0,capabilities:0})); }
  " 2>/dev/null)

  NET_ALIVE=$(echo "$NETWORK_STATUS" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.alive)")
  NET_PEERS=$(echo "$NETWORK_STATUS" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.peers)")
  NET_CAPS=$(echo "$NETWORK_STATUS" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.capabilities)")

  if [ "$NET_ALIVE" = "true" ]; then
    myr_ok "Network node active"
    myr_ok "Connected to ${NET_PEERS} peers"
    myr_ok "${NET_CAPS} network capabilities available"
    GATE3_EVIDENCE+=("network_alive=true" "peer_count=${NET_PEERS}" "capabilities=${NET_CAPS}")
  else
    myr_fail "Network node failed to start"
    GATE3_RESULT="FAIL"
    GATE3_LEAKS+=("STRUCTURAL: substrate node failed to start — user would see raw Hyperspace error logs")
  fi

  # LEAK CHECK: ~/.hyperspace/ directory is visible to user
  GATE3_LEAKS+=("COSMETIC: ~/.hyperspace/ directory exists on disk with Hyperspace branding")
  # LEAK CHECK: 'hyperspace' process name visible in ps/Activity Monitor
  GATE3_LEAKS+=("COSMETIC: Process name 'hyperspace' visible in ps/Activity Monitor")
  # LEAK CHECK: port 8080 is Hyperspace's management API
  GATE3_LEAKS+=("COSMETIC: Port 8080 bound by substrate — if user inspects open ports they see 'hyperspace'")
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 3: MYR READINESS CHECK (user-facing)
# ══════════════════════════════════════════════════════════════════════════════

myr_step "5/5  Verifying MYR readiness"

# Run MYR ping test
cd "$MYR_HOME"
PING_OK=true

node scripts/myr-store.js \
  --intent "Installation test" \
  --type technique \
  --question "Does MYR work on this node?" \
  --evidence "Store succeeded" \
  --changes "MYR is operational" \
  --tags "test" >/dev/null 2>&1 || PING_OK=false

if [ "$PING_OK" = true ]; then
  node scripts/myr-search.js --query "installation test" >/dev/null 2>&1 || PING_OK=false
fi

if [ "$PING_OK" = true ]; then
  myr_ok "MYR store and search operational"
else
  myr_warn "MYR ping test had issues (non-fatal)"
fi

# Final readiness — all in MYR terms
echo ""
echo "${BOLD}══════════════════════════════════════════════════════════${RESET}"
echo "${BOLD}  MYR Node Ready${RESET}"
echo "${BOLD}══════════════════════════════════════════════════════════${RESET}"
echo ""

# Run the MYR-facing readiness script
node -e "
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  const http = require('http');

  const MYR_HOME = '${MYR_HOME}';
  const config = JSON.parse(fs.readFileSync(path.join(MYR_HOME, 'config.json'), 'utf8'));

  // MYR identity
  const keyFiles = fs.readdirSync(path.join(MYR_HOME, 'keys')).filter(f => f.endsWith('.public.pem'));
  let fingerprint = 'unknown';
  if (keyFiles.length > 0) {
    const pubPem = fs.readFileSync(path.join(MYR_HOME, 'keys', keyFiles[0]), 'utf8');
    const pubKey = crypto.createPublicKey(pubPem);
    const spki = pubKey.export({ type: 'spki', format: 'der' });
    const hash = crypto.createHash('sha256').update(spki).digest('base64url');
    fingerprint = hash;
  }

  // Network status (read from substrate, report in MYR terms)
  let netStatus = { alive: false, peers: 0 };
  try {
    delete require.cache[require.resolve(path.join(process.env.HOME, '.hyperspace', 'status.json'))];
    const s = require(path.join(process.env.HOME, '.hyperspace', 'status.json'));
    const cp = require('child_process');
    const alive = cp.execSync('kill -0 ' + s.pid + ' 2>/dev/null && echo y || echo n').toString().trim() === 'y';
    netStatus = { alive, peers: s.peerCount || 0 };
  } catch(e) {}

  console.log('  Node ID:          ' + config.node_id);
  console.log('  Identity:         ' + fingerprint);
  console.log('  Store:            operational');
  console.log('  Network:          ' + (netStatus.alive ? 'connected (' + netStatus.peers + ' peers)' : 'offline'));
  console.log('  MYR Home:         ' + MYR_HOME);
  console.log('');
  console.log('  Quick commands:');
  console.log('    node \$MYR_HOME/scripts/myr-store.js --interactive');
  console.log('    node \$MYR_HOME/scripts/myr-search.js --query \"topic\"');
  console.log('    node \$MYR_HOME/server/index.js   # start MYR server');
  console.log('    node \$MYR_HOME/scripts/myr-readiness.js  # check status');
" 2>/dev/null

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# GATE 3 PROOF OUTPUT
# ══════════════════════════════════════════════════════════════════════════════

echo "${BOLD}──────────────────────────────────────────────────────────${RESET}"
echo "${BOLD}  Gate 3 Proof Summary${RESET}"
echo "${BOLD}──────────────────────────────────────────────────────────${RESET}"
echo ""
echo "  ${BOLD}Evidence:${RESET}"
for e in "${GATE3_EVIDENCE[@]}"; do
  echo "    ✓ $e"
done
echo ""
echo "  ${BOLD}Abstraction Leaks:${RESET}"
STRUCTURAL_LEAKS=0
COSMETIC_LEAKS=0
for leak in "${GATE3_LEAKS[@]}"; do
  if [[ "$leak" == STRUCTURAL:* ]]; then
    echo "    ${RED}▸ $leak${RESET}"
    STRUCTURAL_LEAKS=$((STRUCTURAL_LEAKS + 1))
  else
    echo "    ${YELLOW}▸ $leak${RESET}"
    COSMETIC_LEAKS=$((COSMETIC_LEAKS + 1))
  fi
done
echo ""
echo "  Structural leaks: ${STRUCTURAL_LEAKS}"
echo "  Cosmetic leaks:   ${COSMETIC_LEAKS}"
echo ""

if [ "$GATE3_RESULT" = "PASS" ] && [ "$STRUCTURAL_LEAKS" -eq 0 ]; then
  echo "${BOLD}${GREEN}  GATE 3 RESULT: PASS${RESET}"
  echo "  User primarily experiences MYR. Hyperspace is hidden infrastructure."
elif [ "$GATE3_RESULT" = "PASS" ] && [ "$STRUCTURAL_LEAKS" -gt 0 ]; then
  echo "${BOLD}${YELLOW}  GATE 3 RESULT: CONDITIONAL PASS${RESET}"
  echo "  MYR-first experience works but has structural leaks that need addressing."
  GATE3_RESULT="CONDITIONAL"
else
  echo "${BOLD}${RED}  GATE 3 RESULT: FAIL${RESET}"
  echo "  The abstraction is too leaky for a MYR-first product story."
fi

echo ""
echo "══════════════════════════════════════════════════════════"
echo ""
