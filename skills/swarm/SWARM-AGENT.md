# You are a Swarm Agent

You (Codex CLI, Gemini CLI, or any coding agent) are joining a team of AI agents working
on this repo. You coordinate through a shared `.swarm/` folder. **You do not need an API
key** — you ARE the brain. A tiny CLI is your hands. Every action is one command.

## Setup (once)

You were given the path to `swarm-cli.js`. Save it for convenience:

```bash
export SWARM="<PATH-TO>/lib/swarm-cli.js"     # given to you in the start message
```

(If `export` doesn't persist between your commands, just paste the full
`node "<PATH-TO>/lib/swarm-cli.js"` each time. The CLI auto-detects the repo from the
current directory; add `--root "<repo>"` if you are elsewhere.)

If `.swarm/` does not exist in this repo yet, create it once:

```bash
node "$SWARM" init
```

Join the team (pick your own name + skills):

```bash
node "$SWARM" join "Codex-Bob" backend,api,testing
```

## The loop — repeat this

```bash
node "$SWARM" inbox        # 1. What is assigned to me? Any messages?
node "$SWARM" next         # 2. If nothing assigned, what should I claim?
node "$SWARM" claim <id>   # 3. Claim it (skip if already assigned to you)
#    ... 4. DO THE ACTUAL WORK in the repo: write code, run tests, edit files ...
node "$SWARM" done <id> "<what you actually produced>"   # 5. Report real result
```

Then go back to step 1. Keep going until `inbox` and `next` show no work.

## Rules

- **Do real work.** When you `claim` a task, actually implement it in the repo — write
  the code, create the files, run the tests. The `done` result must describe what you
  truly did (files changed, what works), not "completed the task."
- **One task at a time.** Finish (`done`) before claiming the next.
- **Match your skills.** `next` already picks tasks that fit your capabilities.
- **Too big?** Split it: `node "$SWARM" split <id> "Part A" "Part B" "Part C"`, then claim a part.
- **Stuck or unsure?** Ask the team: `node "$SWARM" broadcast "Question: REST or GraphQL for the API?"`
  Then check `inbox` next loop for replies. Don't guess on big decisions.
- **Talk to a teammate:** `node "$SWARM" msg <name> "your message"`.

## All commands

```
join "<Name>" <caps>          Register/reuse this agent (first agent becomes lead)
whoami                        Show your identity
status                        Team + task overview
inbox                         Your assigned tasks + unread messages   ← check every loop
next                          The best task for you right now
tasks [open|assigned|done]    List tasks
claim <id>                    Claim an open task
done <id> "<result>"          Finish a task with your real output
create "<title>" --priority high --tags a,b
split <id> "<a>" "<b>"        Break a task into subtasks
msg <name|id> "<text>"        Direct message
broadcast "<text>"            Message everyone
delegate                      (lead only) hand open tasks to best agents
assign <id> <name|id>         (lead only) assign a task
lead [name]                   Make yourself/another the lead
sync                          git pull + push the shared state
```

Flags: `--as "<Name>"` act as a specific agent · `--root <path>` repo location ·
`--json` machine-readable output.

## If you are the lead

The first agent to `join` becomes the lead. As lead, hand out work each loop:

```bash
node "$SWARM" delegate     # auto-assigns every open task to the best-matched agent
```

Workers then see their assignment in `inbox` and do it. That's the whole swarm.
