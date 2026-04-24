#!/usr/bin/env bash
# verify-cohort-status.sh — Check peer count, sync status, and gossip view for a cohort.
# Usage: bash scripts/pilot/verify-cohort-status.sh [NODE_URL]
# Example: bash scripts/pilot/verify-cohort-status.sh http://localhost:3719

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

echo "=== MYR Cohort Status Check ==="
echo "Node: $NODE_URL"
echo "Time: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# --- Fetch health data ---
HEALTH=$(curl -sf --max-time 10 "$NODE_URL/myr/health" 2>/dev/null) || HEALTH=""

if [ -z "$HEALTH" ]; then
  echo "ERROR: Cannot reach $NODE_URL/myr/health"
  exit 1
fi

# --- Peer Count ---
echo "--- Peer Status ---"
PEERS_ACTIVE=$(echo "$HEALTH" | grep -o '"peers_active":[0-9]*' | head -1 | cut -d':' -f2)
PEERS_TOTAL=$(echo "$HEALTH" | grep -o '"peers_total":[0-9]*' | head -1 | cut -d':' -f2)
REPORTS_TOTAL=$(echo "$HEALTH" | grep -o '"reports_total":[0-9]*' | head -1 | cut -d':' -f2)
REPORTS_SHARED=$(echo "$HEALTH" | grep -o '"reports_shared":[0-9]*' | head -1 | cut -d':' -f2)

PEERS_ACTIVE="${PEERS_ACTIVE:-0}"
PEERS_TOTAL="${PEERS_TOTAL:-0}"

echo "  Peers: $PEERS_ACTIVE active / $PEERS_TOTAL total"
echo "  Reports: ${REPORTS_TOTAL:-0} total, ${REPORTS_SHARED:-0} shared"

# Determine cohort based on peer count
if [ "$PEERS_TOTAL" -le 3 ]; then
  COHORT="C0"
  MIN_PEERS=2
elif [ "$PEERS_TOTAL" -le 10 ]; then
  COHORT="C1"
  MIN_PEERS=5
elif [ "$PEERS_TOTAL" -le 50 ]; then
  COHORT="C2"
  MIN_PEERS=10
else
  COHORT="C3+"
  MIN_PEERS=20
fi

echo "  Estimated cohort: $COHORT (based on $PEERS_TOTAL peers)"
echo ""

# Peer connectivity
if [ "$PEERS_TOTAL" -eq 0 ]; then
  print_result WARN "Peer count" "no peers configured — standalone node"
elif [ "$PEERS_ACTIVE" -eq "$PEERS_TOTAL" ]; then
  print_result PASS "Peer connectivity" "all $PEERS_TOTAL peers active"
else
  OFFLINE=$((PEERS_TOTAL - PEERS_ACTIVE))
  CHURN_PCT=$((OFFLINE * 100 / PEERS_TOTAL))
  if [ "$CHURN_PCT" -lt 10 ]; then
    print_result WARN "Peer connectivity" "$OFFLINE/$PEERS_TOTAL offline ($CHURN_PCT% churn)"
  else
    print_result FAIL "Peer connectivity" "$OFFLINE/$PEERS_TOTAL offline ($CHURN_PCT% churn — exceeds 10% threshold)"
  fi
fi

# --- Sync Status ---
echo ""
echo "--- Sync Status ---"
METRICS=$(curl -sf --max-time 10 "$NODE_URL/myr/metrics" 2>/dev/null) || METRICS=""

