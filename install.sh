#!/usr/bin/env bash
# swarm — installer for Claude Code (macOS / Linux)
# Installs swarm plugin: copies hooks + lib into Claude config, wires hooks in settings.json
#
# Usage:
#   chmod +x install.sh && ./install.sh
#   ./install.sh --force

set -euo pipefail

FORCE=0
if [ "${1:-}" = "--force" ] || [ "${1:-}" = "-f" ]; then
  FORCE=1
fi

# --- Requirements ---

if ! command -v node &>/dev/null; then
  echo "ERROR: 'node' required. Install from https://nodejs.org" >&2
  exit 1
fi

if ! command -v git &>/dev/null; then
  echo "ERROR: 'git' required. Install from https://git-scm.com" >&2
  exit 1
fi

# --- Paths ---

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PLUGIN_DIR="$CLAUDE_DIR/plugins/swarm"
SETTINGS="$CLAUDE_DIR/settings.json"

# --- Check existing install ---

if [ "$FORCE" -eq 0 ]; then
  if [ -f "$PLUGIN_DIR/lib/yaml.js" ] && \
     [ -f "$PLUGIN_DIR/hooks/swarm-init.js" ] && \
     [ -f "$PLUGIN_DIR/.claude-plugin/plugin.json" ]; then
    echo "Swarm plugin already installed in $PLUGIN_DIR"
    echo "  Re-run with --force to overwrite"
    exit 0
  fi
fi

if [ "$FORCE" -eq 1 ] && [ -d "$PLUGIN_DIR" ]; then
  echo "Reinstalling swarm plugin (--force)..."
else
  echo "Installing swarm plugin..."
fi

# --- Create directory structure ---

mkdir -p "$PLUGIN_DIR/lib/transports"
mkdir -p "$PLUGIN_DIR/lib/drivers"
mkdir -p "$PLUGIN_DIR/hooks"
mkdir -p "$PLUGIN_DIR/skills/swarm/references"
mkdir -p "$PLUGIN_DIR/dashboard"
mkdir -p "$PLUGIN_DIR/adapters"
mkdir -p "$PLUGIN_DIR/.claude-plugin"

# --- Copy files ---

copy_if_exists() {
  local src="$SCRIPT_DIR/$1"
  local dest="$PLUGIN_DIR/$2"
  if [ -f "$src" ]; then
    cp "$src" "$dest"
    return 0
  else
    echo "  SKIP (not found): $1"
    return 1
  fi
}

COPIED=0

# Core lib
for f in yaml.js git-sync.js agent-registry.js task-manager.js message-bus.js io-bus.js \
         hierarchy.js orchestrator.js orchestrator-cli.js actions.js runner.js launch.js \
         swarm-cli.js server.js agent-loop.js realtime.js realtime-message-bus.js; do
  copy_if_exists "lib/$f" "lib/$f" && COPIED=$((COPIED + 1))
done

# Drivers (LLM backends — required by runner.js)
for f in index.js claude.js codex.js gemini.js fake.js; do
  copy_if_exists "lib/drivers/$f" "lib/drivers/$f" && COPIED=$((COPIED + 1))
done

# Transports
for f in base.js git.js http.js index.js; do
  copy_if_exists "lib/transports/$f" "lib/transports/$f" && COPIED=$((COPIED + 1))
done

# Hooks
for f in swarm-config.js swarm-init.js swarm-sync.js swarm-file-guard.js package.json; do
  copy_if_exists "hooks/$f" "hooks/$f" && COPIED=$((COPIED + 1))
done

# Skill
copy_if_exists "skills/swarm/SKILL.md" "skills/swarm/SKILL.md" && COPIED=$((COPIED + 1))
copy_if_exists "skills/swarm/references/protocol.md" "skills/swarm/references/protocol.md" && COPIED=$((COPIED + 1))
copy_if_exists "skills/swarm/references/task-routing.md" "skills/swarm/references/task-routing.md" && COPIED=$((COPIED + 1))

# Plugin metadata
copy_if_exists ".claude-plugin/plugin.json" ".claude-plugin/plugin.json" && COPIED=$((COPIED + 1))
copy_if_exists ".claude-plugin/marketplace.json" ".claude-plugin/marketplace.json" && COPIED=$((COPIED + 1))

