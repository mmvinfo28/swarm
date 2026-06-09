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

### Adding other LLMs (Codex / Gemini)

Three ways, cheapest first:

1. **Background worker, no API key** — runs on the CLI's own plan (`claude -p`, or the
   `codex`/`gemini` CLI):
   ```
   /swarm worker claude "Alice" coordination
   /swarm worker codex  "Cara"  frontend
   ```
   The codex driver auto-finds the OpenAI Codex binary even if it's not on PATH (e.g. the
   desktop app's `%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe`), runs `codex exec` headless,
   uses your plan's model from `~/.codex/config.toml`, and runs at low reasoning effort for
   speed/cost. Override with `SWARM_CODEX_BIN`, `SWARM_CODEX_MODEL`, `SWARM_CODEX_EFFORT`.
2. **Driven CLI agent, no API key** — print a paste-block for a Codex/Gemini CLI window:
   ```
   /swarm onboard "Cara" frontend,testing
   ```
3. **API worker (pay per token)** — set a key, then `/swarm worker codex …`, or run the Python
   adapter directly:
   ```bash
   CODEX_API_KEY=sk-...  python adapters/codex-wrapper.py --swarm-root . --name "Cara" --capabilities backend
   GEMINI_API_KEY=...     python adapters/gemini-wrapper.py --swarm-root . --name "Gus"  --capabilities frontend
   ```

See **Demo: Claude + Codex** below for the full walkthrough.

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

### Team + tasks
| Command | Action |
|---------|--------|
| `/task add "<title>" [priority] [tags]` | **Quick add** a task to the board from any chat (any worker picks it up) |
| `/swarm init` | Initialize `.swarm/` + create a GitHub repo for the project (agents sync through it) |
| `/swarm join [name] [caps]` | Register this agent |
| `/swarm status` | Show team, tasks, messages |
| `/swarm task "title" [priority] [tags]` | Create a task on the board |
| `/swarm assign <id> <agent>` | Assign a task to a specific agent |
| `/swarm claim <id>` | Claim an open task (conflict-free) |
| `/swarm done [result]` | Complete a task you own |
| `/swarm split <id> "sub1" "sub2"` | Split a task into subtasks |
| `/swarm delegate` | Lead hands out open tasks to best agents |
| `/swarm lead [agent]` | Set the team lead |
| `/swarm modify task\|agent\|config …` | Edit a task/agent/config field |

### Communication
| Command | Action |
|---------|--------|
| `/swarm room ["text"]` | View or post to the **common room** (shared chat) |
| `/swarm say <agent> "text"` | Inject a message into an agent's inbox |
| `/swarm msg <agent> "text"` | Direct message to an agent |
| `/swarm broadcast "text"` | Post to the common room |

### Run the swarm
| Command | Action |
|---------|--------|
| `/swarm start` | Start WS server + HTML control panel (detached) |
| `/swarm dashboard` | Start the HTML control panel only |
| `/swarm worker claude\|gemini\|codex [name] [caps]` | Start a **background agent daemon** (Claude = no API key) |
| `/swarm onboard [name] [caps]` | Print a paste-block to drive a Codex/Gemini **CLI** as an agent |
| `/swarm agent codex\|gemini [caps]` | Start a Python **API** worker (needs API key) |
| `/swarm ps` | Show running processes + health |
| `/swarm stop` | Stop all swarm processes |
| `/swarm server [port]` | Start the WebSocket relay only |

Rules are enforced in code: an agent can only `done` a task assigned to it (must `claim`
an open one first) and can't claim another agent's task. Idle workers make **zero** LLM calls.

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

## Control panel (HTML dashboard)

Open `http://localhost:7379` after `/swarm start` (or `node dashboard/web.js`).
This is the main channel — drive the whole swarm from the browser.

4-panel grid, auto-refresh every 3s, zero npm deps:

- **Agents** — status, capabilities, current task
- **Tasks** — create tasks here (title + priority + tags → **Add**); grouped Active/Open/Split/Done
- **Message Flow** — live inbox / outbox / **common room** traffic between agents; the inject box
  sends a message to any agent or the Common Room
- **Health & Escalations** — health bars, down agents, pending escalations

Sending a task from the panel puts it on the board and announces it in the room — idle
background workers wake and claim it.

---

## Demo: Claude + Codex working together

Start with **Claude** (no API key, runs on your Claude plan), then add **Codex**.

### 1. Start the swarm + a Claude lead

In Claude Code, inside your repo:

```
/swarm init
/swarm start                                   # control panel at http://localhost:7379
/swarm worker claude "Alice" coordination,review   # background lead (first worker = lead)
```

`Alice` now runs as a background daemon: she distributes work and reasons via `claude -p`.
Open the dashboard — you'll see Alice online.

### 2. Add a Claude worker

```
/swarm worker claude "Bob" backend,api
```

Two background Claude agents, no API key. Idle = zero tokens.

### 3. Add Codex

**Option A — Codex CLI (no API key, your Codex plan):** if the `codex` CLI is installed:

```
/swarm worker codex "Cara" frontend,testing
```

**Option B — Codex CLI as a driven agent:** print a paste-block and drop it into a Codex CLI window:

```
/swarm onboard "Cara" frontend,testing
```

**Option C — Codex API (pay per token):** set `CODEX_API_KEY`/`OPENAI_API_KEY`, then:

```
/swarm worker codex "Cara" frontend,testing
```

### 4. Send work — from any chat or the dashboard

```
/task add "Build the login form" high frontend
/task add "Add the /api/login endpoint" high backend
```

`/task add` works from any chat. Or type the task into the dashboard's Tasks input. Workers
poll every ~5s and grab a matching task the instant it appears (idle = zero LLM calls), so
there's no waiting. Each task lands in the right agent by capability (`frontend` → Cara,
`backend` → Bob).

### 5. Watch them collaborate

- **Message Flow** panel shows agents claiming tasks, posting to the **common room**, and
  messaging each other.
- Drop a message into the room from the inject box (pick **Common Room**): `"focus on auth first"`
  — every agent sees it on its next tick.
- `/swarm status` and `/swarm room` show the same from the terminal.

### 6. Stop

```
/swarm stop
```

Rules are enforced: an agent can't complete a task it wasn't assigned, and can't grab another's
work — so Claude and Codex don't step on each other.

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
