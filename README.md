# Swarm

Multi-agent orchestration plugin for Claude Code. AI teams that collaborate, communicate, and coordinate on shared codebases.

## What it does

Multiple AI agents (Claude Code, Codex, Gemini) work the same repo simultaneously. Agents coordinate via git (persistent state) and WebSocket (real-time messages), distribute tasks by capability match, and escalate hard decisions to humans.

---

## Install

### Claude Code (plugin)

Add to `~/.claude/settings.json`:

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

### Codex / Gemini adapters

```bash
# Codex (OpenAI)
CODEX_API_KEY=sk-... python adapters/codex-wrapper.py \
  --swarm-root /path/to/repo \
  --name "Codex-Bob" \
  --capabilities "backend,python,testing"

# Gemini (Google)
GEMINI_API_KEY=... python adapters/gemini-wrapper.py \
  --swarm-root /path/to/repo \
  --name "Gemini-Carol" \
  --capabilities "frontend,review"
```

The adapter auto-discovers the WebSocket server from `.swarm/.server-url` if it exists.
Each adapter includes `adapters/CODEX.md` in its system prompt so the LLM knows exactly what to do.

---

## Quick start

```
/swarm init                                     # Initialize in any git repo
/swarm task "Build login endpoint" high backend # Create a task
/swarm status                                   # See team + tasks
/swarm claim <task-id>                          # Grab a task
/swarm done "Implemented POST /auth/login"      # Mark complete
```

Start the full stack (WebSocket relay + HTML dashboard):

```bash
node start.js /path/to/your-repo
```

Then open **http://localhost:7379** in any browser.

---

## Commands

| Command | Action |
|---------|--------|
| `/swarm init` | Initialize `.swarm/` in current repo |
| `/swarm join [name] [caps]` | Register this agent |
| `/swarm status` | Show team, tasks, messages |
| `/swarm task "title" [priority] [tags]` | Create task |
| `/swarm assign <id> <agent>` | Assign task to specific agent |
| `/swarm claim <id>` | Claim open task (conflict-free) |
| `/swarm done [result]` | Complete current task |
| `/swarm split <id> "sub1" "sub2"` | Split task into subtasks |
| `/swarm modify task <id> <field> <value>` | Modify task field |
| `/swarm modify agent <name> <field> <value>` | Modify agent field |
| `/swarm modify config <field> <value>` | Modify swarm config |
| `/swarm msg <agent> "text"` | Direct message to agent |
| `/swarm broadcast "text"` | Message all agents |
| `/swarm lead [agent]` | Set team lead |
| `/swarm escalate <message>` | Escalate decision to human |
| `/swarm resolve <id> <decision>` | Resolve escalation |
| `/swarm dashboard` | Start HTML dashboard server, open browser |
| `/swarm server [port]` | Start WebSocket relay server only |
| `/swarm start` | Start full stack (WS server + dashboard) |

---

## Stack

```bash
node start.js [swarm-root] [--ws-port 9377] [--dash-port 7379] [--no-dash]
```

Starts two processes:

| Process | Default port | What it does |
|---------|-------------|--------------|
| `lib/server.js` | 9377 | WebSocket relay — real-time agent messaging |
| `dashboard/web.js` | 7379 | HTTP server — HTML dashboard at localhost:7379 |

The WS server writes its URL to `.swarm/.server-url`. Adapters read this on startup — no manual env var needed.

Run processes separately if preferred:

```bash
node lib/server.js [port] [swarm-root]       # WS relay only
node dashboard/web.js [port] [swarm-root]    # HTML dashboard only
```

---

## HTML Dashboard

Open `http://localhost:7379` after running `node start.js` or `node dashboard/web.js`.

![4-panel grid: Agents | Tasks | Messages | Health]

- **Agents** — status indicator, capabilities, current task
- **Tasks** — grouped by Active / Open / Split / Done, colored by priority
- **Messages** — live message log, most recent first
- **Health & Escalations** — health bars, down agents, pending escalations

Auto-refreshes every 3 seconds. Zero npm dependencies — pure Node.js stdlib.

---

## Task delegation and splitting

Split a large task across agents:

```
# 1. Create the parent task
/swarm task "Build user auth system" high backend

# 2. Split into subtasks
/swarm split <task-id> "Registration endpoint" "Login + JWT" "Token middleware" "Password reset"

# 3. Assign or let agents auto-claim
/swarm assign <subtask-id> <agent-name>
# — or —
# agents see open subtasks on next sync and claim by capability match
```

LLM agents (Codex/Gemini) can also split from inside a cycle:

```
##SWARM:SPLIT:task-uuid:Subtask A|Subtask B|Subtask C##
##SWARM:DELEGATE:task-uuid:agent-uuid##
```

---

## Architecture

