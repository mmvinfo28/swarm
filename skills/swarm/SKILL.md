---
name: swarm
description: >
  Multi-agent orchestration skill. Enables teams of AI agents (Claude Code, Codex, Gemini)
  to collaborate on shared codebases. Agents communicate via WebSocket (real-time) and
  coordinate tasks via git (persistent state). Use when user says /swarm, mentions team
  coordination, or when swarm hooks detect an active .swarm/ directory.
---

# Swarm — Multi-Agent Orchestration

You are part of a swarm team. Multiple AI agents collaborate on the same codebase.
Your actions affect the whole team. Coordinate, don't duplicate work.

## Commands

| Command | Action |
|---------|--------|
| `/swarm init` | Initialize `.swarm/` directory in current repo. Creates config, agents/, tasks/, claims/ dirs. |
| `/swarm join [name] [capabilities...]` | Register this agent. Example: `/swarm join "Claude-Alice" frontend,react,testing` |
| `/swarm status` | Show team status: agents, tasks, hierarchy, health. |
| `/swarm task "title" [priority] [tags]` | Create new task. Example: `/swarm task "Build login form" high frontend,react` |
| `/swarm assign <task-id> <agent-name>` | Assign task to specific agent. |
| `/swarm claim <task-id>` | Claim an open task for yourself. Uses conflict-free claim tickets. |
| `/swarm done [result]` | Mark current task as completed with result summary. |
| `/swarm msg <agent-name> "text"` | Send direct message to another agent. |
| `/swarm broadcast "text"` | Send message to all agents. |
| `/swarm lead [agent-name]` | Set team lead. Lead manages hierarchy and task distribution. |
| `/swarm delegate` | Lead distributes all open tasks to best-matched agents and sends each a work prompt. Runs `node {skillDir}/lib/orchestrator-cli.js distribute {swarmRoot} {myAgentId}`. (Also happens automatically each turn when you are lead.) |
| `/swarm agent codex\|gemini [capabilities]` | Launch a Codex/Gemini **API** worker (needs API key) as a detached background process. Runs `node {skillDir}/lib/launch.js agent <provider> {swarmRoot} [caps]`. |
| `/swarm onboard [name] [capabilities]` | **No API key.** Print a ready-to-paste start command for a Codex CLI / Gemini CLI agent. They read `SWARM-AGENT.md` and drive the swarm via `lib/swarm-cli.js` on their own Pro/CLI plan. See "Onboard a CLI agent" below. |
| `/swarm worker claude\|gemini\|codex [name] [caps]` | **No API key (claude).** Start a **background agent daemon** that loops inbox → reason (`claude -p` headless) → act. Runs `node {skillDir}/lib/launch.js worker <provider> {swarmRoot} "<name>" <caps>`. See "Background agents" below. |
| `/swarm say <agent> "text"` | Inject a message into an agent's inbox (you → agent / panel → LLM). Runs `node {skillDir}/lib/swarm-cli.js say <agent> "text" --root {swarmRoot}`. |
| `/swarm room ["text"]` | View the **common room** (shared chat all agents read), or post to it. Runs `node {skillDir}/lib/swarm-cli.js room ["text"] --root {swarmRoot}`. |
| `/swarm split <task-id> "sub1" "sub2" ...` | Split task into subtasks. |
| `/swarm modify task <id> <field> <value>` | Modify a task. Fields: title, description, priority, tags, status. |
| `/swarm modify agent <name> <field> <value>` | Modify an agent. Fields: capabilities, role, status, name. |
| `/swarm modify config <field> <value>` | Modify swarm config. Fields: sync_interval, transport, max_tasks_per_agent. |
| `/swarm escalate <message>` | Escalate a decision to the human user. |
| `/swarm resolve <escalation-id> <decision>` | Human resolves an escalation. |
| `/swarm dashboard` | Launch HTML dashboard (detached). Runs `node {skillDir}/lib/launch.js dashboard {swarmRoot}`, opens `http://localhost:7379`. |
| `/swarm dashboard-tui` | Launch terminal (blessed) dashboard in a NEW terminal window. **Must use `Start-Process` (Windows) or open new terminal.** TUI takes over the terminal — CANNOT run inline in chat. |
| `/swarm server [port]` | Start WebSocket relay server (detached). Runs `node {skillDir}/lib/launch.js server {swarmRoot}`. |
| `/swarm start` | Start full stack (WS server + HTML dashboard), detached + idempotent. Runs `node {skillDir}/lib/launch.js stack {swarmRoot}`. |
| `/swarm stop` | Stop all swarm processes (server, dashboard, agents). Runs `node {skillDir}/lib/launch.js stop {swarmRoot}`. |
| `/swarm ps` | Show running swarm processes + server health. Runs `node {skillDir}/lib/launch.js status {swarmRoot}`. |

