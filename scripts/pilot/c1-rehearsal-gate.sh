#!/usr/bin/env bash
# c1-rehearsal-gate.sh — Launch-day rehearsal validation for C1 readiness.
# Runs all executable checks that can be verified locally.
# For checks requiring external/operator action, outputs the exact requirement.
#
# Usage: bash scripts/pilot/c1-rehearsal-gate.sh [NODE_URL]
# Example: bash scripts/pilot/c1-rehearsal-gate.sh http://localhost:3719

set -euo pipefail

NODE_URL="${1:-http://localhost:3719}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0
GATE=0  # external action gates

print_result() {
  local status="$1" check="$2" detail="$3"
  case "$status" in
    PASS) printf "  \033[32mPASS\033[0m  %s — %s\n" "$check" "$detail"; PASS=$((PASS + 1)) ;;
    FAIL) printf "  \033[31mFAIL\033[0m  %s — %s\n" "$check" "$detail"; FAIL=$((FAIL + 1)) ;;
    GATE) printf "  \033[33mGATE\033[0m  %s — %s\n" "$check" "$detail"; GATE=$((GATE + 1)) ;;
  esac
}

echo "========================================="
echo "  MYR C1 Launch-Day Rehearsal Gate"
echo "========================================="
echo "Node:    $NODE_URL"
echo "Repo:    $REPO_ROOT"
echo "Time:    $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# -----------------------------------------------
# Gate 1: Regression tests
# -----------------------------------------------
echo "--- Gate 1: Regression Tests ---"
cd "$REPO_ROOT"
if npm test --silent 2>/dev/null; then
  TEST_COUNT=$(npm test --silent 2>&1 | grep -oE '[0-9]+ passing' | head -1 || echo "unknown passing")
  print_result PASS "Regression tests" "$TEST_COUNT"
else
  print_result FAIL "Regression tests" "npm test failed"
fi

# -----------------------------------------------
# Gate 2: Release acceptance tests
# -----------------------------------------------
echo ""
echo "--- Gate 2: Release Acceptance ---"
if npm run test:release --silent 2>/dev/null; then
  print_result PASS "Release acceptance" "npm run test:release passed"
else
  print_result FAIL "Release acceptance" "npm run test:release failed"
fi

