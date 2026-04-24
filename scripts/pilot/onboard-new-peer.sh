#!/usr/bin/env bash
# onboard-new-peer.sh — Automate new-peer onboarding with verification.
# Usage: bash scripts/pilot/onboard-new-peer.sh <LOCAL_NODE_URL> <PEER_NODE_URL>
# Example: bash scripts/pilot/onboard-new-peer.sh http://localhost:3719 https://peer-node:3719

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <LOCAL_NODE_URL> <PEER_NODE_URL>"
  echo "Example: $0 http://localhost:3719 https://peer-node:3719"
  exit 1
fi

LOCAL_URL="$1"
PEER_URL="$2"

echo "=== MYR Peer Onboarding ==="
echo "Local node: $LOCAL_URL"
echo "Peer node:  $PEER_URL"
echo "Time: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# --- Step 1: Verify local node is healthy ---
echo "--- Step 1: Verify local node ---"
LOCAL_HEALTH=$(curl -sf --max-time 10 "$LOCAL_URL/myr/health" 2>/dev/null) || LOCAL_HEALTH=""

if [ -z "$LOCAL_HEALTH" ]; then
  echo "ERROR: Local node at $LOCAL_URL is not reachable"
  exit 1
fi

LOCAL_STATUS=$(echo "$LOCAL_HEALTH" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$LOCAL_STATUS" != "ok" ]; then
  echo "ERROR: Local node status is '$LOCAL_STATUS', expected 'ok'"
  exit 1
fi
echo "  Local node: OK"

LOCAL_KEY=$(echo "$LOCAL_HEALTH" | grep -o '"public_key":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "  Local public key: ${LOCAL_KEY:0:16}..."

# --- Step 2: Verify peer node is reachable ---
echo ""
echo "--- Step 2: Verify peer node ---"
PEER_HEALTH=$(curl -sf --max-time 15 "$PEER_URL/myr/health" 2>/dev/null) || PEER_HEALTH=""

if [ -z "$PEER_HEALTH" ]; then
  echo "ERROR: Peer node at $PEER_URL is not reachable"
  echo ""
  echo "Troubleshooting:"
  echo "  1. Is the peer node running? (node server/index.js)"
  echo "  2. Is the URL correct? (check port, protocol)"
  echo "  3. Is the peer behind a firewall? (check port 3719)"
  echo "  4. Can you reach it from a browser?"
  exit 1
fi

PEER_STATUS=$(echo "$PEER_HEALTH" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$PEER_STATUS" != "ok" ]; then
  echo "ERROR: Peer node status is '$PEER_STATUS', expected 'ok'"
  exit 1
fi
echo "  Peer node: OK"

PEER_KEY=$(echo "$PEER_HEALTH" | grep -o '"public_key":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "  Peer public key: ${PEER_KEY:0:16}..."

# --- Step 3: Fetch peer discovery document ---
echo ""
echo "--- Step 3: Fetch peer discovery document ---"
PEER_DISCOVERY=$(curl -sf --max-time 10 "$PEER_URL/.well-known/myr-node" 2>/dev/null) || PEER_DISCOVERY=""

if [ -n "$PEER_DISCOVERY" ]; then
  PEER_PROTO=$(echo "$PEER_DISCOVERY" | grep -o '"protocol_version":"[^"]*"' | head -1 | cut -d'"' -f4)
  PEER_NAME=$(echo "$PEER_DISCOVERY" | grep -o '"operator_name":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "  Peer protocol: ${PEER_PROTO:-unknown}"
  echo "  Peer operator: ${PEER_NAME:-unknown}"
else
  echo "  WARNING: Could not fetch /.well-known/myr-node (non-fatal)"
fi

# --- Step 4: Fingerprint verification prompt ---
echo ""
echo "--- Step 4: Fingerprint verification ---"
echo ""
echo "  IMPORTANT: Verify the peer's fingerprint out-of-band before approving."
echo ""
echo "  Peer public key: $PEER_KEY"
echo ""
echo "  Contact the peer operator and confirm this key matches."
echo "  Do NOT skip this step — it prevents man-in-the-middle attacks."
echo ""
read -rp "  Have you verified the fingerprint? (yes/no): " CONFIRMED

if [ "$CONFIRMED" != "yes" ]; then
  echo ""
  echo "Aborted: fingerprint not verified. Re-run after verification."
  exit 1
fi

# --- Step 5: Add peer ---
echo ""
echo "--- Step 5: Add peer ---"

# Use the MYR CLI to add the peer
MYR_BIN="$(dirname "$0")/../../bin/myr.js"
if [ -f "$MYR_BIN" ]; then
  echo "  Running: myr peer add --url $PEER_URL"
  node "$MYR_BIN" peer add --url "$PEER_URL" 2>&1 || {
    echo "  WARNING: CLI peer add returned non-zero. Peer may already be added."
  }
else
  echo "  WARNING: myr CLI not found at $MYR_BIN"
  echo "  Please add the peer manually:"
  echo "    myr peer add --url $PEER_URL"
fi

# --- Step 6: Approve peer ---
echo ""
echo "--- Step 6: Approve peer ---"
echo "  To approve the peer, run:"
echo ""
echo "    myr peer approve <FINGERPRINT>"
echo ""
echo "  Find the fingerprint with:"
echo "    myr peer list"
echo ""

read -rp "  Enter peer fingerprint (SHA-256:xx:xx:...): " FINGERPRINT

if [ -n "$FINGERPRINT" ]; then
  if [ -f "$MYR_BIN" ]; then
    echo "  Running: myr peer approve $FINGERPRINT"
    node "$MYR_BIN" peer approve "$FINGERPRINT" 2>&1 || {
      echo "  WARNING: Approval returned non-zero. Check myr peer list."
    }
  else
    echo "  Please approve manually: myr peer approve $FINGERPRINT"
  fi
else
  echo "  Skipped approval — run 'myr peer approve <fingerprint>' manually."
fi

# --- Step 7: Trigger sync ---
echo ""
echo "--- Step 7: Initial sync ---"
if [ -f "$MYR_BIN" ]; then
  echo "  Running: myr sync-all"
  node "$MYR_BIN" sync-all 2>&1 || {
    echo "  WARNING: Sync returned non-zero. Peer may need to approve you first."
  }
else
  echo "  Please sync manually: myr sync-all"
fi

# --- Step 8: Verify onboarding ---
echo ""
echo "--- Step 8: Post-onboarding verification ---"
sleep 2

POST_HEALTH=$(curl -sf --max-time 10 "$LOCAL_URL/myr/health" 2>/dev/null) || POST_HEALTH=""
if [ -n "$POST_HEALTH" ]; then
  POST_PEERS=$(echo "$POST_HEALTH" | grep -o '"peers_total":[0-9]*' | head -1 | cut -d':' -f2)
  POST_ACTIVE=$(echo "$POST_HEALTH" | grep -o '"peers_active":[0-9]*' | head -1 | cut -d':' -f2)
  echo "  Peers: ${POST_ACTIVE:-?} active / ${POST_PEERS:-?} total"
fi

echo ""
echo "=== Onboarding Summary ==="
echo "  Peer URL: $PEER_URL"
echo "  Peer key: ${PEER_KEY:0:16}..."
echo ""
echo "Next steps:"
echo "  1. Ask the peer to approve your node (mutual approval required)"
echo "  2. Both nodes run: myr sync-all"
echo "  3. Verify sync: bash scripts/pilot/verify-cohort-status.sh $LOCAL_URL"
echo "  4. Peer captures first yield within 24 hours"
echo ""
echo "Done."