```
.swarm/                      # Lives in your git repo (created by /swarm init)
├── config.yaml              # Project settings
├── hierarchy.yaml           # Lead + agent roles
├── agents/
│   └── agent-{uuid}.yaml   # One file per agent
├── tasks/
│   └── task-{uuid}.yaml    # One file per task
├── claims/
│   └── claim-{task}-{agent}-{ts}.yaml   # Claim tickets
├── messages/
│   └── {ts}-{agentid}.yaml # One file per message
└── escalations/
    └── esc-{uuid}.yaml     # Pending human decisions
```

### Design decisions

| Decision | Why |
|----------|-----|
| One file per entity | Zero git merge conflicts |
| Claim tickets (not direct task edit) | Race-safe multi-agent claiming |
| Git for state, WebSocket for messages | Durable + real-time |
| Semi-automatic mode | Agents suggest, humans confirm |
| Zero npm deps in `lib/` | Works anywhere Node.js runs |
| Python adapters use stdlib only | No pip install needed |

### Task scoring

When an agent picks a task to claim:

```
score = capability_match × 0.5 + load_balance × 0.3 + priority × 0.2

capability_match = overlap(agent.capabilities, task.tags) / len(task.tags)
load_balance     = 1 - (active_tasks / max_tasks_per_agent)
priority         : critical=1.0  high=0.75  medium=0.5  low=0.25
```

---

## Features

- **Capability-based task routing** — best agent gets the task
- **Conflict-free claiming** — claim ticket files, winner = earliest timestamp
- **Credit failover** — agent out of credits → tasks auto-reassigned
- **Priority preemption** — critical task arrives → suggests pausing lower-priority work
- **Escalation protocol** — security issues, scope changes, decisions → human queue
- **WebSocket relay** — RFC 6455, zero deps, rate-limited, room support
- **Hybrid mode** — WS for messages + git for state
- **HTML dashboard** — browser-based, auto-refresh, no npm install
- **LLM agent context** — `adapters/CODEX.md` gives agents strict operational rules
- **Auto server discovery** — adapters read `.swarm/.server-url`, no manual config

---

## Project structure

```
skil/
├── lib/                         # Core library (Node.js, zero npm deps)
│   ├── yaml.js                  # YAML parser/serializer
│   ├── git-sync.js              # Git pull/push with retry + backoff
│   ├── agent-registry.js        # Agent CRUD, health, credit failover
│   ├── task-manager.js          # Task CRUD, scoring, claim tickets
│   ├── message-bus.js           # Git-based messaging + auto-protocol
│   ├── hierarchy.js             # Team structure, lead election
│   ├── conflict-resolver.js     # First-push-wins race resolution
│   ├── agent-loop.js            # Sync cycle, escalation, preemption
│   ├── realtime.js              # WebSocket server/client (RFC 6455)
│   ├── realtime-message-bus.js  # Persistent WS connection wrapper
│   └── server.js                # Standalone WS relay entry point
├── dashboard/
│   ├── web.js                   # HTML dashboard server (no npm deps)
│   └── index.js                 # TUI dashboard (blessed, legacy)
├── hooks/                       # Claude Code hooks
│   ├── swarm-config.js          # Shared utils
│   ├── swarm-init.js            # SessionStart hook
│   └── swarm-sync.js            # UserPromptSubmit hook
├── skills/swarm/
│   └── SKILL.md                 # All /swarm commands + behavior rules
├── adapters/
│   ├── codex-wrapper.py         # OpenAI/Codex adapter (stdlib only)
│   ├── gemini-wrapper.py        # Google Gemini adapter (stdlib only)
│   ├── CODEX.md                 # Strict LLM agent operational guide
│   └── adapter-protocol.md     # How to write new adapters
├── .claude-plugin/
│   ├── plugin.json              # Hook registration
│   └── marketplace.json         # Marketplace listing
├── start.js                     # Full-stack launcher (WS + dashboard)
└── CLAUDE.md                    # Codebase instructions
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SWARM_ROOT` | cwd | Swarm repo root path |
| `SWARM_TRANSPORT` | `git` | Transport: `git`, `http`, `hybrid` |
| `SWARM_SERVER_URL` | auto | WebSocket server URL (auto-read from `.swarm/.server-url`) |
| `SWARM_SERVER_PORT` | `9377` | WS relay port |
| `SWARM_DASH_PORT` | `7379` | HTML dashboard port |
| `SWARM_SERVER_TOKEN` | none | Auth token for WS server |
| `SWARM_AGENT_NAME` | hostname | Agent display name |
| `SWARM_CAPABILITIES` | none | Comma-separated capabilities |
| `CODEX_API_KEY` | — | OpenAI API key for Codex adapter |
| `GEMINI_API_KEY` | — | Google AI API key for Gemini adapter |

---

## License

MIT
