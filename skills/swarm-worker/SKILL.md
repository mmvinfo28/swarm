---
name: swarm-worker
description: >
  Add a background AI worker to the swarm — Claude, Codex, or Gemini — with no API key
  (runs on the CLI's own plan). Use when the user types /swarm-worker, or says "add a worker",
  "add codex/claude/gemini to the team", "spin up an agent".
---

# /swarm-worker — add a background agent

Spawn one detached worker daemon. It loops: read inbox → reason → act, and only calls the
LLM when there is real work (idle = zero tokens).

**Args:** `<provider> <name> [capabilities]`
- `provider` = `claude` | `codex` | `gemini` (default `claude` if omitted)
- `name` = the agent's display name
- `capabilities` = comma-separated tags (e.g. `frontend,testing`)

## What to run

The swarm library lives in the sibling `swarm` skill. Resolve the launcher relative to this
skill's base directory (shown in the "Base directory for this skill:" line):

```
node "{skillDir}/../swarm/lib/launch.js" worker <provider> {swarmRoot} "<name>" <caps>
```

`{swarmRoot}` = the current repo (the one with `.swarm/`). If there is no `.swarm/` yet, tell
the user to run `/swarm` first.

Run it with a short timeout — it returns immediately (detached). Then tell the user the worker
started and how to watch it (dashboard at http://localhost:7379, or `/swarm room`).

## Examples

```
/swarm-worker codex Cara frontend,testing
/swarm-worker claude Bob backend,api
/swarm-worker gemini Gus docs
/swarm-worker claude Alice            # claude worker, no caps
```

## Notes

- **Claude / Codex CLI = no API key** (uses your plan). Gemini needs the gemini CLI or `GEMINI_API_KEY`.
- First worker to join becomes the **lead** (auto-distributes tasks).
- Stop workers from the dashboard (Stop workers button) or `/swarm-stop`.
- Test with zero tokens: prefix `SWARM_DRIVER=fake`.
