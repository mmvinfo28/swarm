---
name: swarm-worker
description: >
  Add a worker to the swarm. Claude joins automatically as a headless background daemon;
  Codex/Gemini get a ready-to-paste prompt for their own CLI (so they work IN the repo and
  edit files). Use when the user types /swarm-worker, or says "add a worker", "add codex/claude
  to the team", "spin up an agent".
---

# /swarm-worker — add a worker

**Args:** `<provider> <name> [capabilities]`
- `provider` = `claude` | `codex` | `gemini` (default `claude`)
- `name` = display name · `capabilities` = comma-separated tags

How a worker joins depends on the provider:

## Claude → automatic background daemon

`claude -p` runs well headless, so just spawn the daemon:

```
node "{skillDir}/../swarm/lib/launch.js" worker claude {swarmRoot} "<name>" <caps>
```

Returns immediately (detached). Tell the user it's running and to watch the dashboard
(http://localhost:7379). First worker becomes the lead.

## Codex / Gemini → paste-prompt (works IN the repo)

Do **not** auto-spawn a headless daemon for codex/gemini — their `exec` runs read-only and
can't edit files. Instead, the user pastes a prompt into their own Codex/Gemini CLI, where the
agent works in the repo folder (edits files, runs tests), auto-registers, and loops.

Print this block, filling in absolute `{skillDir-of-swarm}` (the sibling `swarm` skill dir) and
`{swarmRoot}`:

```
Paste this into your Codex (or Gemini) CLI, opened in the repo folder:
─────────────────────────────────────────────
Read "{skillDir-of-swarm}/SWARM-AGENT.md" and act as a swarm agent named "<name>".

Setup (auto-registers; works in THIS repo):
  cd "{swarmRoot}"
  set SWARM="{skillDir-of-swarm}/lib/swarm-cli.js"
  node "%SWARM%" join "<name>" <caps>

Then loop CONTINUOUSLY — do not stop, do not wait for me:
  node "%SWARM%" inbox  →  node "%SWARM%" next  →  claim <id>
  →  DO THE REAL WORK in the repo (edit files, run tests)
  →  node "%SWARM%" done <id> "<what you did>"  →  back to inbox.
If nothing to do: wait ~5s and check inbox/next again. New tasks arrive any time.
Rules: you can only `done` a task you claimed; post progress with `node "%SWARM%" room "..."`.
─────────────────────────────────────────────
```

(On macOS/Linux use `export SWARM=…` and `$SWARM` instead of `set` / `%SWARM%`.)

Then tell the user: paste it into the Codex CLI; verify with `/swarm status`.

## Want codex fully automatic anyway?

Possible but limited — headless `codex exec` is sandboxed read-only (results into task YAML,
no file edits):

```
node "{skillDir}/../swarm/lib/launch.js" worker codex {swarmRoot} "<name>" <caps>
```

Use this only for analysis/answer tasks, not for editing the codebase.

## Notes
- Claude / Codex CLI use **your plan, no API key**. Gemini needs the gemini CLI or `GEMINI_API_KEY`.
- `{swarmRoot}` = the repo with `.swarm/`. If missing, run `/swarm` first.
- Stop workers from the dashboard (Stop workers) or `/swarm-stop`.