# Dashboard (web.js = live HTTP panel launched by launch.js; index.js = legacy TUI)
copy_if_exists "dashboard/web.js" "dashboard/web.js" && COPIED=$((COPIED + 1))
copy_if_exists "dashboard/index.js" "dashboard/index.js" && COPIED=$((COPIED + 1))

# Adapters
copy_if_exists "adapters/codex-wrapper.py" "adapters/codex-wrapper.py" && COPIED=$((COPIED + 1))
copy_if_exists "adapters/gemini-wrapper.py" "adapters/gemini-wrapper.py" && COPIED=$((COPIED + 1))
copy_if_exists "adapters/adapter-protocol.md" "adapters/adapter-protocol.md" && COPIED=$((COPIED + 1))

# Docs
copy_if_exists "CLAUDE.md" "CLAUDE.md" && COPIED=$((COPIED + 1))

echo "  Copied $COPIED files to $PLUGIN_DIR"

# --- Install dashboard dependencies ---

if [ -f "$SCRIPT_DIR/dashboard/package.json" ]; then
  cp "$SCRIPT_DIR/dashboard/package.json" "$PLUGIN_DIR/dashboard/package.json"
  echo "  Installing dashboard dependencies..."
  (cd "$PLUGIN_DIR/dashboard" && npm install --production --silent 2>/dev/null) || \
    echo "  WARNING: Failed to install dashboard deps. Run 'npm install' in $PLUGIN_DIR/dashboard manually."
  echo "  Dashboard deps installed."
fi

# --- Wire hooks into settings.json ---

mkdir -p "$CLAUDE_DIR"

if [ ! -f "$SETTINGS" ]; then
  echo '{}' > "$SETTINGS"
fi

# Backup
cp "$SETTINGS" "$SETTINGS.bak"

export SWARM_SETTINGS="$SETTINGS"
export SWARM_PLUGIN_DIR="$PLUGIN_DIR"

node -e '
const fs = require("fs");
const settingsPath = process.env.SWARM_SETTINGS;
const pluginDir = process.env.SWARM_PLUGIN_DIR;
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
if (!settings.hooks) settings.hooks = {};

// --- SessionStart hook ---
if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
const hasStart = settings.hooks.SessionStart.some(e =>
  e.hooks && e.hooks.some(h => h.command && h.command.includes("swarm-init"))
);
if (!hasStart) {
  settings.hooks.SessionStart.push({
    hooks: [{
      type: "command",
      command: "node \"" + pluginDir + "/hooks/swarm-init.js\"",
      timeout: 10000,
      statusMessage: "Checking swarm status..."
    }]
  });
  console.log("  SessionStart hook registered.");
} else {
  console.log("  SessionStart hook already registered.");
}

// --- UserPromptSubmit hook ---
if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
const hasSync = settings.hooks.UserPromptSubmit.some(e =>
  e.hooks && e.hooks.some(h => h.command && h.command.includes("swarm-sync"))
);
if (!hasSync) {
  settings.hooks.UserPromptSubmit.push({
    hooks: [{
      type: "command",
      command: "node \"" + pluginDir + "/hooks/swarm-sync.js\"",
      timeout: 15000
    }]
  });
  console.log("  UserPromptSubmit hook registered.");
} else {
  console.log("  UserPromptSubmit hook already registered.");
}

// --- Skills path ---
if (!settings.skills) settings.skills = [];
const skillPath = pluginDir + "/skills/swarm";
if (!settings.skills.includes(skillPath)) {
  settings.skills.push(skillPath);
  console.log("  Skill path registered: " + skillPath);
} else {
  console.log("  Skill path already registered.");
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log("  settings.json updated.");
'

# --- Done ---

echo ""
echo "Swarm plugin installed successfully!"
echo ""
echo "What's installed:"
echo "  - Core lib:    $PLUGIN_DIR/lib/"
echo "  - Hooks:       SessionStart (auto-detect swarm repos)"
echo "                 UserPromptSubmit (sync state each prompt)"
echo "  - Skill:       /swarm commands (init, join, task, assign, etc.)"
echo "  - Dashboard:   node $PLUGIN_DIR/dashboard/index.js <repo-path>"
echo "  - Adapters:    codex-wrapper.py, gemini-wrapper.py"
echo ""
echo "Quick start:"
echo "  1. Open Claude Code in any git repo"
echo "  2. Type: /swarm init"
echo "  3. Type: /swarm join MyAgent coding,review"
echo "  4. Start collaborating!"
echo ""
echo "Restart Claude Code to activate hooks."
