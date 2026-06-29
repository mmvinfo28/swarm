# Swarm — Multi-Agent Orchestration Plugin

## What This Is

A Claude Code plugin that enables multiple AI agents (Claude Code, Codex, Gemini) to collaborate on shared codebases. Agents communicate via WebSocket (real-time) and coordinate tasks via git (persistent state).

## Project Structure

```
skil/
├── lib/                          # Core library (Node.js, zero npm deps)
│   ├── yaml.js                   # Minimal YAML parser/serializer
│   ├── git-sync.js               # Git pull/push with retry
│   ├── agent-registry.js         # Agent CRUD + health + credit failover
│   ├── task-manager.js           # Task CRUD + scoring + conflict-free claims
│   ├── message-bus.js            # Messaging + auto-communication protocol
│   ├── hierarchy.js              # Team structure, lead election
│   ├── agent-loop.js             # Escalation engine (detect + queue + human format)
│   ├── realtime.js               # WebSocket server/client (RFC 6455, zero deps)
│   ├── realtime-message-bus.js   # Persistent WS connection wrapper
│   └── transports/               # Pluggable transport layer
│       ├── base.js               # Abstract interface
│       ├── git.js                # Git transport
│       ├── http.js               # HTTP transport + SSE
│       └── index.js              # Factory + auto-detect
├── hooks/                        # Claude Code hooks
│   ├── swarm-config.js           # Shared utils (find root, agent ID, flags)
│   ├── swarm-init.js             # SessionStart: detect, register, emit status
│   ├── swarm-sync.js             # UserPromptSubmit: sync, check assignments
│   └── package.json              # CommonJS marker
├── skills/swarm/                 # Skill definition
│   ├── SKILL.md                  # All /swarm commands + behavior rules
│   └── references/
│       ├── protocol.md           # Git protocol documentation
│       └── task-routing.md       # Task scoring algorithm
├── dashboard/                    # TUI dashboard (blessed)
│   └── index.js                  # 4-panel terminal UI
├── adapters/                     # Non-Claude agent wrappers
│   ├── codex-wrapper.py          # OpenAI/Codex adapter (stdlib only)
│   ├── gemini-wrapper.py         # Google Gemini adapter (stdlib only)
│   └── adapter-protocol.md      # How to write new adapters
├── .claude-plugin/               # Plugin metadata
│   ├── plugin.json               # Hook registration
│   └── marketplace.json          # Marketplace listing
└── CLAUDE.md                     # This file
```

## Key Patterns

### Single source of truth
- SKILL.md defines all behavior
- lib/ modules contain all logic
- Hooks are thin wrappers that call lib/ functions

### Silent-fail hooks
- Hooks never throw or block session start
- All hook code wrapped in try/catch
- If not in a swarm repo → silent exit

### Conflict-free git
- One file per entity (agent, task, message) → zero merge conflicts
- Claim tickets instead of modifying shared files
- hierarchy.yaml → only lead writes

### Hybrid transport
- WebSocket for messages (real-time, <10ms)
- Git for state (tasks, agents, hierarchy — persistent)
- Graceful fallback: if no WS server → git-only mode

## Development

### Run tests
```bash
cd skil
npm test          # node --test — real suite in test/ (zero deps)
```
Covers: conflict-free claims (incl. a real two-clone git race), file-ownership guard,
config read, fence-safe markers, non-destructive stop, dependency auto-unblock,
graceful shutdown, plan-approval. The git race test self-skips if git isn't installed.

### Run dashboard
```bash
cd skil/dashboard && npm install        # first time only
node dashboard/index.js /path/to/swarm-repo
```

### Run adapters
```bash
CODEX_API_KEY=sk-... python adapters/codex-wrapper.py --swarm-root /path/to/repo
GEMINI_API_KEY=... python adapters/gemini-wrapper.py --swarm-root /path/to/repo
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SWARM_TRANSPORT` | Transport: `git`, `http`, `hybrid` |
| `SWARM_SERVER_URL` | WebSocket server URL |
| `SWARM_SERVER_TOKEN` | Auth token for WS server |
| `SWARM_AGENT_NAME` | Agent display name |
| `SWARM_CAPABILITIES` | Comma-separated capabilities |
| `CODEX_API_KEY` | OpenAI API key for Codex adapter |
| `GEMINI_API_KEY` | Google AI API key for Gemini adapter |

## Windows & Sandbox Notes

### PowerShell gotchas
- PowerShell does not support `&&` chaining for native executables. Use `;` or `if ($?) { ... }` instead.
- If the working directory path contains spaces (e.g. `OneDrive - TU Eindhoven`), always quote paths in both PowerShell commands and `node -e` inline scripts.
- When complex quoting is needed, write a temporary `.js` file and run it with `node temp.js` instead of using `node -e "..."` with embedded quotes.

### Git sandbox escalation
- Codex desktop workers may need explicit approval for `git add` and `git commit` operations.
- When a worker is blocked on git permissions, the dashboard should show a pending approval indicator.
- Workaround: Re-run the focused `git add <file>` and `git commit -m "message"` commands with elevated permissions when prompted.
- Consider scoping git commits to task-specific files only.

### Verifying static HTML files without a browser
- The in-app browser may block `file://` URLs and `localhost` by policy (`net::ERR_BLOCKED_BY_CLIENT`).
- Workaround: Test HTML file behavior by loading it in a Node.js VM:
  ```javascript
  const fs = require('fs');
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync('calculator.html', 'utf-8');
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  // Now test DOM interactions programmatically
  ```
- Alternative: Extract inline `<script>` content from the HTML, stub the DOM globals (`document`, `window`), and run the script directly with `eval()` or `vm.runInNewContext()`.
- For swarm tasks that produce static HTML, consider adding a test helper that automates this pattern.

### Git initialization
- `swarm-cli init` now runs `git init` automatically if there is no `.git`, and writes a
  `.gitignore` for runtime state (`.swarm/.run/`, `.swarm/.server-url`, `.swarm/.stopped`,
  `*.pid`, `*.log`). You no longer need to `git init` by hand.
- To create a GitHub remote: `gh repo create <name> --private --source=. --remote=origin --push`.
  On `Name already exists`, pick a new name or reuse the existing remote (`git remote add origin <url>`).

### Runtime workarounds (Windows, observed in real runs)
- **npm blocked by execution policy:** `npm.ps1` may be blocked. Use `npm.cmd test` / `npm.cmd run …`.
- **`Start-Process` PATH bug:** duplicate `Path`/`PATH` env keys can break detached launch. Prefer
  the `lib/launch.js` detached launcher; if verifying a built site, serve it on `http://127.0.0.1:<port>`.
- **`file://` blocked:** the in-app browser blocks `file://`. Serve static sites over `http://127.0.0.1`.
- **CLI `done`/`room` "timeout":** the swarm CLI now pushes git in a detached background process,
  so commands return instantly even on a slow network — the old false-negative (task file written
  but CLI hung/timed out) is fixed. A slow push is never a reason to re-submit or stop.
