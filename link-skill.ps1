# link-skill.ps1 — Dev mode setup: instant skill updates via directory junctions
#
# Run once after cloning:
#   powershell -ExecutionPolicy Bypass -File link-skill.ps1
#
# After this, any change in the repo is immediately visible to Claude Code.
# No restart needed for SKILL.md edits. Restart needed for hook changes.

$repo     = Split-Path -Parent $MyInvocation.MyCommand.Path
$skillDir = Join-Path $repo "skills\swarm"
$claude   = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".claude" }
$target   = Join-Path $claude "skills\swarm"

Write-Host ""
Write-Host "  Swarm dev-mode junction setup" -ForegroundColor Cyan
Write-Host "  Repo:     $repo"
Write-Host "  skillDir: $target"
Write-Host ""

# ── Step 1: Junctions inside skills/swarm/ ──────────────────────────────────
# These let {skillDir}/lib, {skillDir}/dashboard etc. resolve to repo files.

$inner = @{
    "lib"      = "..\..\lib"
    "dashboard" = "..\..\dashboard"
    "adapters" = "..\..\adapters"
    "hooks"    = "..\..\hooks"
    "server"   = "..\..\server"
}

foreach ($name in $inner.Keys) {
    $juncPath   = Join-Path $skillDir $name
    $targetPath = [System.IO.Path]::GetFullPath((Join-Path $skillDir $inner[$name]))

    if (Test-Path $juncPath) {
        Write-Host "  [skip] skills/swarm/$name already exists"
        continue
    }

    if (-not (Test-Path $targetPath)) {
        Write-Host "  [skip] $targetPath not found (optional)" -ForegroundColor DarkYellow
        continue
    }

    $out = cmd /c mklink /J "$juncPath" "$targetPath" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [ok]   skills/swarm/$name -> $($inner[$name])" -ForegroundColor Green
    } else {
        Write-Host "  [fail] $name : $out" -ForegroundColor Red
    }
}

# ── Step 2: Replace ~/.claude/skills/swarm with junction ────────────────────

if (Test-Path $target) {
    $attr = (Get-Item $target -Force).Attributes
    if ($attr -band [System.IO.FileAttributes]::ReparsePoint) {
        Write-Host "  [skip] $target is already a junction"
    } else {
        Write-Host "  Removing old $target ..."
        Remove-Item $target -Recurse -Force
        $out = cmd /c mklink /J "$target" "$skillDir" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [ok]   $target -> $skillDir" -ForegroundColor Green
        } else {
            Write-Host "  [fail] $out" -ForegroundColor Red
        }
    }
} else {
    $parentDir = Split-Path $target -Parent
    if (-not (Test-Path $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }
    $out = cmd /c mklink /J "$target" "$skillDir" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [ok]   $target -> $skillDir" -ForegroundColor Green
    } else {
        Write-Host "  [fail] $out" -ForegroundColor Red
    }
}

# ── Step 3: Junction the sibling `task` skill (/task add ...) ────────────────

$taskSrc = Join-Path $repo "skills\task"
$taskTarget = Join-Path $claude "skills\task"
if (Test-Path $taskSrc) {
    if (Test-Path $taskTarget) {
        $tattr = (Get-Item $taskTarget -Force).Attributes
        if (-not ($tattr -band [System.IO.FileAttributes]::ReparsePoint)) {
            Remove-Item $taskTarget -Recurse -Force
            cmd /c mklink /J "$taskTarget" "$taskSrc" | Out-Null
            Write-Host "  [ok]   $taskTarget -> $taskSrc" -ForegroundColor Green
        } else { Write-Host "  [skip] task skill already a junction" }
    } else {
        cmd /c mklink /J "$taskTarget" "$taskSrc" | Out-Null
        Write-Host "  [ok]   $taskTarget -> $taskSrc" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Done. Repo changes are now instant in Claude Code." -ForegroundColor Green
Write-Host "Restart Claude Code once to pick up the new junction." -ForegroundColor Yellow
Write-Host ""
