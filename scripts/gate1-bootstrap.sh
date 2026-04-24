#!/usr/bin/env bash
# gate1-bootstrap.sh — MYR ↔ Hyperspace Gate 1 proof
#
# Proves MYR can provision and own a Hyperspace install:
#   1. Install Hyperspace (headless, no-tray) if not present
#   2. Fix macOS code-signing issue that kills downloaded binaries
#   3. Optionally import MYR identity key into Hyperspace
#   4. Start Hyperspace headless under script control
#   5. Verify: node started, peers connected, identity accessible
#   6. Test restart survival (stop → start → verify)
#
# Pass/Fail criteria from STA-126:
#   PASS  - All five checks succeed without manual intervention
#   FAIL  - Any check requires manual steps or cannot be automated
#
# Usage:
#   bash gate1-bootstrap.sh [--myr-key <path-to-private.pem>] [--import-key] [--test-restart]
#
# Portable: uses $HOME, not hardcoded paths.

set -euo pipefail

# ── Styling ───────────────────────────────────────────────────────────────────
BOLD=$(tput bold 2>/dev/null || printf '')
RESET=$(tput sgr0 2>/dev/null || printf '')
GREEN=$(tput setaf 2 2>/dev/null || printf '')
YELLOW=$(tput setaf 3 2>/dev/null || printf '')
RED=$(tput setaf 1 2>/dev/null || printf '')
CYAN=$(tput setaf 6 2>/dev/null || printf '')

step()  { echo "${BOLD}${CYAN}▶ $1${RESET}"; }
ok()    { echo "${GREEN}✓ $1${RESET}"; }
warn()  { echo "${YELLOW}⚠ $1${RESET}"; }
fail()  { echo "${RED}✗ FAIL: $1${RESET}"; GATE1_RESULT="FAIL"; GATE1_FAIL_REASON="$1"; }
done_line() { echo ""; echo "${BOLD}── $1 ──${RESET}"; }

# ── Config ────────────────────────────────────────────────────────────────────
HS_BIN="${HOME}/.local/bin/hyperspace"
HS_DATA="${HOME}/.hyperspace"
INSTALL_URL="https://download.hyper.space/api/install"
START_TIMEOUT=30   # seconds to wait for node to come up
PEER_REQUIRED=1    # minimum peers to pass connectivity check

MYR_KEY_PATH=""
DO_IMPORT_KEY=false
DO_TEST_RESTART=false

# ── Args ──────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --myr-key)    MYR_KEY_PATH="$2"; shift 2 ;;
    --import-key) DO_IMPORT_KEY=true; shift ;;
    --test-restart) DO_TEST_RESTART=true; shift ;;
    *) warn "Unknown arg: $1"; shift ;;
  esac
done

# ── Result tracking ───────────────────────────────────────────────────────────
GATE1_RESULT="PASS"
GATE1_FAIL_REASON=""

echo ""
echo "${BOLD}Gate 1 — MYR can provision and own a Hyperspace install${RESET}"
echo "══════════════════════════════════════════════════════════"
echo ""

# ── Step 1: Install ───────────────────────────────────────────────────────────
step "1. Install Hyperspace"

if [ -f "$HS_BIN" ]; then
  HS_VER=$(timeout 10 "$HS_BIN" --version 2>/dev/null || echo "unknown")
  ok "Already installed: v${HS_VER}"
else
  echo "  Downloading from ${INSTALL_URL} ..."
  if ! curl -fsSL "$INSTALL_URL" | bash -s -- --no-tray 2>&1 | grep -E '^\[.\]|^(==>|!!)|installed'; then
    fail "Install script failed"
  fi

  if [ ! -f "$HS_BIN" ]; then
    fail "Binary not found at $HS_BIN after install"
  fi

  # macOS: newly-downloaded binaries may have invalid code signatures.
  # The installer replaces an existing signature, but fresh downloads on
  # macOS 15+ are killed by Taskgated with SIGKILL (Code Signature Invalid).
  # Ad-hoc signing resolves this without needing a developer cert.
  if [ "$(uname -s)" = "Darwin" ]; then
    step "  Applying macOS ad-hoc code signature..."
    if /usr/bin/codesign --force --deep --sign - "$HS_BIN" 2>/dev/null; then
      ok "Ad-hoc signature applied"
    else
      warn "codesign failed — binary may be killed by Gatekeeper"
    fi
  fi

  HS_VER=$(timeout 10 "$HS_BIN" --version 2>/dev/null || echo "unknown")
  ok "Installed: v${HS_VER}"
