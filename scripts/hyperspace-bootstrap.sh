#!/usr/bin/env bash
# hyperspace-bootstrap.sh — MYR-owned Hyperspace provisioning
#
# Installs Hyperspace headless, imports MYR Ed25519 identity,
# starts as a background service, and verifies operational state.
#
# Usage:
#   bash scripts/hyperspace-bootstrap.sh [--key-file <path>] [--no-service]
#
# Requires: MYR_HOME set or run from myr-system root.
# Requires: openssl, node (for base58 conversion)

set -euo pipefail

BOLD=$(tput bold 2>/dev/null || true)
RESET=$(tput sgr0 2>/dev/null || true)
GREEN=$(tput setaf 2 2>/dev/null || true)
YELLOW=$(tput setaf 3 2>/dev/null || true)
RED=$(tput setaf 1 2>/dev/null || true)

step() { echo "${BOLD}▶ $1${RESET}"; }
ok()   { echo "${GREEN}✓ $1${RESET}"; }
warn() { echo "${YELLOW}! $1${RESET}"; }
fail() { echo "${RED}✗ $1${RESET}"; exit 1; }

# ── Parse args ──────────────────────────────────────────────
KEY_FILE=""
NO_SERVICE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --key-file) KEY_FILE="$2"; shift 2 ;;
    --no-service) NO_SERVICE=true; shift ;;
    *) shift ;;
  esac
done

# ── Locate MYR ──────────────────────────────────────────────
if [ -z "${MYR_HOME:-}" ]; then
  if [ -f "package.json" ] && grep -q '"name": "myr-system"' package.json 2>/dev/null; then
    MYR_HOME="$(pwd)"
  else
    fail "MYR_HOME not set and not in myr-system directory"
  fi
fi

# ── Resolve key file ────────────────────────────────────────
if [ -z "$KEY_FILE" ]; then
  # Find the first .private.pem in MYR keys directory
  KEY_FILE=$(find "${MYR_HOME}/keys" -name '*.private.pem' -not -name 'myr-network*' 2>/dev/null | sort | head -1)
  if [ -z "$KEY_FILE" ]; then
    fail "No Ed25519 private key found in ${MYR_HOME}/keys/"
  fi
fi

if [ ! -f "$KEY_FILE" ]; then
  fail "Key file not found: $KEY_FILE"
fi

ok "Using MYR key: $KEY_FILE"

# ── 1. Install Hyperspace if not present ────────────────────
HYPERSPACE_BIN="${HOME}/.local/bin/hyperspace"
if [ -f "$HYPERSPACE_BIN" ]; then
  ok "Hyperspace already installed at $HYPERSPACE_BIN"
else
  step "Installing Hyperspace (headless, no tray)..."
  curl -fsSL https://download.hyper.space/api/install | bash -s -- --no-tray --no-start
  if [ ! -f "$HYPERSPACE_BIN" ]; then
    # Check alternate location
    HYPERSPACE_BIN="${HOME}/.hyperspace/bin/hyperspace"
    if [ ! -f "$HYPERSPACE_BIN" ]; then
      fail "Hyperspace binary not found after install"
    fi
  fi
  ok "Hyperspace installed"
fi

# Ensure binary is in PATH for this script
export PATH="${HOME}/.local/bin:${HOME}/.hyperspace/bin:$PATH"

step "Hyperspace version: $(hyperspace version 2>&1 | head -1)"

# ── 2. Convert MYR Ed25519 PEM → base58 ────────────────────
step "Converting MYR Ed25519 key to Hyperspace format..."

