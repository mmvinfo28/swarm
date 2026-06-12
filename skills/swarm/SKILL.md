---
name: swarm
description: >
  Multi-agent orchestration skill. Teams of AI agents (Claude Code, Codex, Gemini)
  collaborate on a shared codebase — real-time via WebSocket, durable state via git.
  Use when the user says /swarm, mentions team coordination, or swarm hooks detect an
  active .swarm/ directory.
---

# Swarm — Multi-Agent Orchestration

You are part of a swarm team. Your actions affect everyone — coordinate, don't duplicate.
`{skillDir}` = this skill's base dir (see "Base directory for this skill:" at the top of the
skill output). `{swarmRoot}` = the repo containing `.swarm/`.

## The 4 commands a human types

| Command | Does |
|---------|------|
| `/swarm` | Start everything + show status (everyday entry point) |
| `/swarm-worker <provider> [name] [caps]` | Add a Claude/Codex/Gemini worker |
| `/task add "<title>" [priority] [tags]` | Drop a task on the board |
| `/swarm-stop` | Stop all swarm processes |

`/swarm <subcommand>` (below) is how agents act and how power users drive it. Most humans only
need the 4 above + the dashboard at http://localhost:7379 (**⚙ Commands** panel there lists the
CLI for non-Claude workers).

## `/swarm` (no args) = start + status

**First-time setup (no `.swarm/` yet) — ALWAYS ask the user these three before doing anything**
(use one AskUserQuestion with the three together; do not assume defaults):
1. **Repo** — Private GitHub repo · Public GitHub repo · No repo (local-only)?
2. **Lead name** — what to call the lead agent (suggest the git user name).
3. **Features / capabilities needed** — what is the team building, and which skills
   (e.g. frontend, backend, api, testing)? These become the lead's capabilities and seed the first tasks.

Then:
1. `node {skillDir}/lib/swarm-cli.js init --root {swarmRoot}` (creates `.swarm/`, runs `git init`, writes `.gitignore`).
2. Repo per their choice — Private → `gh repo create <name> --private --source=. --remote=origin --push`;
   Public → `--public`; No repo → skip (local-only). On name collision, see **Init** step 3.
3. Start stack: `node {skillDir}/lib/launch.js stack {swarmRoot}`.
4. Start the lead with their chosen name + capabilities (first worker = lead):
   `node {skillDir}/lib/launch.js worker claude {swarmRoot} "<lead name>" <caps-from-features>`.
5. Report: "Swarm up. Panel http://localhost:7379. Add workers `/swarm-worker`, tasks `/task add`, stop `/swarm-stop`."

**Already initialized (`.swarm/` exists)** → skip the questions: start the stack, ensure the lead is running, show status.

`/swarm status` → show status only, start nothing.

## Subcommands (of `/swarm`)

Agents drive these via `node {skillDir}/lib/swarm-cli.js <cmd> --root {swarmRoot}`. Humans use the
dashboard or the 4 commands instead.

| Command | Action |
|---------|--------|
| `init` | Create `.swarm/` (config, agents/, tasks/, claims/, messages/, escalations/, hierarchy.yaml). |
| `join [name] [caps]` | Register/reuse this agent. e.g. `join "Claude-Alice" frontend,react`. First agent = lead. |
| `status` | Team + tasks + health. |
| `task "title" [priority] [tags]` | Create a task. |
| `assign <id> <agent>` | Assign a task. |
| `claim <id>` | Claim an open task (conflict-free claim ticket). |
| `done [result]` | Complete current task — result is the REAL output. |
| `msg <agent> "text"` / `broadcast "text"` | DM one agent / message all. |
| `room ["text"]` | View or post to the common room (shared channel all agents read). |
| `say <agent> "text"` | Inject into an agent's inbox (human/panel → agent). |
| `lead [agent]` | Set team lead. |
| `delegate` | Lead splits big tasks + hands out open tasks to best agents. `node {skillDir}/lib/orchestrator-cli.js distribute {swarmRoot} {myAgentId}`. Also automatic each turn when you're lead. |
| `split <id> "sub1" "sub2"` | Break a task into subtasks. |
| `review <id> accept\|reject ["reason"]` | Accept/reopen a completed task. |
| `escalate <message>` / `resolve <esc-id> <decision>` | Escalate to human / human resolves. |
| `modify task\|agent\|config <id/name> <field> <value>` | Edit a task/agent/config (see below). |

Process control via `node {skillDir}/lib/launch.js <cmd> {swarmRoot}`:
`stack` (server+dashboard) · `server` · `dashboard` · `worker <provider> "<name>" <caps>` ·
`agent <provider> <caps>` (API-key worker) · `status` (`/swarm ps`) · `stop` (`/swarm-stop`).
All detached + idempotent; logs in `{swarmRoot}/.swarm/.run/`. Run with a short timeout, don't block.

## Init (`/swarm init`)

1. `swarm-cli init` creates `.swarm/` dirs + `config.yaml` (`project`, `created_at`,
   `transport: git`, `sync_interval: 15`, `max_tasks_per_agent: 3`) + `hierarchy.yaml`
   (this agent as lead). It also **runs `git init` if needed** and writes a **`.gitignore`**
   excluding runtime state (`.swarm/.run/`, `.swarm/.server-url`, `.swarm/.stopped`, `*.pid`, `*.log`).
