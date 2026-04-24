#!/usr/bin/env bash
# verify-node-health.sh — Run health and metrics checks against a MYR node.
# Usage: bash scripts/pilot/verify-node-health.sh [NODE_URL]
# Example: bash scripts/pilot/verify-node-health.sh http://localhost:3719

set -euo pipefail

NODE_URL="${1:-http://localhost:3719}"
PASS=0
FAIL=0
WARN=0

print_result() {
  local status="$1" check="$2" detail="$3"
  case "$status" in
    PASS) printf "  \033[32mPASS\033[0m  %s — %s\n" "$check" "$detail"; PASS=$((PASS + 1)) ;;
    FAIL) printf "  \033[31mFAIL\033[0m  %s — %s\n" "$check" "$detail"; FAIL=$((FAIL + 1)) ;;
    WARN) printf "  \033[33mWARN\033[0m  %s — %s\n" "$check" "$detail"; WARN=$((WARN + 1)) ;;
  esac
}

echo "=== MYR Node Health Check ==="
echo "Node: $NODE_URL"
echo "Time: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# --- Check 1: Health endpoint reachable ---
echo "--- Basic Health ---"
HEALTH=$(curl -sf --max-time 10 "$NODE_URL/myr/health" 2>/dev/null) || HEALTH=""

if [ -z "$HEALTH" ]; then
  print_result FAIL "Health endpoint" "unreachable or returned error"
  echo ""
  echo "=== Summary: 0 PASS, 1 FAIL, 0 WARN ==="
  exit 1
fi

STATUS=$(echo "$HEALTH" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$STATUS" = "ok" ]; then
  print_result PASS "Health status" "$STATUS"
else
  print_result FAIL "Health status" "expected 'ok', got '$STATUS'"
fi

# --- Check 2: Public key present ---
PUB_KEY=$(echo "$HEALTH" | grep -o '"public_key":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$PUB_KEY" ] && [ "$PUB_KEY" != "null" ]; then
  print_result PASS "Public key" "present (${PUB_KEY:0:16}...)"
else
  print_result FAIL "Public key" "missing or null"
fi

# --- Check 3: Uptime ---
UPTIME=$(echo "$HEALTH" | grep -o '"uptime_seconds":[0-9]*' | head -1 | cut -d':' -f2)
if [ -n "$UPTIME" ] && [ "$UPTIME" -gt 0 ] 2>/dev/null; then
  if [ "$UPTIME" -gt 86400 ]; then
    print_result PASS "Uptime" "${UPTIME}s (>24h)"
  else
    print_result WARN "Uptime" "${UPTIME}s (<24h — recently restarted?)"
  fi
else
  print_result WARN "Uptime" "could not parse uptime"
fi

# --- Check 4: Peers ---
PEERS_ACTIVE=$(echo "$HEALTH" | grep -o '"peers_active":[0-9]*' | head -1 | cut -d':' -f2)
PEERS_TOTAL=$(echo "$HEALTH" | grep -o '"peers_total":[0-9]*' | head -1 | cut -d':' -f2)
if [ -n "$PEERS_TOTAL" ] && [ "$PEERS_TOTAL" -gt 0 ] 2>/dev/null; then
  if [ "$PEERS_ACTIVE" -eq "$PEERS_TOTAL" ]; then
    print_result PASS "Peers" "$PEERS_ACTIVE/$PEERS_TOTAL active"
  else
    print_result WARN "Peers" "$PEERS_ACTIVE/$PEERS_TOTAL active (some offline)"
  fi
else
  print_result WARN "Peers" "no peers configured yet"
fi

# --- Check 5: Node health status ---
echo ""
echo "--- Node Status ---"
NODE_HEALTH=$(curl -sf --max-time 10 "$NODE_URL/myr/health/node" 2>/dev/null) || NODE_HEALTH=""

if [ -n "$NODE_HEALTH" ]; then
  NODE_STATUS=$(echo "$NODE_HEALTH" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  case "$NODE_STATUS" in
    green) print_result PASS "Node status" "green" ;;
    yellow) print_result WARN "Node status" "yellow — check sync queue" ;;
    red) print_result FAIL "Node status" "red — sync queue stalled" ;;
    *) print_result WARN "Node status" "unknown status: $NODE_STATUS" ;;
  esac

  QUEUE_AGE=$(echo "$NODE_HEALTH" | grep -o '"queue_age_seconds":[0-9]*' | head -1 | cut -d':' -f2)
  if [ -n "$QUEUE_AGE" ] 2>/dev/null; then
    if [ "$QUEUE_AGE" -le 300 ]; then
      print_result PASS "Queue age" "${QUEUE_AGE}s (<=300s)"
    elif [ "$QUEUE_AGE" -le 1800 ]; then
      print_result WARN "Queue age" "${QUEUE_AGE}s (<=1800s)"
    else
      print_result FAIL "Queue age" "${QUEUE_AGE}s (>1800s — stalled)"
    fi
  fi
else
  print_result WARN "Node health endpoint" "not available"
fi

# --- Check 6: Discovery document ---
echo ""
echo "--- Discovery ---"
DISCOVERY=$(curl -sf --max-time 10 "$NODE_URL/.well-known/myr-node" 2>/dev/null) || DISCOVERY=""

if [ -n "$DISCOVERY" ]; then
  PROTO_VER=$(echo "$DISCOVERY" | grep -o '"protocol_version":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$PROTO_VER" ]; then
    print_result PASS "Discovery document" "protocol $PROTO_VER"
  else
    print_result WARN "Discovery document" "present but no protocol_version"
  fi
else
  print_result FAIL "Discovery document" "/.well-known/myr-node not available"
fi

# --- Check 7: Network health ---
echo ""
echo "--- Network Health ---"
NET_HEALTH=$(curl -sf --max-time 10 "$NODE_URL/myr/health/network" 2>/dev/null) || NET_HEALTH=""

if [ -n "$NET_HEALTH" ]; then
  print_result PASS "Network health endpoint" "reachable"
else
  print_result WARN "Network health endpoint" "not available (may require auth)"
fi

# --- Summary ---
echo ""
TOTAL=$((PASS + FAIL + WARN))
echo "=== Summary: $PASS PASS, $FAIL FAIL, $WARN WARN (of $TOTAL checks) ==="

if [ "$FAIL" -gt 0 ]; then
  echo "RESULT: FAIL — address failures before proceeding"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "RESULT: PASS with warnings"
  exit 0
else
  echo "RESULT: PASS"
  exit 0
fi
