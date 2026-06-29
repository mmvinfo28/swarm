# swarm — installer for Claude Code (Windows PowerShell)
# Installs swarm plugin: copies hooks + lib into Claude config, wires hooks in settings.json
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Force
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# --- Requirements ---

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: 'node' required. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: 'git' required. Install from https://git-scm.com" -ForegroundColor Red
    exit 1
}

# --- Paths ---

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".claude" }
$PluginDir = Join-Path $ClaudeDir "plugins" "swarm"
$Settings = Join-Path $ClaudeDir "settings.json"

# --- Check existing install ---

if (-not $Force) {
    if ((Test-Path (Join-Path $PluginDir "lib" "yaml.js")) -and
        (Test-Path (Join-Path $PluginDir "hooks" "swarm-init.js")) -and
        (Test-Path (Join-Path $PluginDir ".claude-plugin" "plugin.json"))) {

        Write-Host "Swarm plugin already installed in $PluginDir" -ForegroundColor Yellow
        Write-Host "  Re-run with -Force to overwrite: powershell -File install.ps1 -Force"
        exit 0
    }
}

if ($Force -and (Test-Path $PluginDir)) {
    Write-Host "Reinstalling swarm plugin (-Force)..." -ForegroundColor Cyan
} else {
    Write-Host "Installing swarm plugin..." -ForegroundColor Cyan
}

# --- Create plugin directory structure ---

$dirs = @(
    $PluginDir,
    (Join-Path $PluginDir "lib"),
    (Join-Path $PluginDir "lib" "transports"),
    (Join-Path $PluginDir "lib" "drivers"),
    (Join-Path $PluginDir "hooks"),
    (Join-Path $PluginDir "skills" "swarm" "references"),
    (Join-Path $PluginDir "dashboard"),
    (Join-Path $PluginDir "adapters"),
    (Join-Path $PluginDir ".claude-plugin")
)

foreach ($d in $dirs) {
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
}

# --- Copy files ---

$fileMappings = @(
    # Core lib
    @{ src = "lib\yaml.js";                dest = "lib\yaml.js" },
    @{ src = "lib\git-sync.js";            dest = "lib\git-sync.js" },
    @{ src = "lib\agent-registry.js";      dest = "lib\agent-registry.js" },
    @{ src = "lib\task-manager.js";        dest = "lib\task-manager.js" },
    @{ src = "lib\message-bus.js";         dest = "lib\message-bus.js" },
    @{ src = "lib\io-bus.js";              dest = "lib\io-bus.js" },
    @{ src = "lib\hierarchy.js";           dest = "lib\hierarchy.js" },
    @{ src = "lib\orchestrator.js";        dest = "lib\orchestrator.js" },
    @{ src = "lib\orchestrator-cli.js";    dest = "lib\orchestrator-cli.js" },
    @{ src = "lib\actions.js";             dest = "lib\actions.js" },
    @{ src = "lib\runner.js";              dest = "lib\runner.js" },
    @{ src = "lib\launch.js";              dest = "lib\launch.js" },
    @{ src = "lib\swarm-cli.js";           dest = "lib\swarm-cli.js" },
    @{ src = "lib\server.js";              dest = "lib\server.js" },
    @{ src = "lib\agent-loop.js";          dest = "lib\agent-loop.js" },
    @{ src = "lib\realtime.js";            dest = "lib\realtime.js" },
    @{ src = "lib\realtime-message-bus.js"; dest = "lib\realtime-message-bus.js" },
    # Drivers (LLM backends — required by runner.js)
    @{ src = "lib\drivers\index.js";       dest = "lib\drivers\index.js" },
    @{ src = "lib\drivers\claude.js";      dest = "lib\drivers\claude.js" },
    @{ src = "lib\drivers\codex.js";       dest = "lib\drivers\codex.js" },
    @{ src = "lib\drivers\gemini.js";      dest = "lib\drivers\gemini.js" },
    @{ src = "lib\drivers\fake.js";        dest = "lib\drivers\fake.js" },
    # Transports
    @{ src = "lib\transports\base.js";     dest = "lib\transports\base.js" },
    @{ src = "lib\transports\git.js";      dest = "lib\transports\git.js" },
    @{ src = "lib\transports\http.js";     dest = "lib\transports\http.js" },
    @{ src = "lib\transports\index.js";    dest = "lib\transports\index.js" },
    # Hooks
    @{ src = "hooks\swarm-config.js";      dest = "hooks\swarm-config.js" },
    @{ src = "hooks\swarm-init.js";        dest = "hooks\swarm-init.js" },
    @{ src = "hooks\swarm-sync.js";        dest = "hooks\swarm-sync.js" },
    @{ src = "hooks\swarm-file-guard.js";  dest = "hooks\swarm-file-guard.js" },
    @{ src = "hooks\package.json";         dest = "hooks\package.json" },
    # Skill
    @{ src = "skills\swarm\SKILL.md";      dest = "skills\swarm\SKILL.md" },
    @{ src = "skills\swarm\references\protocol.md";      dest = "skills\swarm\references\protocol.md" },
    @{ src = "skills\swarm\references\task-routing.md";   dest = "skills\swarm\references\task-routing.md" },
    # Plugin metadata
    @{ src = ".claude-plugin\plugin.json";      dest = ".claude-plugin\plugin.json" },
    @{ src = ".claude-plugin\marketplace.json"; dest = ".claude-plugin\marketplace.json" },
    # Dashboard (web.js = live HTTP panel; index.js = legacy TUI)
    @{ src = "dashboard\web.js";           dest = "dashboard\web.js" },
    @{ src = "dashboard\index.js";         dest = "dashboard\index.js" },
    # Adapters
    @{ src = "adapters\codex-wrapper.py";       dest = "adapters\codex-wrapper.py" },
    @{ src = "adapters\gemini-wrapper.py";      dest = "adapters\gemini-wrapper.py" },
    @{ src = "adapters\adapter-protocol.md";    dest = "adapters\adapter-protocol.md" },
    # Docs
    @{ src = "CLAUDE.md";                  dest = "CLAUDE.md" }
)