if [ -n "$METRICS" ]; then
  SYNC_LAG=$(echo "$METRICS" | grep -o '"sync_lag_seconds":[0-9]*' | head -1 | cut -d':' -f2)
  LAST_SYNC=$(echo "$METRICS" | grep -o '"last_sync_at":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -n "$LAST_SYNC" ] && [ "$LAST_SYNC" != "null" ]; then
    echo "  Last sync: $LAST_SYNC"
  else
    echo "  Last sync: never"
  fi

  if [ -n "$SYNC_LAG" ] 2>/dev/null; then
    echo "  Sync lag: ${SYNC_LAG}s"
    if [ "$SYNC_LAG" -le 60 ]; then
      print_result PASS "Sync freshness" "${SYNC_LAG}s (SLO target: <=60s)"
    elif [ "$SYNC_LAG" -le 300 ]; then
      print_result WARN "Sync freshness" "${SYNC_LAG}s (above SLO target, within tolerance)"
    else
      print_result FAIL "Sync freshness" "${SYNC_LAG}s (exceeds tolerance)"
    fi
  elif [ "$PEERS_TOTAL" -gt 0 ]; then
    print_result WARN "Sync freshness" "could not determine sync lag"
  fi

  # --- Gossip View ---
  echo ""
  echo "--- Gossip Health ---"
  ACTIVE_VIEW=$(echo "$METRICS" | grep -o '"active_view_size":[0-9]*' | head -1 | cut -d':' -f2)
  PASSIVE_VIEW=$(echo "$METRICS" | grep -o '"passive_view_size":[0-9]*' | head -1 | cut -d':' -f2)
  IHAVE_SENT=$(echo "$METRICS" | grep -o '"ihave_sent":[0-9]*' | head -1 | cut -d':' -f2)
  IHAVE_RECV=$(echo "$METRICS" | grep -o '"ihave_received":[0-9]*' | head -1 | cut -d':' -f2)
  IWANT_SENT=$(echo "$METRICS" | grep -o '"iwant_sent":[0-9]*' | head -1 | cut -d':' -f2)
  IWANT_RECV=$(echo "$METRICS" | grep -o '"iwant_received":[0-9]*' | head -1 | cut -d':' -f2)

  FANOUT=5 # default
  if [ -n "$ACTIVE_VIEW" ] 2>/dev/null; then
    echo "  Active view: $ACTIVE_VIEW (fanout: $FANOUT)"
    echo "  Passive view: ${PASSIVE_VIEW:-?}"
    MIN_VIEW=$((FANOUT - 1))
    if [ "$ACTIVE_VIEW" -ge "$MIN_VIEW" ]; then
      print_result PASS "Gossip active view" "$ACTIVE_VIEW >= $MIN_VIEW (fanout - 1)"
    else
      print_result FAIL "Gossip active view" "$ACTIVE_VIEW < $MIN_VIEW — re-bootstrap needed"
    fi
  fi

  IHAVE_SENT="${IHAVE_SENT:-0}"
  IHAVE_RECV="${IHAVE_RECV:-0}"
  IWANT_SENT="${IWANT_SENT:-0}"
  IWANT_RECV="${IWANT_RECV:-0}"

  echo "  IHAVE: sent=$IHAVE_SENT received=$IHAVE_RECV"
  echo "  IWANT: sent=$IWANT_SENT received=$IWANT_RECV"

  if [ "$PEERS_TOTAL" -gt 0 ]; then
    if [ "$IHAVE_SENT" -gt 0 ] && [ "$IHAVE_RECV" -gt 0 ]; then
      print_result PASS "Gossip exchange" "IHAVE flowing in both directions"
    elif [ "$IHAVE_SENT" -gt 0 ] || [ "$IHAVE_RECV" -gt 0 ]; then
      print_result WARN "Gossip exchange" "IHAVE flowing in one direction only"
    else
      print_result FAIL "Gossip exchange" "no IHAVE messages — gossip may be broken"
    fi

    if [ "$IWANT_SENT" -gt 0 ] || [ "$IWANT_RECV" -gt 0 ]; then
      print_result PASS "Report exchange" "IWANT messages present — reports being exchanged"
    else
      print_result WARN "Report exchange" "no IWANT messages — no report requests yet"
    fi
  fi
else
  print_result WARN "Metrics endpoint" "not available (may require auth)"
fi

# --- Cohort Gate Assessment ---
echo ""
echo "--- Cohort Gate Assessment ($COHORT) ---"

case "$COHORT" in
  C0)
    echo "  Gate C0 -> C1 requires:"
    echo "    - All C0 metrics met x2 consecutive weeks"
    echo "    - Gossip transport validated (IHAVE/IWANT operational)"
    echo "    - Governance signal propagation tested"
    echo "    - Onboarding documented + tested with 1 new node"
    if [ "$IHAVE_SENT" -gt 0 ] 2>/dev/null && [ "$IHAVE_RECV" -gt 0 ] 2>/dev/null; then
      print_result PASS "Gossip transport" "IHAVE/IWANT operational"
    else
      print_result WARN "Gossip transport" "not yet validated"
    fi
    ;;
  C1)
    echo "  Gate C1 -> C2 requires:"
    echo "    - All C1 metrics met x3 consecutive weeks"
    echo "    - Subscription enforcement operational"
    echo "    - 3+ domain tags actively used"
    echo "    - Peer sampling validated at N=10"
    echo "    - No Sev1 incidents unresolved in prior 4 weeks"
    ;;
  *)
    echo "  See docs/pilot-packet/checklist-cohort-onboarding.md for gate details"
    ;;
esac

# --- Summary ---
echo ""
TOTAL=$((PASS + FAIL + WARN))
echo "=== Summary: $PASS PASS, $FAIL FAIL, $WARN WARN (of $TOTAL checks) ==="

if [ "$FAIL" -gt 0 ]; then
  echo "RESULT: FAIL — address failures before advancing cohort"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "RESULT: PASS with warnings"
  exit 0
else
  echo "RESULT: PASS"
  exit 0
fi