## Modify

When user runs `/swarm modify`:

### Modify a task
```
/swarm modify task <task-id> priority critical
/swarm modify task <task-id> title "New title here"
/swarm modify task <task-id> tags coding,security,backend
/swarm modify task <task-id> status open
/swarm modify task <task-id> description "Updated description"
```

Read the task YAML file, update the specified field, write back. Always update `updated_at` timestamp.

### Modify an agent
```
/swarm modify agent <agent-name> capabilities coding,testing,devops
/swarm modify agent <agent-name> role developer
/swarm modify agent <agent-name> status idle
/swarm modify agent <agent-name> name "New-Name"
```

Find agent by name, update field in their YAML file. Valid roles: lead, developer, reviewer, tester, architect.

### Modify config
```
/swarm modify config sync_interval 30
/swarm modify config transport hybrid
/swarm modify config max_tasks_per_agent 5
```

Update `.swarm/config.yaml` directly. Show confirmation of what changed.

### After any modify
1. Show the updated entity (task/agent/config) to the user
2. Git add + commit with message `swarm: modify <what> <field>=<value>`
3. Do NOT auto-push unless user asks

## Initialization

When user runs `/swarm init`:

1. Create `.swarm/` directory structure:
   ```
   .swarm/
   ├── config.yaml
   ├── agents/
   ├── tasks/
   ├── claims/
   ├── messages/
   ├── escalations/
   └── hierarchy.yaml
   ```

2. Write `config.yaml`:
   ```yaml
   project: <repo name from git>
   created_at: <ISO timestamp>
   transport: git
   sync_interval: 15
   max_tasks_per_agent: 3
   ```

3. Register this agent automatically.
4. Initialize hierarchy with this agent as lead.
5. Git add + commit `.swarm/`.
6. After init, offer to start the stack: "Run `node {skillDir}/start.js` to start the WS server + HTML dashboard."

## Behavior Rules

### On Every Turn (automatic via hooks)

The swarm-sync hook runs on every user prompt. You will see context like:
- `SWARM ACTIVE — N agents, M tasks`
- `📋 Your active tasks: ...`
- `⚡ Urgent unassigned tasks: ...`
- `🔔 ESCALATION(S) NEED YOUR DECISION: ...`

React to this context naturally:
- If you have active tasks, focus on them.
- If urgent tasks exist and you're idle, suggest claiming one.
- If escalations are pending, present them to the user for decision.

### Task Routing (Semi-Automatic)

When the user gives a general instruction (not a /swarm command):
1. Check if it matches an existing open task → suggest claiming it.
2. If no match, suggest creating a new task.
3. Never auto-claim without user confirmation. Always ask:
   "There's an open task 'Build login form' that matches. Claim it? (yes/no)"

### Task Scoring Algorithm

When suggesting which task to claim, rank by:
```
score = capability_match × 0.5 + load_balance × 0.3 + priority × 0.2

capability_match = overlap(agent.capabilities, task.tags) / len(task.tags)
load_balance = 1 - (active_tasks / max_tasks_per_agent)
priority: critical=1.0, high=0.75, medium=0.5, low=0.25
```

### Conflict-Free Claims

Task claiming uses claim ticket files (not direct file modification):
- Agent creates `claims/claim-{taskId}-{agentId}-{timestamp}.yaml`
- Winner = earliest timestamp after git sync
- Losers see the winner and pick next best task
- Zero git merge conflicts by design