# -----------------------------------------------
# Gate 3: Evidence collection
# -----------------------------------------------
echo ""
echo "--- Gate 3: Evidence Collection ---"
if [ -x "$REPO_ROOT/scripts/readiness/collect-evidence.sh" ]; then
  EVIDENCE_OUT=$(bash "$REPO_ROOT/scripts/readiness/collect-evidence.sh" 2>&1) || true
  if [ -f "$REPO_ROOT/artifacts/readiness/evidence-report.json" ]; then
    REC=$(node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(r.recommendation || 'UNKNOWN')" "$REPO_ROOT/artifacts/readiness/evidence-report.json")
    FAILS=$(node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log((r.summary && Number.isFinite(r.summary.fail)) ? r.summary.fail : 0)" "$REPO_ROOT/artifacts/readiness/evidence-report.json")
    if [ "$FAILS" = "0" ]; then
      print_result PASS "Evidence collection" "recommendation=$REC, 0 failures"
    else
      print_result FAIL "Evidence collection" "recommendation=$REC, $FAILS failures"
    fi
  else
    print_result FAIL "Evidence collection" "evidence-report.json not generated"
  fi
else
  print_result FAIL "Evidence collection" "collect-evidence.sh not found or not executable"
fi

# -----------------------------------------------
# Gate 4: Node health (live check)
# -----------------------------------------------
echo ""
echo "--- Gate 4: Node Health ---"
HEALTH=$(curl -sf --max-time 10 "$NODE_URL/myr/health" 2>/dev/null) || HEALTH=""
if [ -n "$HEALTH" ]; then
  STATUS=$(echo "$HEALTH" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ "$STATUS" = "ok" ]; then
    print_result PASS "Node health" "status=ok"
  else
    print_result FAIL "Node health" "status=$STATUS"
  fi
else
  print_result GATE "Node health" "EXTERNAL: node not reachable at $NODE_URL — operator must verify against live URL"
fi

# -----------------------------------------------
# Gate 5: SLO check tooling
# -----------------------------------------------
echo ""
echo "--- Gate 5: SLO Tooling ---"
if [ -f "$REPO_ROOT/scripts/slo-check.js" ]; then
  print_result PASS "SLO check script" "scripts/slo-check.js exists"
else
  print_result FAIL "SLO check script" "scripts/slo-check.js missing"
fi

# -----------------------------------------------
# Gate 6: Pilot scripts
# -----------------------------------------------
echo ""
echo "--- Gate 6: Pilot Scripts ---"
SCRIPTS_OK=true
for SCRIPT in verify-node-health.sh verify-cohort-status.sh onboard-new-peer.sh; do
  if [ -f "$REPO_ROOT/scripts/pilot/$SCRIPT" ]; then
    print_result PASS "Pilot script" "$SCRIPT exists"
  else
    print_result FAIL "Pilot script" "$SCRIPT missing"
    SCRIPTS_OK=false
  fi
done

# -----------------------------------------------
# Gate 7: Documentation
# -----------------------------------------------
echo ""
echo "--- Gate 7: Documentation ---"
DOCS_OK=true
for DOC in docs/OPERATOR-GUIDE.md docs/SUPPORT-OPERATIONS.md docs/RUNBOOKS.md docs/readiness/decision-packet.md docs/pilot-packet/incident-response-card.md docs/readiness/c1-operator-briefing-checklist.md docs/readiness/c1-launch-environment-gate.md; do
  if [ -f "$REPO_ROOT/$DOC" ]; then
    print_result PASS "Documentation" "$DOC"
  else
    print_result FAIL "Documentation" "$DOC missing"
    DOCS_OK=false
  fi
done

# -----------------------------------------------
# Gate 8: Reverse proxy (external action)
# -----------------------------------------------
echo ""
echo "--- Gate 8: Reverse Proxy (External) ---"
print_result GATE "Reverse proxy" "EXTERNAL: each C0 operator must submit TLS + rate-limit evidence per c1-launch-environment-gate.md"

# -----------------------------------------------
# Gate 9: Operator briefing (external action)
# -----------------------------------------------
echo ""
echo "--- Gate 9: Operator Briefing (External) ---"
print_result GATE "Operator briefing" "EXTERNAL: facilitator must complete c1-operator-briefing-checklist.md with all C0 operators"

# -----------------------------------------------
# Gate 10: Onboarding rehearsal
# -----------------------------------------------
echo ""
echo "--- Gate 10: Onboarding Rehearsal ---"
if [ -f "$REPO_ROOT/scripts/pilot/onboard-new-peer.sh" ]; then
  print_result GATE "Onboarding rehearsal" "EXTERNAL: run 'bash scripts/pilot/onboard-new-peer.sh $NODE_URL <peer-url>' with a test peer"
else
  print_result FAIL "Onboarding rehearsal" "onboard-new-peer.sh missing"
fi

# -----------------------------------------------
# Summary
# -----------------------------------------------
echo ""
echo "========================================="
TOTAL=$((PASS + FAIL + GATE))
echo "  Summary: $PASS PASS, $FAIL FAIL, $GATE EXTERNAL GATES (of $TOTAL checks)"
echo "========================================="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "DECISION: NO-GO — $FAIL automated check(s) failed. Fix failures before proceeding."
  exit 1
elif [ "$GATE" -gt 0 ]; then
  echo ""
  echo "DECISION: CONDITIONAL GO WITH EXTERNAL ACTION"
  echo ""
  echo "All automated checks pass. $GATE external action(s) require operator completion:"
  echo "  1. Deploy reverse proxy on all C0 nodes (c1-launch-environment-gate.md)"
  echo "  2. Complete operator briefing with all C0 operators (c1-operator-briefing-checklist.md)"
  echo "  3. Run onboarding rehearsal with a test peer"
  echo ""
  echo "Once all external gates are signed off, C1 invitations may be sent."
  exit 0
else
  echo ""
  echo "DECISION: GO — all checks pass, no external gates remaining."
  exit 0
fi
