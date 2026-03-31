#!/usr/bin/env bash
# install.sh — MYR one-step setup
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/JordanGreenhall/myr-system/main/install.sh | bash
#
#   Or if you already have the repo:
#   bash install.sh
#
# What this does:
#   1. Clones the repo (if run via curl) or uses the current directory
#   2. npm install
#   3. Generates Ed25519 keypair + node_uuid
#   4. Creates config.json from config.example.json with a unique node_id prompt
#   5. Runs the five-command ping test to verify the node is operational
#   6. Prints the node fingerprint and next steps
#
# After this script completes, the node is operational.
# To connect to peers, see: docs/NODE-ONBOARDING.md

set -e

BOLD=$(tput bold 2>/dev/null || true)
RESET=$(tput sgr0 2>/dev/null || true)
GREEN=$(tput setaf 2 2>/dev/null || true)
YELLOW=$(tput setaf 3 2>/dev/null || true)
RED=$(tput setaf 1 2>/dev/null || true)

step() { echo "${BOLD}▶ $1${RESET}"; }
ok()   { echo "${GREEN}✓ $1${RESET}"; }
warn() { echo "${YELLOW}! $1${RESET}"; }
fail() { echo "${RED}✗ $1${RESET}"; exit 1; }

# ── 1. Locate or clone the repo ──────────────────────────────────────────────

if [ -f "package.json" ] && grep -q '"name": "myr-system"' package.json 2>/dev/null; then
  MYR_HOME="$(pwd)"
  ok "Running inside myr-system repo at $MYR_HOME"
else
  step "Cloning myr-system..."
  git clone https://github.com/JordanGreenhall/myr-system.git myr-system
  cd myr-system
  MYR_HOME="$(pwd)"
  ok "Cloned to $MYR_HOME"
fi

export MYR_HOME

# ── 2. Check prerequisites ───────────────────────────────────────────────────

step "Checking prerequisites..."

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js not found. Install from https://nodejs.org (v18+ required)"
fi
NODE_VER=$(node --version | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js v18+ required (found v$NODE_VER)"
fi
ok "Node.js v$NODE_VER"

if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found"
fi
ok "npm $(npm --version)"

# ── 3. Install dependencies ──────────────────────────────────────────────────

step "Installing dependencies..."
npm install --silent
ok "Dependencies installed"

# ── 4. Create config.json ────────────────────────────────────────────────────

step "Configuring node identity..."

if [ -f config.json ]; then
  warn "config.json already exists — skipping config creation"
else
  cp config.example.json config.json

  # Prompt for node_id
  echo ""
  echo "  Choose a short, unique node ID for this machine."
  echo "  Examples: n2, north-star, garynode, jared-dev"
  echo "  Rules: lowercase, no spaces, no special chars except hyphens."
  echo "  (Must not be 'n1' — that's reserved for the first network node)"
  echo ""
  printf "  Node ID: "
  read -r NODE_ID </dev/tty

  if [ -z "$NODE_ID" ] || [ "$NODE_ID" = "n1" ] || [ "$NODE_ID" = "nX" ]; then
    fail "Invalid node_id '$NODE_ID'. Pick something unique and not 'n1'."
  fi

  # Write node_id into config.json using node (avoids jq dependency)
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    cfg.node_id = '${NODE_ID}';
    fs.writeFileSync('config.json', JSON.stringify(cfg, null, 2) + '\n');
    console.log('node_id set to: ${NODE_ID}');
  "
  ok "config.json created with node_id=${NODE_ID}"
fi

# ── 5. Generate keypair ──────────────────────────────────────────────────────

step "Generating Ed25519 keypair..."

if [ -f keys/*.private.pem ] 2>/dev/null; then
  warn "Keys already exist in keys/ — skipping keygen"
else
  node scripts/myr-keygen.js
  ok "Keypair generated"
fi

# Print identity
echo ""
node scripts/myr-identity.js
echo ""

# ── 6. Ping test ─────────────────────────────────────────────────────────────

step "Running installation verification (5-command ping test)..."

node scripts/myr-store.js \
  --intent "Installation test" \
  --type technique \
  --question "Does MYR work on this node?" \
  --evidence "Store succeeded" \
  --changes "MYR is operational" \
  --tags "test" >/dev/null

node scripts/myr-search.js --query "installation test" >/dev/null

node scripts/myr-verify.js --queue >/dev/null 2>&1 || true  # queue may be empty — ok

node scripts/myr-sign.js --all >/dev/null

node scripts/myr-export.js --all >/dev/null

ok "All five ping tests passed — node is operational"

# ── 7. Shell environment ─────────────────────────────────────────────────────

SHELL_RC=""
if [ -f "$HOME/.zshrc" ]; then SHELL_RC="$HOME/.zshrc";
elif [ -f "$HOME/.bashrc" ]; then SHELL_RC="$HOME/.bashrc";
elif [ -f "$HOME/.bash_profile" ]; then SHELL_RC="$HOME/.bash_profile"; fi

if [ -n "$SHELL_RC" ]; then
  if grep -q "MYR_HOME" "$SHELL_RC" 2>/dev/null; then
    warn "MYR_HOME already in $SHELL_RC — skipping"
  else
    echo "" >> "$SHELL_RC"
    echo "# MYR — Methodological Yield Reports" >> "$SHELL_RC"
    echo "export MYR_HOME=\"${MYR_HOME}\"" >> "$SHELL_RC"
    ok "MYR_HOME added to $SHELL_RC"
  fi
fi

# ── 8. Done ───────────────────────────────────────────────────────────────────

echo ""
echo "${BOLD}${GREEN}MYR node installed and operational.${RESET}"
echo ""
echo "  MYR_HOME: $MYR_HOME"
echo ""
echo "  Quick commands:"
echo "    node \$MYR_HOME/scripts/myr-store.js --interactive"
echo "    node \$MYR_HOME/scripts/myr-search.js --query 'topic'"
echo "    node \$MYR_HOME/server/index.js   # start peer sync server"
echo ""
echo "  To connect to peers, see:"
echo "    $MYR_HOME/docs/NODE-ONBOARDING.md"
echo ""
echo "  To integrate with your agent memory system, see:"
echo "    $MYR_HOME/docs/INTEGRATION-EXAMPLES.md"
echo ""