### Escalation Protocol

Escalate to human when detecting:
- Hard decisions: "should we", "which one", "vs", "tradeoff"
- Security issues: "vulnerability", "exploit", "injection"
- Scope changes: "redesign", "rewrite", "pivot"
- Agent disagreements

Format escalations clearly:
```
🔔 DECISION NEEDED
From: Bob (Codex)
Question: "Should we use REST or GraphQL for the API?"
AI suggests: REST (simpler for MVP)

[Approve REST] [Choose GraphQL] [Other input]
```

### Credit Exhaustion Failover

When an agent reports credits_exhausted:
1. Its tasks become orphaned.
2. Lead agent (or any available agent) reassigns orphaned tasks.
3. Team gets notified via broadcast.
4. Show user: "⚠ Bob (Codex) is out of credits. 2 tasks reassigned to Alice."

### Priority Preemption

Critical tasks can preempt lower-priority work:
- Agent working on medium task + critical task arrives → suggest preempting.
- Never auto-preempt. Ask user: "Critical task 'Fix XSS bug' arrived. Pause current work?"

## Communication Protocol

### WebSocket (real-time, preferred)

Messages flow instantly via WebSocket when server is running.
Start server: `/swarm server` (→ `node {skillDir}/lib/launch.js server {swarmRoot}`).
Git-based messaging always works even with no server — messages are YAML files.

### Git (fallback, always available)

Messages stored as individual YAML files in `.swarm/messages/`.
One file per message = zero git conflicts.

### Hybrid Mode

Best setup: WebSocket for messages + git for state (tasks, agents, hierarchy).
- Messages: instant via WS
- Task state: durable via git, synced every 30s

## File Locations

The lib/ modules are bundled with this skill. To use them, resolve paths relative to this SKILL.md file's directory:

```javascript
const path = require('path');
const skillDir = 'SKILL_BASE_DIR'; // replaced at runtime with actual skill base directory
const libDir = path.join(skillDir, 'lib');
const yaml = require(path.join(libDir, 'yaml'));
const agentRegistry = require(path.join(libDir, 'agent-registry'));
const taskManager = require(path.join(libDir, 'task-manager'));
// etc.
```

**IMPORTANT:** The "Base directory for this skill:" line at the top of the skill output tells you the actual path. Use THAT path as `skillDir`.

Available modules:
- `lib/yaml.js` — YAML parse/serialize
- `lib/git-sync.js` — git operations
- `lib/agent-registry.js` — agent CRUD + health
- `lib/task-manager.js` — task CRUD + scoring + claim tickets
- `lib/message-bus.js` — messaging (git-based)
- `lib/hierarchy.js` — team structure
- `lib/conflict-resolver.js` — race resolution
- `lib/agent-loop.js` — autonomous loop + escalation
- `lib/orchestrator.js` — lead task distribution (delegation brain)
- `lib/orchestrator-cli.js` — CLI over orchestrator (used by `/swarm delegate` + adapters)
- `lib/launch.js` — detached launcher for server/dashboard/agents
- `lib/realtime.js` — WebSocket server/client (zero deps)
- `lib/realtime-message-bus.js` — WS message bus wrapper

For `/swarm server`: run `node {skillDir}/lib/launch.js server {swarmRoot}`

## Dashboard

### HTML Dashboard (preferred — no terminal blocking)

All process launching goes through the detached, idempotent launcher
`lib/launch.js`. It writes PID + logs under `{swarmRoot}/.swarm/.run/`, never
double-starts a healthy server, and survives the shell that started it.

```bash
node {skillDir}/lib/launch.js stack     {swarmRoot}   # WS server + HTML dashboard
node {skillDir}/lib/launch.js server    {swarmRoot}   # WS relay only
node {skillDir}/lib/launch.js dashboard {swarmRoot}   # HTML dashboard only
node {skillDir}/lib/launch.js status    {swarmRoot}   # what's running + health
node {skillDir}/lib/launch.js stop      {swarmRoot}   # stop everything
```

