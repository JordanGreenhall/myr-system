#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_URL="${1:-http://localhost:3719}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$ROOT_DIR/artifacts/incidents"
OUT_FILE="$OUT_DIR/incident-triage-$TS.md"

mkdir -p "$OUT_DIR"

DB_PATH="$(cd "$ROOT_DIR" && node -e "console.log(require('./scripts/config').db_path)")"

{
  echo "# Incident Triage Snapshot"
  echo
  echo "- Captured at (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- Base URL: $BASE_URL"
  echo "- DB path: $DB_PATH"
  echo

  echo "## Health"
  echo
  for endpoint in /myr/health /myr/health/node /myr/health/network /myr/health/flow; do
    echo "### $endpoint"
    echo
    if ! curl -fsS "$BASE_URL$endpoint"; then
      echo "{\"error\":\"failed_to_fetch\"}"
    fi
    echo
  done

  echo "## Metrics"
  echo
  echo "### /myr/metrics (unsigned attempt)"
  echo
  if ! curl -fsS "$BASE_URL/myr/metrics"; then
    echo "{\"error\":\"metrics_requires_auth_or_failed\"}"
  fi
  echo

  echo "## Recent Traces"
  echo
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 -json "$DB_PATH" "
      SELECT timestamp, event_type, actor_fingerprint, target_fingerprint, outcome, rejection_reason
      FROM myr_traces
      ORDER BY timestamp DESC
      LIMIT 200;
    " || echo "[{\"error\":\"trace_query_failed\"}]"
  else
    echo "[{\"error\":\"sqlite3_not_installed\"}]"
  fi
  echo
} > "$OUT_FILE"

echo "Wrote $OUT_FILE"
