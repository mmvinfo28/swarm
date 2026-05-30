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
| `/swarm split <task-id> "sub1" "sub2" ...` | Split task into subtasks. |
| `/swarm modify task <id> <field> <value>` | Modify a task. Fields: title, description, priority, tags, status. |
| `/swarm modify agent <name> <field> <value>` | Modify an agent. Fields: capabilities, role, status, name. |
| `/swarm modify config <field> <value>` | Modify swarm config. Fields: sync_interval, transport, max_tasks_per_agent. |
| `/swarm escalate <message>` | Escalate a decision to the human user. |
| `/swarm resolve <escalation-id> <decision>` | Human resolves an escalation. |
| `/swarm dashboard` | Launch HTML dashboard in browser. Runs a local HTTP server, opens `http://localhost:7379`. Preferred over TUI — no terminal blocking. |
| `/swarm dashboard-tui` | Launch terminal (blessed) dashboard in a NEW terminal window. **Must use `Start-Process` (Windows) or open new terminal.** TUI takes over the terminal — CANNOT run inline in chat. |
| `/swarm server [port]` | Start WebSocket relay server for real-time messaging. |
| `/swarm start` | Start full stack (WS server + HTML dashboard) with single command. |

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
Start server: `/swarm server` or `node lib/realtime.js`

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
- `lib/realtime.js` — WebSocket server/client (zero deps)
- `lib/realtime-message-bus.js` — WS message bus wrapper

For `/swarm server`: run `node {skillDir}/server.js [port]`

## Dashboard

### HTML Dashboard (preferred — no terminal blocking)

Run the HTTP server, then open the URL in any browser:

```bash
node {skillDir}/dashboard.js [port] [swarmRoot]
# default port: 7379
# opens: http://localhost:7379
```

Or use the full-stack launcher:
```bash
node {skillDir}/start.js [swarmRoot]
# starts WS relay + HTML dashboard together
# WS:  ws://localhost:9377
# Dash: http://localhost:7379
```

For `/swarm dashboard`: run `node {skillDir}/dashboard.js [port] {swarmRoot}` then tell user:
"Dashboard running at http://localhost:7379 — open in browser. Auto-refreshes every 3s."

For `/swarm start`: run `node {skillDir}/start.js {swarmRoot}` then tell user the WS and dashboard URLs.

### TUI Dashboard (legacy — blocks terminal)

**CRITICAL:** Must launch in a SEPARATE terminal window. Cannot run inline.

On Windows:
```powershell
Start-Process powershell -ArgumentList '-NoExit', '-Command', "node `"{skillDir}/dashboard/index.js`" `"{swarmRoot}`""
```

On Mac/Linux:
```bash
node {skillDir}/../../dashboard/index.js {swarmRoot} &
```

After launching: "TUI dashboard opened in new terminal. Press q to quit."

## Task Delegation and Splitting

When a user gives a complex task that should be split across agents:

### Step 1 — Split the task
```
/swarm split <task-id> "Subtask A" "Subtask B" "Subtask C"
```
- Parent task becomes `split` status
- Each subtask is created as `open` with same priority and tags as parent
- Subtasks get `parent_task` field pointing to parent

### Step 2 — Assign or let agents claim
Option A (manual): `/swarm assign <subtask-id> <agent-name>`
Option B (automatic): Agents see open subtasks on next sync and claim matching ones

### Step 3 — Track completion
Use `/swarm status` to see subtask progress. All subtasks done = parent work complete.

### For LLM adapters (Codex/Gemini)
These agents use action markers. When a delegated task arrives:
- Agent sees it as `assigned` in their active tasks list
- Agent must produce **real output** — actual code, real analysis, concrete implementation
- Agent marks done: `##SWARM:DONE:task-uuid:actual result here##`
- Agent can split further: `##SWARM:SPLIT:task-uuid:Sub 1|Sub 2##`
- Agent can delegate to specialist: `##SWARM:DELEGATE:task-uuid:agent-uuid##`

### Working on tasks (important)
When an LLM agent claims or is assigned a task:
1. The LLM is asked to produce the actual work output
2. The result in `##SWARM:DONE##` must be real — code, analysis, findings
3. Never use placeholder text like "I did the task" — write the actual deliverable

## Boundaries

- Never auto-execute tasks without user confirmation (semi-automatic mode).
- Never modify files outside `.swarm/` without explicit user request.
- Never commit non-swarm files to git via swarm operations.
- Always show team status when asked.
- Always present escalations prominently — they block team progress.