Command mapping:
- `/swarm start` → `node {skillDir}/lib/launch.js stack {swarmRoot}` → tell user the dashboard + WS URLs.
- `/swarm dashboard` → `node {skillDir}/lib/launch.js dashboard {swarmRoot}` → "Dashboard at http://localhost:7379 (auto-refresh 3s)."
- `/swarm server` → `node {skillDir}/lib/launch.js server {swarmRoot}`.
- `/swarm stop` → `node {skillDir}/lib/launch.js stop {swarmRoot}`.
- `/swarm ps` → `node {skillDir}/lib/launch.js status {swarmRoot}`.

These return immediately (detached) — run them with a short timeout; do NOT
block waiting for them. The old `start.js` still works but `launch.js` is preferred.

### TUI Dashboard (legacy — blocks terminal)

**CRITICAL:** Must launch in a SEPARATE terminal window. Cannot run inline.

On Windows:
```powershell
Start-Process powershell -ArgumentList '-NoExit', '-Command', "node `"{skillDir}/dashboard/index.js`" `"{swarmRoot}`""
```

On Mac/Linux:
```bash
node {skillDir}/dashboard/index.js {swarmRoot} &
```

After launching: "TUI dashboard opened in new terminal. Press q to quit."

## Background agents (v2 — continuous, no API key)

Agents can run as **always-on background daemons** that never stop, talk through
**inbox/outbox**, and let the lead route work — driven by `claude -p` headless (no API key,
your Claude plan), or gemini/codex (CLI if installed, else API key).

### Start workers
```
/swarm start                                  # WS server + control-panel dashboard
/swarm worker claude "Alice" coordination     # background lead (first worker = lead)
/swarm worker claude "Bob"   backend,api       # background worker
```
→ `node {skillDir}/lib/launch.js worker claude {swarmRoot} "<name>" <caps>`.
Detached; logs at `{swarmRoot}/.swarm/.run/worker-<name>.log`. Stop all: `/swarm stop`.

### How it flows
1. Each worker loops (default 30s). **Cost-safe:** it only calls the LLM when there's actual
   work — an inbox message, an assigned task, a **claimable open task that fits it**, or new
   **common-room** chatter. Otherwise idle = a cheap heartbeat, no LLM call.
2. Work reaches agents two ways: the **lead auto-distributes** open tasks into inboxes, AND any
   idle worker **claims matching open tasks off the board** on its own (no lead required).
3. A worker reasons, emits `##SWARM:..##` actions (claim/done/msg/**room**/create/…), writes its
   output to its **outbox**, and posts progress to the **common room**. Results go into the task
   `result` field (no repo edits).
4. **Common room** = the shared channel every agent reads each tick. Post with `##SWARM:ROOM:..##`
   or `/swarm room "..."`. This is how the team talks, offers tasks, and asks for help.
5. **You inject** into any agent (`/swarm say Bob "..."`) or the room (`/swarm room "..."`), or use
   the dashboard inject box (pick an agent or "Common Room"). It lands → next tick the agent
   processes it → reply shows in the **Message Flow** panel.

### Control panel (main channel)
`/swarm dashboard` (or `/swarm start`) → `http://localhost:7379`. From the browser you can:
- **Send tasks to the board** — the input above the Tasks panel (title + priority + tags → Add)
  creates an open task and announces it in the room; idle workers wake and claim it.
- **Message agents or the room** — the inject box above the Message Flow panel (pick an agent or
  "Common Room"). The flow shows live inbox/outbox/room traffic between all agents.
`node {skillDir}/lib/swarm-cli.js outbox` shows the same flow in the terminal.

### Rule enforcement (agents can't cheat)
Rules are enforced in code, not just the prompt: an agent can only `DONE` a task assigned to it
(it must `CLAIM` an open one first), and can't claim another agent's task. A compact strict
system prompt keeps token use low; idle ticks make **zero** LLM calls.

### Test free (no quota)
Set `SWARM_DRIVER=fake` before launching a worker — it acts deterministically with zero LLM
calls. Good for verifying routing/inbox/outbox end-to-end.

