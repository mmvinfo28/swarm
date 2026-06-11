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
│   ├── conflict-resolver.js      # First-push-wins race resolution
│   ├── agent-loop.js             # Autonomous conversation + escalation engine
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
node -e "require('./lib/yaml')"        # verify modules load
node -e "require('./lib/agent-loop')"   # verify full stack
```

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
- If the repo directory is empty (no `.git`), you must run `git init` before `swarm init`.
- To create a GitHub remote: `gh repo create <name> --private --source=. --remote=origin --push`
