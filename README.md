# Swarm

Multi-agent orchestration plugin for Claude Code. AI teams that collaborate, communicate, and coordinate.

## What It Does

Multiple AI agents (Claude Code, Codex, Gemini) work together on the same codebase. Agents communicate via git (persistent) and WebSocket (real-time), distribute tasks based on capabilities, and escalate hard decisions to humans.

## Install

### Claude Code (plugin)

Add to your `~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "swarm@swarm": true
  },
  "extraKnownMarketplaces": {
    "swarm": {
      "source": {
        "source": "github",
        "repo": "mmvinfo28/swarm"
      }
    }
  }
}
```

Restart Claude Code. `/swarm` commands are now available.

### Codex / Gemini (adapters)

```bash
# Codex
CODEX_API_KEY=sk-... python adapters/codex-wrapper.py --swarm-root /path/to/repo --name "Codex-Bob" --capabilities "testing,qa"

# Gemini
GEMINI_API_KEY=... python adapters/gemini-wrapper.py --swarm-root /path/to/repo --name "Gemini-Carol" --capabilities "coding,review"
```

Or add `AGENTS.md` to your repo for native Codex integration (no wrapper needed).

## Quick Start

```
/swarm init                                    # Initialize in any git repo
/swarm task "Build auth module" high coding    # Create a task
/swarm status                                  # See team + tasks
/swarm claim <task-id>                         # Grab a task
/swarm done "JWT auth with RS256"              # Mark complete
```

## Commands

| Command | Action |
|---------|--------|
| `/swarm init` | Initialize `.swarm/` in current repo |
| `/swarm join [name] [caps]` | Register this agent |
| `/swarm status` | Show team, tasks, messages |
| `/swarm task "title" [priority] [tags]` | Create task |
| `/swarm assign <id> <agent>` | Assign task |
| `/swarm claim <id>` | Claim open task |
| `/swarm done [result]` | Complete current task |
| `/swarm modify <what> <id> <field> <value>` | Modify task/agent/config |
| `/swarm msg <agent> "text"` | Direct message |
| `/swarm broadcast "text"` | Message all agents |
| `/swarm lead [agent]` | Set team lead |
| `/swarm split <id> "sub1" "sub2"` | Split into subtasks |
| `/swarm escalate <message>` | Escalate to human |
| `/swarm resolve <id> <decision>` | Resolve escalation |
| `/swarm dashboard` | Launch TUI dashboard |
| `/swarm server [port]` | Start WebSocket server |

## Architecture

```
.swarm/                     # In your git repo (auto-created by /swarm init)
+-- config.yaml             # Project settings
+-- agents/                 # One file per agent (zero conflicts)
+-- tasks/                  # One file per task
+-- claims/                 # Claim tickets (conflict-free task claiming)
+-- messages/               # One file per message
+-- escalations/            # Decisions needing human input
+-- hierarchy.yaml          # Team structure
```

### Key Design Decisions

- **One file per entity** = zero git merge conflicts
- **Claim tickets** instead of direct task modification = race-safe
- **Semi-automatic** = agents suggest, humans confirm
- **Pluggable transport** = git (default), WebSocket (real-time), HTTP (API)
- **Zero npm deps** in core lib (only `blessed` for dashboard)
- **Python adapters use stdlib only** (no pip install)

## Features

- **Task routing** with capability-based scoring
- **Credit failover** when an agent runs out of API credits
- **Priority preemption** for critical tasks
- **Escalation protocol** for security issues, scope changes, hard decisions
- **WebSocket messaging** (RFC 6455, zero deps)
- **TUI dashboard** with 4 panels (team, tasks, agents, messages)
- **Hybrid mode** WebSocket for messages + git for state

## Dashboard

```bash
cd swarm/dashboard && npm install
node dashboard/index.js /path/to/your-repo
```

4-panel terminal UI: Team Tree | Task Board | Agent Status | Messages

## License

MIT