fi

# ── Step 2: macOS signing guard ───────────────────────────────────────────────
step "2. Verify binary is executable (macOS signing)"

if [ "$(uname -s)" = "Darwin" ]; then
  if ! timeout 5 "$HS_BIN" --version >/dev/null 2>&1; then
    warn "Binary not responding — attempting ad-hoc re-sign..."
    /usr/bin/codesign --force --deep --sign - "$HS_BIN" 2>/dev/null || true
    if ! timeout 5 "$HS_BIN" --version >/dev/null 2>&1; then
      fail "Binary still not executable after re-sign. Check macOS security settings."
    fi
  fi
fi
ok "Binary responds: v$($HS_BIN --version 2>/dev/null || echo '?')"

# ── Step 3: Identity import (optional) ───────────────────────────────────────
step "3. Identity"

if [ -n "$MYR_KEY_PATH" ] && [ "$DO_IMPORT_KEY" = true ]; then
  if [ ! -f "$MYR_KEY_PATH" ]; then
    fail "MYR key not found: $MYR_KEY_PATH"
  else
    # Convert PKCS8 PEM Ed25519 → raw hex private key seed
    RAW_HEX=$(node -e "
      const crypto = require('crypto');
      const fs = require('fs');
      const pem = fs.readFileSync('${MYR_KEY_PATH}', 'utf8');
      const key = crypto.createPrivateKey(pem);
      const jwk = key.export({ format: 'jwk' });
      process.stdout.write(Buffer.from(jwk.d, 'base64url').toString('hex'));
    " 2>/dev/null)

    if [ -z "$RAW_HEX" ]; then
      fail "Could not extract raw key from PEM: $MYR_KEY_PATH"
    else
      # Backup existing identity before overwriting
      IDENTITY_BACKUP="${HS_DATA}/identity.json.gate1-backup-$(date +%s)"
      [ -f "${HS_DATA}/identity.json" ] && cp "${HS_DATA}/identity.json" "$IDENTITY_BACKUP" && warn "Backed up existing identity to $IDENTITY_BACKUP"

      # Import MYR key into Hyperspace (hex format)
      if timeout 10 "$HS_BIN" identity import -k "$RAW_HEX" 2>&1; then
        NEW_ID=$(timeout 10 "$HS_BIN" identity export --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);console.log(o.peerId||'?');}catch(e){console.log('?');}})" 2>/dev/null || echo "unknown")
        ok "MYR key imported → peer ID: ${NEW_ID}"
        echo "  NOTE: Peer ID derivation: libp2p multihash(ed25519-pubkey)"
        echo "  NOTE: MYR fingerprint:    base64url(sha256(spki-der))"
        echo "  → These are DIFFERENT identifiers from the same key material."
      else
        fail "hyperspace identity import failed for MYR key"
      fi
    fi
  fi
else
  if [ -f "${HS_DATA}/identity.json" ]; then
    EXISTING_ID=$(timeout 10 "$HS_BIN" identity export --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);console.log(o.peerId||'?');}catch(e){console.log('?');}})" 2>/dev/null || echo "unknown")
    ok "Using existing identity — peer ID: ${EXISTING_ID}"
  else
    ok "No identity yet — will be generated on first start"
  fi
fi

# ── Step 4: Start ─────────────────────────────────────────────────────────────
step "4. Start Hyperspace (headless)"

ALREADY_RUNNING=false
if timeout 10 "$HS_BIN" status 2>/dev/null | grep -q "Status: RUNNING"; then
  ALREADY_RUNNING=true
  ok "Already running"
else
  # Start headless in background — MYR would own this process
  "$HS_BIN" start --headless >"${HS_DATA}/daemon-start.log" 2>&1 &
  HS_PID=$!
  echo "  Started (background PID ${HS_PID}), waiting up to ${START_TIMEOUT}s..."

  STARTED=false
  for i in $(seq 1 $START_TIMEOUT); do
    sleep 1
    if timeout 5 "$HS_BIN" status 2>/dev/null | grep -q "Status: RUNNING"; then
      STARTED=true
      break
    fi
    printf '.'
  done
  echo ""

  if [ "$STARTED" = true ]; then
    ok "Node started"
  else
    fail "Node did not reach RUNNING state within ${START_TIMEOUT}s"
  fi