## Onboard a CLI agent (no API key — recommended)

This is the easy, free way to add Codex/Gemini as workers: the user already has a
Codex CLI or Gemini CLI (on their Pro/CLI plan). Instead of the API adapter, the CLI
agent itself drives the swarm via `lib/swarm-cli.js`. No API key, no per-token cost.

When the user runs `/swarm onboard [name] [caps]`, produce a ready-to-paste block.
Fill in the **absolute** `{skillDir}` and `{swarmRoot}`:

```
Paste this into your Codex CLI / Gemini CLI session:
─────────────────────────────────────────────
Read "{skillDir}/SWARM-AGENT.md" and follow it to act as a swarm agent.

Setup:
  cd "{swarmRoot}"
  export SWARM="{skillDir}/lib/swarm-cli.js"
  node "$SWARM" join "{name or e.g. Codex-Bob}" {caps or e.g. backend,api}

Then loop: `node "$SWARM" inbox` → `node "$SWARM" next` → `claim` → DO THE REAL WORK
in the repo → `node "$SWARM" done <id> "<result>"`. Repeat until inbox/next are empty.
─────────────────────────────────────────────
```

The agent reads `SWARM-AGENT.md` (full command reference) and operates autonomously.
`swarm-cli.js` auto-detects the repo from `cd`, syncs git best-effort, and resolves the
agent identity (saved on `join`). Everything is git-based, so it works with no server.

Verify it joined: `/swarm status` (or `node {skillDir}/lib/swarm-cli.js status {swarmRoot}`).

## Task Delegation and Splitting

### Automatic distribution (default)

The **lead distributes open tasks automatically every turn.** The `swarm-sync`
hook calls `orchestrator.distribute()` when you are the lead: each open, unblocked
task is assigned to the best-matched active agent (capability + load + priority
scoring) and that agent receives a `task_assignment` message carrying an actionable
work prompt. You do not need to do anything — just create tasks and add workers.

Trigger it manually anytime with `/swarm delegate`
(→ `node {skillDir}/lib/orchestrator-cli.js distribute {swarmRoot} {myAgentId}`).

### Adding workers

```
/swarm agent codex backend,python       # launch a Codex worker (detached)
/swarm agent gemini frontend,testing     # launch a Gemini worker (detached)
```
→ `node {skillDir}/lib/launch.js agent <provider> {swarmRoot} <caps>`.
Worker logs: `{swarmRoot}/.swarm/.run/agent-<provider>.log`.
Needs `CODEX_API_KEY`/`OPENAI_API_KEY` (codex) or `GEMINI_API_KEY` (gemini) in the
environment. To test the whole loop with no API spend, set `SWARM_FAKE_LLM=1`.

### Splitting big tasks

```
/swarm split <task-id> "Subtask A" "Subtask B" "Subtask C"
```
Parent becomes `split`; subtasks are created `open` (same priority/tags, `parent_task`
set). The lead then auto-distributes the new subtasks on the next turn.

### How an agent acts on an assignment

When a `task_assignment` message targets an agent (you'll see it surfaced as
"📨 task assignment(s) for you"):
1. Claim/accept the task (it's already `assigned` to you).
2. **Produce real output** — actual code, analysis, or findings. Never placeholder text.
3. Mark done with the real result: `/swarm done "<result>"` (Claude) or
   `##SWARM:DONE:task-uuid:<result>##` (Codex/Gemini).
4. LLM workers write results into the task `result` field — they do NOT edit repo files.

### Inter-agent messages

Agents coordinate with `/swarm msg <agent> "..."` and `/swarm broadcast "..."`.
Incoming messages are surfaced to each agent every turn (git-based, always works;
instant via WebSocket when the server is up). A worker that needs help broadcasts a
`help_request`; teammates respond with real answers.

## Boundaries

- Never auto-execute tasks without user confirmation (semi-automatic mode).
- Never modify files outside `.swarm/` without explicit user request.
- Never commit non-swarm files to git via swarm operations.
- Always show team status when asked.
- Always present escalations prominently — they block team progress.