$copied = 0
foreach ($mapping in $fileMappings) {
    $srcPath = Join-Path $ScriptDir $mapping.src
    $destPath = Join-Path $PluginDir $mapping.dest

    if (Test-Path $srcPath) {
        Copy-Item $srcPath $destPath -Force
        $copied++
    } else {
        Write-Host "  SKIP (not found): $($mapping.src)" -ForegroundColor DarkYellow
    }
}
Write-Host "  Copied $copied files to $PluginDir" -ForegroundColor Green

# --- Install dashboard dependencies ---

$dashPkg = Join-Path $ScriptDir "dashboard" "package.json"
if (Test-Path $dashPkg) {
    Copy-Item $dashPkg (Join-Path $PluginDir "dashboard" "package.json") -Force
    Write-Host "  Installing dashboard dependencies..."
    Push-Location (Join-Path $PluginDir "dashboard")
    try {
        npm install --production --silent 2>$null
        Write-Host "  Dashboard deps installed." -ForegroundColor Green
    } catch {
        Write-Host "  WARNING: Failed to install dashboard deps. Run 'npm install' in $PluginDir\dashboard manually." -ForegroundColor Yellow
    }
    Pop-Location
}

# --- Wire hooks into settings.json ---

if (-not (Test-Path $Settings)) {
    Set-Content -Path $Settings -Value "{}" -Encoding utf8
}

# Backup
Copy-Item $Settings "$Settings.bak" -Force

$env:SWARM_SETTINGS = $Settings -replace '\\', '/'
$env:SWARM_PLUGIN_DIR = $PluginDir -replace '\\', '/'

$nodeScript = @'
const fs = require('fs');
const settingsPath = process.env.SWARM_SETTINGS;
const pluginDir = process.env.SWARM_PLUGIN_DIR;
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
if (!settings.hooks) settings.hooks = {};

// --- SessionStart hook ---
if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
const hasStart = settings.hooks.SessionStart.some(e =>
  e.hooks && e.hooks.some(h => h.command && h.command.includes('swarm-init'))
);
if (!hasStart) {
  settings.hooks.SessionStart.push({
    hooks: [{
      type: 'command',
      command: 'node "' + pluginDir + '/hooks/swarm-init.js"',
      timeout: 10000,
      statusMessage: 'Checking swarm status...'
    }]
  });
  console.log('  SessionStart hook registered.');
} else {
  console.log('  SessionStart hook already registered.');
}

// --- UserPromptSubmit hook ---
if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
const hasSync = settings.hooks.UserPromptSubmit.some(e =>
  e.hooks && e.hooks.some(h => h.command && h.command.includes('swarm-sync'))
);
if (!hasSync) {
  settings.hooks.UserPromptSubmit.push({
    hooks: [{
      type: 'command',
      command: 'node "' + pluginDir + '/hooks/swarm-sync.js"',
      timeout: 15000
    }]
  });
  console.log('  UserPromptSubmit hook registered.');
} else {
  console.log('  UserPromptSubmit hook already registered.');
}

// --- Skills path ---
if (!settings.skills) settings.skills = [];
const skillPath = pluginDir + '/skills/swarm';
if (!settings.skills.includes(skillPath)) {
  settings.skills.push(skillPath);
  console.log('  Skill path registered: ' + skillPath);
} else {
  console.log('  Skill path already registered.');
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log('  settings.json updated.');
'@

node -e $nodeScript

# --- Done ---

Write-Host ""
Write-Host "Swarm plugin installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "What's installed:" -ForegroundColor White
Write-Host "  - Core lib:    $PluginDir\lib\"
Write-Host "  - Hooks:       SessionStart (auto-detect swarm repos)"
Write-Host "                 UserPromptSubmit (sync state each prompt)"
Write-Host "  - Skill:       /swarm commands (init, join, task, assign, etc.)"
Write-Host "  - Dashboard:   node $PluginDir\dashboard\index.js <repo-path>"
Write-Host "  - Adapters:    codex-wrapper.py, gemini-wrapper.py"
Write-Host ""
Write-Host "Quick start:" -ForegroundColor Cyan
Write-Host "  1. Open Claude Code in any git repo"
Write-Host "  2. Type: /swarm init"
Write-Host "  3. Type: /swarm join MyAgent coding,review"
Write-Host "  4. Start collaborating!"
Write-Host ""
Write-Host "Restart Claude Code to activate hooks." -ForegroundColor Yellow