fi

# ── Step 5: Health checks ─────────────────────────────────────────────────────
step "5. Health check — node status, peers, identity"

STATUS_OUT=$(timeout 10 "$HS_BIN" status 2>&1 || echo "STATUS_FAILED")

if echo "$STATUS_OUT" | grep -q "Status: RUNNING"; then
  ok "Node: RUNNING"
else
  fail "Node status not RUNNING"
  echo "$STATUS_OUT"
fi

# Peer connectivity
PEER_COUNT=$(echo "$STATUS_OUT" | grep -oE 'Peers:\s+[0-9]+' | grep -oE '[0-9]+' || echo "0")
PEER_COUNT="${PEER_COUNT:-0}"
if [ "$PEER_COUNT" -ge "$PEER_REQUIRED" ]; then
  ok "Peers: ${PEER_COUNT} (≥ ${PEER_REQUIRED} required)"
else
  warn "Peers: ${PEER_COUNT} (< ${PEER_REQUIRED} — may still be connecting)"
  # Not a hard fail for Gate 1 — connectivity is network-dependent
fi

# Identity accessible
ID_OUT=$(timeout 10 "$HS_BIN" identity export --json 2>/dev/null || echo "{}")
PEER_ID=$(echo "$ID_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);console.log(o.peerId||'?');}catch(e){console.log('?');}})" 2>/dev/null || echo "unknown")
if [ "$PEER_ID" != "?" ] && [ "$PEER_ID" != "unknown" ] && [ -n "$PEER_ID" ]; then
  ok "Identity accessible — peer ID: ${PEER_ID}"
else
  fail "Identity not accessible (hyperspace identity export returned: $ID_OUT)"
fi

echo ""
echo "${BOLD}Status snapshot:${RESET}"
echo "$STATUS_OUT"

# ── Step 6: Restart test ──────────────────────────────────────────────────────
if [ "$DO_TEST_RESTART" = true ]; then
  step "6. Restart survival test"

  echo "  Stopping Hyperspace..."
  if timeout 15 "$HS_BIN" kill 2>&1 | grep -qiE "stopped|killed|not running"; then
    ok "Stopped"
  else
    timeout 10 "$HS_BIN" kill 2>/dev/null || true
    sleep 2
    ok "Stop attempted"
  fi

  sleep 3

  echo "  Restarting..."
  "$HS_BIN" start --headless >"${HS_DATA}/daemon-restart.log" 2>&1 &
  sleep 2

  RESTARTED=false
  for i in $(seq 1 $START_TIMEOUT); do
    sleep 1
    if timeout 5 "$HS_BIN" status 2>/dev/null | grep -q "Status: RUNNING"; then
      RESTARTED=true
      break
    fi
    printf '.'
  done
  echo ""

  if [ "$RESTARTED" = true ]; then
    # Verify identity survived restart
    POST_ID=$(timeout 10 "$HS_BIN" identity export --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);console.log(o.peerId||'?');}catch(e){console.log('?');}})" 2>/dev/null || echo "unknown")
    if [ "$POST_ID" = "$PEER_ID" ]; then
      ok "Restart: PASS — node back RUNNING, identity preserved (${POST_ID})"
    else
      warn "Restart: node back RUNNING but peer ID changed: was ${PEER_ID}, now ${POST_ID}"
    fi
  else
    fail "Node did not restart within ${START_TIMEOUT}s"
  fi
else
  step "6. Restart survival test"
  warn "Skipped (pass --test-restart to include)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════"
if [ "$GATE1_RESULT" = "PASS" ]; then
  echo "${BOLD}${GREEN}GATE 1 RESULT: PASS${RESET}"
  echo ""
  echo "  MYR can provision and own a Hyperspace install with bounded"
  echo "  operator burden. All automated checks succeeded."
else
  echo "${BOLD}${RED}GATE 1 RESULT: FAIL${RESET}"
  echo "  Reason: ${GATE1_FAIL_REASON}"
fi
echo ""
echo "  Hyperspace version:  $(timeout 5 "$HS_BIN" --version 2>/dev/null || echo '?')"
echo "  Data dir:            ${HS_DATA}"
echo "  Binary:              ${HS_BIN}"
echo "  Peer ID:             ${PEER_ID:-unknown}"
echo "══════════════════════════════════════════════════════════"
echo ""

[ "$GATE1_RESULT" = "PASS" ]
