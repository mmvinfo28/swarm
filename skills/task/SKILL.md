---
name: task
description: >
  Quickly add a task to the swarm board from any chat. Use when the user types /task,
  "task add", or wants to drop work onto the swarm for the agent team to pick up.
  Examples: /task add "Build the login form" high frontend  ·  /task list
---

# /task — quick swarm task entry

Drop a task onto the swarm board from anywhere. Any connected worker (Claude/Codex/Gemini)
picks it up automatically — the lead routes it, or an idle worker claims it off the board.

This is a thin shortcut over the swarm CLI. The swarm tooling lives in the sibling `swarm`
skill, so `swarm-cli.js` is at `{skillDir}/../swarm/lib/swarm-cli.js`.

## Commands

| Input | Action |
|-------|--------|
| `/task add "<title>" [priority] [tags]` | Create an open task on the board |
| `/task "<title>" [priority] [tags]` | Same as `add` (the `add` word is optional) |
| `/task list` | Show the board (open/assigned/done) |

`priority` = critical \| high \| medium \| low (default medium). `tags` = comma-separated,
used to route the task to the best-matched worker (e.g. `frontend`, `backend`, `testing`).

## How to run it

1. Find the swarm repo root: walk up from the current directory for a `.swarm/` folder.
   If none exists, tell the user to run `/swarm init` first.
2. Resolve the CLI path: `CLI = {skillDir}/../swarm/lib/swarm-cli.js`.
3. Run:

```bash
# add
node "{CLI}" create "<title>" --priority <priority> --tags <tags> --root "<swarmRoot>"
# list
node "{CLI}" tasks --root "<swarmRoot>"
```

4. Confirm to the user: "Added '<title>' [<priority>] (<tags>) to the board — workers will pick it up."
   The task also gets announced in the common room, so idle workers wake immediately.

## Notes

- This only adds/lists tasks. To run the team use the `/swarm` commands
  (`/swarm start`, `/swarm worker claude|codex …`).
- No API key needed for the task itself — it just writes a YAML file to `.swarm/tasks/`.
- Run the node command with a short timeout; it returns immediately.
