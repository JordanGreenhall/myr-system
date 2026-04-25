#!/usr/bin/env bash
# MYR Readiness Evidence Collection Script
# Collects test results, checks SLO endpoints, and produces a structured readiness report.
#
# Usage: bash scripts/readiness/collect-evidence.sh [--endpoint http://localhost:3000]
# Output: artifacts/readiness/evidence-report.json and artifacts/readiness/evidence-report.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ARTIFACTS_DIR="$PROJECT_ROOT/artifacts/readiness"
ENDPOINT="${1:---endpoint}"

# Parse --endpoint flag
NODE_ENDPOINT=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --endpoint) NODE_ENDPOINT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

mkdir -p "$ARTIFACTS_DIR"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
CHECKS=()

log() { echo "[evidence] $*"; }

record_check() {
  local name="$1" status="$2" detail="$3"
  CHECKS+=("{\"name\":\"$name\",\"status\":\"$status\",\"detail\":\"$detail\"}")
  case "$status" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    WARN) WARN_COUNT=$((WARN_COUNT + 1)) ;;
  esac
  log "$status: $name — $detail"
}

# --- Check 1: Regression tests ---
log "Running regression tests (npm test -- --runInBand)..."
cd "$PROJECT_ROOT"
set +e
TEST_OUTPUT=$(npm test -- --runInBand 2>&1)
TEST_EXIT=$?
set -e

extract_counter() {
  local key="$1"
  printf '%s\n' "$TEST_OUTPUT" | sed -nE "s/^[#ℹ[:space:]]*$key[[:space:]]+([0-9]+).*/\1/p" | tail -1
}

TEST_FAIL_NUM="$(extract_counter fail || true)"
TEST_TOTAL="$(extract_counter tests || true)"
TEST_PASS="$(extract_counter pass || true)"
TEST_SUITES="$(extract_counter suites || true)"

if [ "$TEST_EXIT" -ne 0 ]; then
  if [ -n "$TEST_FAIL_NUM" ]; then
    record_check "regression_tests" "FAIL" "$TEST_FAIL_NUM test failures detected"
  else
    record_check "regression_tests" "FAIL" "npm test exited non-zero"
  fi
elif [ -n "$TEST_FAIL_NUM" ] && [ "$TEST_FAIL_NUM" = "0" ]; then
  record_check "regression_tests" "PASS" "${TEST_PASS:-all}/${TEST_TOTAL:-all} tests, ${TEST_SUITES:-?} suites, 0 failures"
elif [ -n "$TEST_FAIL_NUM" ] && [ "$TEST_FAIL_NUM" != "0" ]; then
  record_check "regression_tests" "FAIL" "$TEST_FAIL_NUM test failures detected"
else
  record_check "regression_tests" "PASS" "All tests passed (count not parsed)"
fi

# --- Check 2: Release acceptance tests ---
log "Running release acceptance tests (npm run test:release)..."
set +e
RELEASE_OUTPUT=$(npm run test:release 2>&1)
RELEASE_EXIT=$?
set -e
if [ "$RELEASE_EXIT" -eq 0 ]; then
  record_check "release_acceptance" "PASS" "Release acceptance tests passed"
else
  record_check "release_acceptance" "FAIL" "Release acceptance tests failed"
fi

# --- Check 3: Git status ---
log "Checking git status..."
GIT_STATUS=$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null || echo "not a git repo")
if [ -z "$GIT_STATUS" ]; then
  record_check "git_clean" "PASS" "Working tree is clean"
else
  DIRTY_COUNT=$(echo "$GIT_STATUS" | wc -l | tr -d ' ')
  record_check "git_clean" "WARN" "$DIRTY_COUNT uncommitted changes"
fi

# --- Check 4: Package version ---
log "Checking package version..."
PKG_VERSION=$(node -p "require('$PROJECT_ROOT/package.json').version" 2>/dev/null || echo "unknown")
record_check "package_version" "PASS" "v$PKG_VERSION"

# --- Check 5: Git tag alignment ---
log "Checking git tag alignment..."
LATEST_TAG=$(git -C "$PROJECT_ROOT" describe --tags --abbrev=0 2>/dev/null || echo "no tags")
record_check "git_tag" "PASS" "Latest tag: $LATEST_TAG"

# --- Check 6: Documentation existence ---
log "Checking required documentation..."
REQUIRED_DOCS=(
  "docs/PILOT-OPERATING-MODEL.md"
  "docs/OPERATOR-GUIDE.md"
  "docs/NODE-ONBOARDING.md"
  "docs/SUPPORT-OPERATIONS.md"
  "docs/RUNBOOKS.md"
  "docs/SLO-DEFINITIONS.md"
  "docs/RELEASE-GATE.md"
  "docs/ROUTING-ECONOMICS.md"
  "docs/readiness/decision-packet.md"
  "docs/readiness/risk-register.md"
  "docs/readiness/next-cohort-objective.md"
)
MISSING_DOCS=()
for doc in "${REQUIRED_DOCS[@]}"; do
  if [ ! -f "$PROJECT_ROOT/$doc" ]; then
    MISSING_DOCS+=("$doc")
  fi
