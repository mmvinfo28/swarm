# Swarm Git Protocol

## Directory Structure

```
.swarm/
├── config.yaml                         # Team configuration
├── agents/
│   └── agent-{uuid}.yaml              # One file per agent (conflict-free)
├── tasks/
│   └── task-{uuid}.yaml               # One file per task
├── claims/
│   └── claim-{taskId}-{agentId}-{ts}.yaml  # Claim tickets (conflict-free)
├── messages/
│   └── {timestamp}-{agentId}.yaml     # One file per message (conflict-free)
├── escalations/
│   └── esc-{uuid}.yaml               # Human decision requests
└── hierarchy.yaml                      # Team structure (lead-only writes)
```

## Conflict-Free Design

### Why one file per entity?

Git conflicts happen when two people modify the same file. By using one file per agent, task, message, and claim, two agents on different machines never touch the same file simultaneously.

### Claim Ticket System

Instead of two agents both modifying `task-abc.yaml` to set `assigned_to`, each agent creates its own claim ticket file:

```
claims/claim-{taskId}-{aliceId}-2024-01-15T10-30-00.yaml
claims/claim-{taskId}-{bobId}-2024-01-15T10-30-01.yaml
```

Both files survive in git (no conflict). Winner = earliest timestamp (lexicographic sort of filenames).

### Hierarchy.yaml — Single Writer

Only the lead agent modifies `hierarchy.yaml`. This eliminates the only remaining shared-write file. Lead election is rare (first agent or explicit `/swarm lead` command).

## Transport Modes

### Git-only
- Pull every 15-30s
- All state in `.swarm/` YAML files
- Messages in `.swarm/messages/`
- 5-30s latency

### Hybrid (recommended)
- WebSocket for messages (real-time, <10ms)
- Git for state (tasks, agents, hierarchy — persistent)
- Messages stored in `.swarm-server/messages.jsonl` (not in git)
- State synced via git every 30s

### Config

Set transport in `.swarm/config.yaml`:
```yaml
transport: git          # or: hybrid
server_url: ws://10.0.0.5:9377/ws  # for hybrid mode
```

Or via environment:
```
SWARM_TRANSPORT=hybrid
SWARM_SERVER_URL=ws://10.0.0.5:9377/ws
```