RAW_KEY_HEX=$(openssl pkey -in "$KEY_FILE" -outform DER 2>/dev/null | tail -c 32 | xxd -p | tr -d '\n')
if [ -z "$RAW_KEY_HEX" ] || [ ${#RAW_KEY_HEX} -ne 64 ]; then
  fail "Failed to extract 32-byte Ed25519 key from PEM"
fi

BASE58_KEY=$(node -e "
const hex = '$RAW_KEY_HEX';
const bytes = Buffer.from(hex, 'hex');
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function toBase58(buf) {
  let num = BigInt('0x' + buf.toString('hex'));
  let result = '';
  while (num > 0n) {
    result = ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (let i = 0; i < buf.length && buf[i] === 0; i++) {
    result = '1' + result;
  }
  return result || '1';
}
console.log(toBase58(bytes));
")

if [ -z "$BASE58_KEY" ]; then
  fail "Base58 conversion failed"
fi

ok "Key converted to base58"

# ── 3. Check if identity already matches ─────────────────────
EXISTING_KEY=""
if [ -f "${HOME}/.hyperspace/identity.json" ]; then
  EXISTING_KEY=$(node -e "
    try { const d = require('${HOME}/.hyperspace/identity.json');
      process.stdout.write(d.privateKey || ''); } catch(e) {}
  " 2>/dev/null || true)
fi

if [ "$EXISTING_KEY" = "$BASE58_KEY" ]; then
  ok "Hyperspace identity already matches MYR key — skipping import"
else
  # Stop existing Hyperspace if running (identity import requires stopped node)
  HS_PID_CHECK=$(node -e "
    try { const s = require('${HOME}/.hyperspace/status.json');
      process.stdout.write(String(s.pid || '')); } catch(e) {}
  " 2>/dev/null || true)
  if [ -n "$HS_PID_CHECK" ] && kill -0 "$HS_PID_CHECK" 2>/dev/null; then
    step "Stopping existing Hyperspace node for identity import..."
    hyperspace kill 2>&1 || true
    sleep 2
  fi

  # ── 4. Import MYR identity ──────────────────────────────────
  step "Importing MYR identity into Hyperspace..."
  hyperspace identity import -k "$BASE58_KEY" 2>&1
  ok "MYR identity imported"
fi

# ── 5. Verify key match ────────────────────────────────────
MYR_PUB_HEX=$(openssl pkey -in "$KEY_FILE" -pubout -outform DER 2>/dev/null | tail -c 32 | xxd -p | tr -d '\n')
MYR_PUB_BASE58=$(node -e "
const hex = '$MYR_PUB_HEX';
const bytes = Buffer.from(hex, 'hex');
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function toBase58(buf) {
  let num = BigInt('0x' + buf.toString('hex'));
  let result = '';
  while (num > 0n) {
    result = ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (let i = 0; i < buf.length && buf[i] === 0; i++) {
    result = '1' + result;
  }
  return result || '1';
}
console.log(toBase58(bytes));
")

HS_PUB=$(hyperspace identity export --json 2>&1 | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log(d.publicKey);
")

if [ "$MYR_PUB_BASE58" = "$HS_PUB" ]; then
  ok "Public key match verified: $HS_PUB"
else
  fail "Public key mismatch! MYR=$MYR_PUB_BASE58 HS=$HS_PUB"
fi

# ── 6. Start Hyperspace ────────────────────────────────────
if [ "$NO_SERVICE" = "true" ]; then
  step "Starting Hyperspace in background (no service)..."
  nohup hyperspace start > "${HOME}/.hyperspace/agent.log" 2>&1 &
  HPID=$!
  echo "  PID: $HPID"
else
  step "Installing Hyperspace as OS service..."
  hyperspace install-service 2>&1
fi

# ── 7. Wait and verify ─────────────────────────────────────
step "Waiting for node startup..."

TRIES=0
MAX_TRIES=15
while [ $TRIES -lt $MAX_TRIES ]; do
  sleep 2
  HS_RUNNING_PID=$(node -e "
    try { delete require.cache[require.resolve('${HOME}/.hyperspace/status.json')];
      const s = require('${HOME}/.hyperspace/status.json');
      if (s.pid && s.peerId) process.stdout.write(String(s.pid));
    } catch(e) {}
  " 2>/dev/null || true)
  if [ -n "$HS_RUNNING_PID" ] && kill -0 "$HS_RUNNING_PID" 2>/dev/null; then
    break
  fi
  TRIES=$((TRIES + 1))
done

if [ -z "$HS_RUNNING_PID" ] || ! kill -0 "$HS_RUNNING_PID" 2>/dev/null; then
  fail "Hyperspace did not start within ${MAX_TRIES}x2s — check ~/.hyperspace/agent.log"
fi
ok "Node is RUNNING (PID $HS_RUNNING_PID)"

# Read status.json for verification (source of truth, not CLI)
sleep 3
node -e "
  delete require.cache[require.resolve('${HOME}/.hyperspace/status.json')];
  const s = require('${HOME}/.hyperspace/status.json');
  console.log('  Peer ID:    ' + s.peerId);
  console.log('  Peers:      ' + (s.peerCount || 0));
  console.log('  Caps:       ' + (s.capabilities || []).length);
  console.log('  Uptime:     ' + (s.uptimeHours || 0).toFixed(2) + 'h');
"

# Verify identity is accessible
EXPORTED_PUB=$(hyperspace identity export --json 2>&1 | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  process.stdout.write(d.publicKey || '');
")
if [ "$EXPORTED_PUB" = "$HS_PUB" ]; then
  ok "Identity accessible and matches MYR key"
else
  warn "Identity export returned unexpected public key"
fi

# ── 8. Summary ──────────────────────────────────────────────
echo ""
echo "${BOLD}${GREEN}Hyperspace bootstrap complete.${RESET}"
echo ""
echo "  MYR Key:       $KEY_FILE"
echo "  HS Public Key: $HS_PUB"
echo "  HS Peer ID:    $(hyperspace identity export --json 2>&1 | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.peerId);")"
echo "  Identity File: ${HOME}/.hyperspace/identity.json"
echo "  Log File:      ${HOME}/.hyperspace/agent.log"
echo ""
echo "  Commands:"
echo "    hyperspace status         # check node status"
echo "    hyperspace hive whoami    # check identity + points"
echo "    hyperspace kill           # stop node"
echo "    hyperspace uninstall-service  # remove auto-start"
echo ""

# ── Seams & Known Issues ───────────────────────────────────
echo "${YELLOW}Known seams:${RESET}"
echo "  - LaunchAgent PATH is limited (/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin)"
echo "    Missing: sysctl, lsof — non-fatal but produces warnings"
echo "  - SQLite init may fail (non-fatal, node still connects)"
echo "  - ID derivation differs: MYR=sha256(pubkey), Hyperspace=libp2p multihash"
echo "    Same key material, different identifiers"
echo "  - Node may crash and recover via KeepAlive — this is normal Hyperspace behavior"
echo ""