2. Register this agent; `git add -A && git commit -m "swarm: init"`.
3. **Outward-facing** — to sync across machines, confirm repo name + visibility (default **private**), then:
   ```bash
   gh repo create <name> --private --source=. --remote=origin --push   # needs gh auth
   ```
   - **Name taken** (`Name already exists on this account`)? Don't abort — offer the user:
     pick a new name, OR reuse the existing repo
     (`git remote add origin <url> && git pull --rebase origin main && git push -u origin HEAD`),
     OR push under a different org. Re-run with their choice.
   - No `gh` / not authed? Tell the user (`gh auth login`); swarm still works local-only.
4. Offer: "`/swarm` to start, `/swarm-worker claude \"Alice\" coordination` to add workers."

## Modify (`/swarm modify`)

Read the entity's YAML, update the field, write back, bump `updated_at`. Then show it + git
commit `swarm: modify <what> <field>=<value>` (no auto-push).
- task fields: title, description, priority, tags, status.
- agent fields: capabilities, role (lead/developer/reviewer/tester/architect), status, name.
- config fields: sync_interval, transport, max_tasks_per_agent.

## Behavior rules

**Per-turn hook context** — `swarm-sync` injects only when relevant: `📋 your tasks`,
`⚡ urgent unassigned`, `📨 assignments`, `💬 messages`, `🔔 escalations`. React naturally:
focus your tasks; suggest claiming urgent ones if idle; present escalations for decision.

**Task routing** — when the user gives a general instruction (not a `/swarm` cmd), match to an
open task and suggest claiming, else suggest creating. Never auto-claim without confirmation.
Score: `capability_match·0.5 + load_balance·0.3 + priority·0.2`
(cap_match = overlap(caps, tags)/len(tags); load = 1 − active/max; crit=1, high=.75, med=.5, low=.25).

**Auto-split + distribution** — the lead distributes every turn (hook calls
`orchestrator.distribute()`). Big or multi-deliverable tasks are split by token size +
worker count and one part handed to each agent, so no single agent swallows the whole job.
Non-lead workers skip splittable tasks until the lead splits them. Manual: `/swarm delegate`.

**Conflict-free claims** — `claims/claim-{taskId}-{agentId}-{ts}.yaml`; earliest after git sync wins;
losers pick next best. Zero merge conflicts.

**Acting on an assignment** — claim/accept → produce REAL output (code/analysis/findings, never
placeholder) → `done` with the real result. LLM workers write results into the task `result`
field; they do NOT edit repo files.

**Escalate to human** on hard decisions (should we / which / vs / tradeoff), security
(vulnerability/exploit/injection), scope changes (redesign/rewrite/pivot), or agent disagreement.
Present prominently — escalations block progress.

**Credit exhaustion** — agent reports `credits_exhausted` → its tasks orphan → lead reassigns →
broadcast → tell user "⚠ Bob out of credits, N tasks reassigned."

**Boundaries** — never auto-execute without confirmation; never touch files outside `.swarm/`
without request; never commit non-swarm files via swarm ops.

## Background workers (no API key)

`/swarm-worker claude "Bob" backend,api` → `node {skillDir}/lib/launch.js worker claude {swarmRoot} "Bob" backend,api`.
Always-on daemon: loops inbox → reason (`claude -p` headless / gemini / codex) → emit
`##SWARM:..##` actions → outbox. **Cost-safe:** calls the LLM only when there's real work (inbox
message, assigned task, claimable fitting task, or new room chatter); idle = cheap heartbeat.
Rules are code-enforced: an agent can only `DONE` a task assigned to it, can't claim another's.
Test with zero spend: `SWARM_DRIVER=fake`.

The dashboard inject box (pick an agent or Common Room) lands in the inbox; the worker processes
it next tick and its reply (incl. answers to the human via `##SWARM:MSG:human:..##`) shows in the
Message Flow panel.

## Onboard a CLI agent (Codex/Gemini, no API key)

The user's own Codex/Gemini CLI drives the swarm via `lib/swarm-cli.js` — no key, no per-token cost.
On `/swarm onboard [name] [caps]`, emit this paste block with absolute `{skillDir}`/`{swarmRoot}`:

```
Read "{skillDir}/SWARM-AGENT.md" and act as a swarm agent.
  cd "{swarmRoot}"
  export SWARM="{skillDir}/lib/swarm-cli.js"
  node "$SWARM" join "{name e.g. Codex-Bob}" {caps e.g. backend,api}

Then loop CONTINUOUSLY (do not stop after a task):
  inbox → next → claim <id> → DO REAL WORK in the repo (edit files, run tests)
  → done <id> "<what you did>" → back to inbox. Nothing to do? sleep 5, recheck.
You can only `done` a task you claimed. Post progress with: node "$SWARM" room "...".
```

Verify: `/swarm status`.

## Communication & files

- **Messaging** — WebSocket (instant) when `/swarm server` is up; git YAML in `.swarm/messages/`
  always works (one file/message = zero conflicts). Common room = shared channel everyone reads.
- **lib/ modules** (require via `path.join(skillDir,'lib',...)`): `yaml`, `git-sync`,
  `agent-registry`, `task-manager`, `message-bus`, `io-bus`, `hierarchy`, `orchestrator`
  (+ `orchestrator-cli`), `actions`, `runner`, `launch`, `realtime` (+ `realtime-message-bus`),
  `conflict-resolver`, `agent-loop`.
- **TUI dashboard** (legacy, blocks terminal — launch in a NEW window):
  Windows `Start-Process powershell -ArgumentList '-NoExit','-Command',"node \`"{skillDir}/dashboard/index.js\`" \`"{swarmRoot}\`""`;
  Mac/Linux `node {skillDir}/dashboard/index.js {swarmRoot} &`.