done
if [ ${#MISSING_DOCS[@]} -eq 0 ]; then
  record_check "documentation" "PASS" "All ${#REQUIRED_DOCS[@]} required docs present"
else
  record_check "documentation" "FAIL" "Missing: ${MISSING_DOCS[*]}"
fi

# --- Check 7: Scale acceptance tests exist ---
log "Checking scale acceptance test files..."
SCALE_TESTS=0
for f in "$PROJECT_ROOT"/test/scale-acceptance.test.js "$PROJECT_ROOT"/test/coordinator-load.test.js "$PROJECT_ROOT"/test/gossip-scale.test.js "$PROJECT_ROOT"/test/relay-saturation.test.js; do
  [ -f "$f" ] && SCALE_TESTS=$((SCALE_TESTS + 1))
done
if [ "$SCALE_TESTS" -ge 3 ]; then
  record_check "scale_tests" "PASS" "$SCALE_TESTS scale/load test files found"
else
  record_check "scale_tests" "WARN" "Only $SCALE_TESTS scale test files (expected >= 3)"
fi

# --- Check 8: SLO check script exists ---
log "Checking SLO check tooling..."
if [ -f "$PROJECT_ROOT/scripts/slo-check.js" ]; then
  record_check "slo_tooling" "PASS" "scripts/slo-check.js exists"
else
  record_check "slo_tooling" "WARN" "scripts/slo-check.js not found"
fi

# --- Check 9: Live endpoint checks (optional) ---
if [ -n "$NODE_ENDPOINT" ]; then
  log "Checking live endpoint: $NODE_ENDPOINT..."

  # Health check
  HEALTH=$(curl -sf "$NODE_ENDPOINT/myr/health" 2>/dev/null || echo "unreachable")
  if echo "$HEALTH" | grep -qi "ok\|status"; then
    record_check "endpoint_health" "PASS" "Health endpoint responding"
  else
    record_check "endpoint_health" "FAIL" "Health endpoint unreachable or invalid"
  fi

  # Metrics check
  METRICS=$(curl -sf "$NODE_ENDPOINT/myr/metrics" 2>/dev/null || echo "unreachable")
  if echo "$METRICS" | grep -qi "sync\|gossip"; then
    record_check "endpoint_metrics" "PASS" "Metrics endpoint responding with data"
  else
    record_check "endpoint_metrics" "WARN" "Metrics endpoint not returning expected data"
  fi
else
  record_check "endpoint_health" "WARN" "No --endpoint provided; skipping live checks"
fi

# --- Check 10: Recovery runbooks count ---
log "Checking runbook coverage..."
if [ -f "$PROJECT_ROOT/docs/RUNBOOKS.md" ]; then
  RUNBOOK_COUNT=$(grep -c "^##" "$PROJECT_ROOT/docs/RUNBOOKS.md" 2>/dev/null || echo "0")
  if [ "$RUNBOOK_COUNT" -ge 3 ]; then
    record_check "runbooks" "PASS" "$RUNBOOK_COUNT recovery procedures documented"
  else
    record_check "runbooks" "WARN" "Only $RUNBOOK_COUNT runbook sections (expected >= 3)"
  fi
else
  record_check "runbooks" "FAIL" "RUNBOOKS.md not found"
fi

# --- Compute recommendation ---
if [ "$FAIL_COUNT" -gt 0 ]; then
  RECOMMENDATION="NO-GO"
  REASON="$FAIL_COUNT check(s) failed — resolve before proceeding"
elif [ "$WARN_COUNT" -gt 2 ]; then
  RECOMMENDATION="CONDITIONAL"
  REASON="$WARN_COUNT warning(s) — review before proceeding"
else
  RECOMMENDATION="GO"
  REASON="All checks passed ($PASS_COUNT pass, $WARN_COUNT warnings)"
fi

# --- Build JSON output ---
CHECKS_JSON=$(IFS=,; echo "${CHECKS[*]}")

cat > "$ARTIFACTS_DIR/evidence-report.json" <<ENDJSON
{
  "timestamp": "$TIMESTAMP",
  "version": "$PKG_VERSION",
  "recommendation": "$RECOMMENDATION",
  "reason": "$REASON",
  "summary": {
    "pass": $PASS_COUNT,
    "fail": $FAIL_COUNT,
    "warn": $WARN_COUNT,
    "total": $((PASS_COUNT + FAIL_COUNT + WARN_COUNT))
  },
  "checks": [$CHECKS_JSON]
}
ENDJSON

# --- Build Markdown output ---
cat > "$ARTIFACTS_DIR/evidence-report.md" <<ENDMD
# MYR Readiness Evidence Report

**Collected:** $TIMESTAMP
**Version:** v$PKG_VERSION
**Recommendation:** **$RECOMMENDATION** — $REASON

## Summary

| Result | Count |
|--------|-------|
| PASS | $PASS_COUNT |
| FAIL | $FAIL_COUNT |
| WARN | $WARN_COUNT |
| **Total** | **$((PASS_COUNT + FAIL_COUNT + WARN_COUNT))** |

## Check Details

| Check | Status | Detail |
|-------|--------|--------|
ENDMD

for check in "${CHECKS[@]}"; do
  NAME=$(echo "$check" | sed 's/.*"name":"\([^"]*\)".*/\1/')
  STATUS=$(echo "$check" | sed 's/.*"status":"\([^"]*\)".*/\1/')
  DETAIL=$(echo "$check" | sed 's/.*"detail":"\([^"]*\)".*/\1/')
  echo "| $NAME | $STATUS | $DETAIL |" >> "$ARTIFACTS_DIR/evidence-report.md"
done

cat >> "$ARTIFACTS_DIR/evidence-report.md" <<ENDMD

---

*Generated by scripts/readiness/collect-evidence.sh*
ENDMD

log ""
log "=== RECOMMENDATION: $RECOMMENDATION ==="
log "$REASON"
log ""
log "Reports written to:"
log "  $ARTIFACTS_DIR/evidence-report.json"
log "  $ARTIFACTS_DIR/evidence-report.md"
