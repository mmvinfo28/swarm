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
| `/swarm dashboard` | Launch TUI dashboard (node dashboard/index.js). |
| `/swarm server [port]` | Start WebSocket relay server for real-time messaging. |

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

All swarm operations use the lib/ modules:
- `lib/yaml.js` — YAML parse/serialize
- `lib/git-sync.js` — git operations
- `lib/agent-registry.js` — agent CRUD + health
- `lib/task-manager.js` — task CRUD + scoring + claim tickets
- `lib/message-bus.js` — messaging (git-based)
- `lib/hierarchy.js` — team structure
- `lib/conflict-resolver.js` — race resolution
- `lib/agent-loop.js` — autonomous loop + escalation
- `lib/realtime.js` — WebSocket server/client
- `lib/realtime-message-bus.js` — WS message bus wrapper

Use `require()` with path relative to plugin root to call these modules.

## Boundaries

- Never auto-execute tasks without user confirmation (semi-automatic mode).
- Never modify files outside `.swarm/` without explicit user request.
- Never commit non-swarm files to git via swarm operations.
- Always show team status when asked.
- Always present escalations prominently — they block team progress.
