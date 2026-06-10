---
name: swarm-stop
description: >
  Stop all swarm processes — background workers, the WebSocket server, and the dashboard.
  Use when the user types /swarm-stop, or says "stop the swarm", "kill the agents",
  "shut it down".
---

# /swarm-stop — stop everything

Stops every tracked swarm process (workers, server, dashboard) for the current repo.

## What to run

The swarm library lives in the sibling `swarm` skill. Resolve relative to this skill's base dir:

```
node "{skillDir}/../swarm/lib/launch.js" stop {swarmRoot}
```

`{swarmRoot}` = the current repo (the one with `.swarm/`). Run with a short timeout, then tell
the user what was stopped.

## Stop only the workers (keep watching)

If the user wants to keep the dashboard/server up and only pause the LLM agents (e.g. running
low on tokens), use the **Stop workers** button in the dashboard, or:

```
node "{skillDir}/../swarm/lib/launch.js" status {swarmRoot}   # see what's running first
```
