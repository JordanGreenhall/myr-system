#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_URL="${1:-http://localhost:3719}"

cd "$ROOT_DIR"
node scripts/slo-check.js --url "$BASE_URL" "${@:2}"
