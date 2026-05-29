# Task Routing Algorithm

## Scoring Formula

```
score = capability_match × 0.5 + load_balance × 0.3 + priority × 0.2
```

### Capability Match (50% weight)

```
capability_match = intersection(agent.capabilities, task.tags) / len(task.tags)
```

- Agent has `[frontend, react, testing]`, task tagged `[frontend, react]` → 1.0
- Agent has `[backend, python]`, task tagged `[frontend, react]` → 0.0
- Agent has `[frontend]`, task tagged `[frontend, react]` → 0.5
- No tags on task → default 0.5

### Load Balance (30% weight)

```
load_balance = 1 - (active_tasks / max_tasks_per_agent)
```

- Agent has 0 active tasks (max 3) → 1.0
- Agent has 1 active task → 0.67
- Agent has 2 active tasks → 0.33
- Agent has 3 active tasks → 0.0 (cannot accept)

### Priority (20% weight)

| Priority | Weight |
|----------|--------|
| critical | 1.0 |
| high | 0.75 |
| medium | 0.5 |
| low | 0.25 |

## Preemption Rules

Critical tasks can preempt lower-priority work:
- Only `critical` preempts, and only against `medium` or `low`.
- `high` does NOT preempt `medium` — too disruptive.
- Preemption requires user confirmation.

## Failover Assignment

When an agent goes down (credits_exhausted, offline, error):
1. Find orphaned tasks (assigned to down agent, not done).
2. For each orphaned task, find best candidate:
   - Same capability matching as above
   - Prefer idle agents over working agents
   - Prefer agents with fewer active tasks
3. If no candidate found, set task back to `open` (pool).

## Rebalancing

`rebalanceTasks()` runs periodically and suggests optimal assignment:
1. List all open, unblocked tasks sorted by priority (critical first).
2. For each task, find best agent using scoring formula.
3. Return list of suggestions: `[{taskId, agentId, score}]`.
4. Never auto-assign — return suggestions for lead/user to approve.
