#!/usr/bin/env python3
"""
Swarm Adapter — OpenAI Codex / GPT

Wraps OpenAI API to participate in a swarm team.
Loop: pull → read state → format prompt → call API → parse actions → write state → push

Requirements: OPENAI_API_KEY env var (or CODEX_API_KEY)
Dependencies: Python 3.8+ stdlib only (uses urllib, no pip packages)

Usage:
  python codex-wrapper.py [--swarm-root /path/to/repo] [--name "Codex-Bob"] [--capabilities backend,python]
"""

import os
import sys
import json
import time
import uuid
import subprocess
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone


# --- Config ---

SWARM_ROOT = os.environ.get("SWARM_ROOT", os.getcwd())
AGENT_NAME = os.environ.get("SWARM_AGENT_NAME", f"Codex-{os.getenv('USER', 'agent')}")
PROVIDER = "codex"
CAPABILITIES = os.environ.get("SWARM_CAPABILITIES", "").split(",")
CAPABILITIES = [c.strip() for c in CAPABILITIES if c.strip()]
SYNC_INTERVAL = int(os.environ.get("SWARM_SYNC_INTERVAL", "15"))
API_KEY = os.environ.get("CODEX_API_KEY") or os.environ.get("OPENAI_API_KEY", "")
API_MODEL = os.environ.get("CODEX_MODEL", "gpt-4o")
API_URL = os.environ.get("OPENAI_API_URL", "https://api.openai.com/v1/chat/completions")
AGENT_ID_FILE = os.path.join(SWARM_ROOT, ".swarm", "agents", ".codex-agent-id")


# --- Minimal YAML (read/write subset we need) ---

def parse_yaml(text):
    """Parse simple YAML (scalars, lists, flat maps). Enough for .swarm/ files."""
    result = {}
    current_key = None
    current_list = None

    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        indent = len(line) - len(line.lstrip())

        if indent == 0 and ":" in stripped:
            key, _, val = stripped.partition(":")
            key = key.strip()
            val = val.strip()
            current_key = key
            current_list = None
            if val:
                result[key] = _parse_value(val)
            else:
                result[key] = None
        elif indent > 0 and current_key is not None:
            if stripped.startswith("- "):
                item = _parse_value(stripped[2:].strip())
                if not isinstance(result.get(current_key), list):
                    result[current_key] = []
                result[current_key].append(item)
            elif ":" in stripped:
                k, _, v = stripped.partition(":")
                if not isinstance(result.get(current_key), dict):
                    result[current_key] = {}
                result[current_key][k.strip()] = _parse_value(v.strip())

    return result


def _parse_value(val):
    if val in ("null", "~", ""):
        return None
    if val == "true":
        return True
    if val == "false":
        return False
    if val.startswith('"') and val.endswith('"'):
        return val[1:-1]
    if val.startswith("'") and val.endswith("'"):
        return val[1:-1]
    if val.startswith("[") and val.endswith("]"):
        inner = val[1:-1].strip()
        if not inner:
            return []
        return [_parse_value(x.strip()) for x in inner.split(",")]
    try:
        return int(val)
    except ValueError:
        pass
    try:
        return float(val)
    except ValueError:
        pass
    return val


def serialize_yaml(obj, indent=0):
    lines = []
    prefix = "  " * indent
    if isinstance(obj, dict):
        for k, v in obj.items():
            if v is None:
                lines.append(f"{prefix}{k}: null")
            elif isinstance(v, list):
                if not v:
                    lines.append(f"{prefix}{k}: []")
                else:
                    lines.append(f"{prefix}{k}:")
                    for item in v:
                        lines.append(f"{prefix}  - {_serialize_value(item)}")
            elif isinstance(v, dict):
                lines.append(f"{prefix}{k}:")
                lines.append(serialize_yaml(v, indent + 1))
            else:
                lines.append(f"{prefix}{k}: {_serialize_value(v)}")
    return "\n".join(lines)


def _serialize_value(val):
    if val is None:
        return "null"
    if isinstance(val, bool):
        return str(val).lower()
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, str):
        if any(c in val for c in ":{}[]#,&*?|>!%@`\"'"):
            return f'"{val}"'
        return val
    return str(val)


# --- Git operations ---

def git(cmd):
    try:
        result = subprocess.run(
            f"git {cmd}", shell=True, cwd=SWARM_ROOT,
            capture_output=True, text=True, timeout=30
        )
        return result.stdout.strip()
    except Exception:
        return ""


def git_pull():
    git("pull --rebase --autostash")


def git_push(msg="swarm: codex sync"):
    git("add .swarm")
    diff = git("diff --cached --name-only -- .swarm")
    if diff:
        git(f'commit -m "{msg}"')
        git("push")


# --- Agent registration ---

def get_agent_id():
    if os.path.exists(AGENT_ID_FILE):
        return open(AGENT_ID_FILE).read().strip()
    agent_id = str(uuid.uuid4())
    os.makedirs(os.path.dirname(AGENT_ID_FILE), exist_ok=True)
    with open(AGENT_ID_FILE, "w") as f:
        f.write(agent_id)
    return agent_id


def register_agent(agent_id):
    agent_file = os.path.join(SWARM_ROOT, ".swarm", "agents", f"agent-{agent_id}.yaml")
    now = datetime.now(timezone.utc).isoformat()
    agent = {
        "id": agent_id,
        "name": AGENT_NAME,
        "provider": PROVIDER,
        "owner": os.environ.get("USER", "unknown"),
        "capabilities": CAPABILITIES,
        "status": "idle",
        "current_task": None,
        "last_seen": now,
        "joined_at": now,
    }
    os.makedirs(os.path.dirname(agent_file), exist_ok=True)
    with open(agent_file, "w") as f:
        f.write(serialize_yaml(agent) + "\n")
    return agent


def heartbeat(agent_id):
    agent_file = os.path.join(SWARM_ROOT, ".swarm", "agents", f"agent-{agent_id}.yaml")
    if not os.path.exists(agent_file):
        return register_agent(agent_id)
    agent = parse_yaml(open(agent_file).read())
    agent["last_seen"] = datetime.now(timezone.utc).isoformat()
    with open(agent_file, "w") as f:
        f.write(serialize_yaml(agent) + "\n")
    return agent


# --- Read swarm state ---

def read_swarm_state():
    state = {"agents": [], "tasks": [], "messages": [], "escalations": []}

    agents_dir = os.path.join(SWARM_ROOT, ".swarm", "agents")
    if os.path.isdir(agents_dir):
        for f in os.listdir(agents_dir):
            if f.startswith("agent-") and f.endswith(".yaml"):
                state["agents"].append(parse_yaml(open(os.path.join(agents_dir, f)).read()))

    tasks_dir = os.path.join(SWARM_ROOT, ".swarm", "tasks")
    if os.path.isdir(tasks_dir):
        for f in os.listdir(tasks_dir):
            if f.startswith("task-") and f.endswith(".yaml"):
                state["tasks"].append(parse_yaml(open(os.path.join(tasks_dir, f)).read()))

    msgs_dir = os.path.join(SWARM_ROOT, ".swarm", "messages")
    if os.path.isdir(msgs_dir):
        files = sorted([f for f in os.listdir(msgs_dir) if f.endswith(".yaml")])[-20:]
        for f in files:
            state["messages"].append(parse_yaml(open(os.path.join(msgs_dir, f)).read()))

    esc_dir = os.path.join(SWARM_ROOT, ".swarm", "escalations")
    if os.path.isdir(esc_dir):
        for f in os.listdir(esc_dir):
            if f.startswith("esc-") and f.endswith(".yaml"):
                esc = parse_yaml(open(os.path.join(esc_dir, f)).read())
                if esc.get("status") == "pending":
                    state["escalations"].append(esc)

    return state


def format_state_as_prompt(state, agent_id):
    """Format swarm state as system prompt context for the LLM."""
    lines = []
    lines.append("You are part of a multi-agent swarm team. Here is the current team state:")
    lines.append("")

    # Agents
    lines.append("## Team Members")
    for a in state["agents"]:
        you = " (YOU)" if a.get("id") == agent_id else ""
        lines.append(f"- {a.get('name', '?')} ({a.get('provider', '?')}) [{a.get('status', '?')}]{you}")
        caps = a.get("capabilities", [])
        if caps:
            lines.append(f"  Capabilities: {', '.join(caps) if isinstance(caps, list) else caps}")

    # Tasks
    lines.append("")
    lines.append("## Tasks")
    open_tasks = [t for t in state["tasks"] if t.get("status") == "open"]
    my_tasks = [t for t in state["tasks"] if t.get("assigned_to") == agent_id and t.get("status") != "done"]

    if my_tasks:
        lines.append("### Your Active Tasks")
        for t in my_tasks:
            lines.append(f"- [{t.get('priority', 'medium')}] {t.get('title', '?')} (status: {t.get('status', '?')})")
            if t.get("description"):
                lines.append(f"  Description: {t['description']}")

    if open_tasks:
        lines.append("### Open Tasks (available to claim)")
        for t in open_tasks:
            lines.append(f"- [{t.get('priority', 'medium')}] {t.get('title', '?')} (tags: {t.get('tags', [])})")

    # Recent messages
    recent = state["messages"][-10:]
    if recent:
        lines.append("")
        lines.append("## Recent Messages")
        agent_names = {a.get("id"): a.get("name", "?") for a in state["agents"]}
        for m in recent:
            frm = agent_names.get(m.get("from"), m.get("from", "?")[:8])
            lines.append(f"- [{frm}]: {m.get('content', '')}")

    # Escalations
    if state["escalations"]:
        lines.append("")
        lines.append("## Pending Escalations (need human decision)")
        for e in state["escalations"]:
            lines.append(f"- [{e.get('severity', '?')}] {e.get('message_content', '?')}")

    lines.append("")
    lines.append("## Available Actions")
    lines.append("Respond with action markers on separate lines:")
    lines.append("  ##SWARM:CLAIM:task-uuid## — claim a task")
    lines.append("  ##SWARM:DONE:task-uuid:result text## — complete a task")
    lines.append("  ##SWARM:MSG:agent-uuid:message text## — send message to agent")
    lines.append("  ##SWARM:BROADCAST:message text## — broadcast to team")
    lines.append("  ##SWARM:STATUS:working|idle## — update your status")
    lines.append("")
    lines.append("You can include multiple actions. Write your analysis/response first, then actions at the end.")

    return "\n".join(lines)


# --- Parse LLM response for actions ---

def parse_actions(response):
    actions = []
    for line in response.split("\n"):
        line = line.strip()
        if line.startswith("##SWARM:CLAIM:") and line.endswith("##"):
            task_id = line[len("##SWARM:CLAIM:"):-2]
            actions.append({"type": "claim", "task_id": task_id})
        elif line.startswith("##SWARM:DONE:") and line.endswith("##"):
            parts = line[len("##SWARM:DONE:"):-2].split(":", 1)
            actions.append({"type": "done", "task_id": parts[0], "result": parts[1] if len(parts) > 1 else ""})
        elif line.startswith("##SWARM:MSG:") and line.endswith("##"):
            parts = line[len("##SWARM:MSG:"):-2].split(":", 1)
            actions.append({"type": "msg", "to": parts[0], "content": parts[1] if len(parts) > 1 else ""})
        elif line.startswith("##SWARM:BROADCAST:") and line.endswith("##"):
            content = line[len("##SWARM:BROADCAST:"):-2]
            actions.append({"type": "broadcast", "content": content})
        elif line.startswith("##SWARM:STATUS:") and line.endswith("##"):
            status = line[len("##SWARM:STATUS:"):-2]
            actions.append({"type": "status", "status": status})
    return actions


# --- Apply actions ---

def apply_actions(actions, agent_id):
    for action in actions:
        try:
            if action["type"] == "claim":
                claim_task(agent_id, action["task_id"])
            elif action["type"] == "done":
                complete_task(agent_id, action["task_id"], action.get("result", ""))
            elif action["type"] == "msg":
                send_message(agent_id, action["to"], action.get("content", ""))
            elif action["type"] == "broadcast":
                send_message(agent_id, "broadcast", action.get("content", ""))
            elif action["type"] == "status":
                update_status(agent_id, action["status"])
        except Exception as e:
            print(f"  [!] Action failed: {action['type']} — {e}", file=sys.stderr)


def claim_task(agent_id, task_id):
    claims_dir = os.path.join(SWARM_ROOT, ".swarm", "claims")
    os.makedirs(claims_dir, exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
    ticket = {"task_id": task_id, "agent_id": agent_id, "timestamp": datetime.now(timezone.utc).isoformat()}
    fp = os.path.join(claims_dir, f"claim-{task_id}-{agent_id}-{ts}.yaml")
    with open(fp, "w") as f:
        f.write(serialize_yaml(ticket) + "\n")

    # Update task file
    task_file = os.path.join(SWARM_ROOT, ".swarm", "tasks", f"task-{task_id}.yaml")
    if os.path.exists(task_file):
        task = parse_yaml(open(task_file).read())
        task["assigned_to"] = agent_id
        task["status"] = "in_progress"
        task["updated_at"] = datetime.now(timezone.utc).isoformat()
        with open(task_file, "w") as f:
            f.write(serialize_yaml(task) + "\n")
    print(f"  [✓] Claimed task {task_id[:8]}")


def complete_task(agent_id, task_id, result):
    task_file = os.path.join(SWARM_ROOT, ".swarm", "tasks", f"task-{task_id}.yaml")
    if os.path.exists(task_file):
        task = parse_yaml(open(task_file).read())
        task["status"] = "done"
        task["result"] = result
        task["updated_at"] = datetime.now(timezone.utc).isoformat()
        with open(task_file, "w") as f:
            f.write(serialize_yaml(task) + "\n")
    update_status(agent_id, "idle")
    print(f"  [✓] Completed task {task_id[:8]}")


def send_message(agent_id, to, content):
    msgs_dir = os.path.join(SWARM_ROOT, ".swarm", "messages")
    os.makedirs(msgs_dir, exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
    msg = {
        "id": str(uuid.uuid4()),
        "from": agent_id,
        "to": to,
        "type": "chat",
        "content": content,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    fp = os.path.join(msgs_dir, f"{ts}-{agent_id[:8]}.yaml")
    with open(fp, "w") as f:
        f.write(serialize_yaml(msg) + "\n")
    print(f"  [✓] Sent message to {to[:8] if to != 'broadcast' else 'all'}")


def update_status(agent_id, status):
    agent_file = os.path.join(SWARM_ROOT, ".swarm", "agents", f"agent-{agent_id}.yaml")
    if os.path.exists(agent_file):
        agent = parse_yaml(open(agent_file).read())
        agent["status"] = status
        agent["last_seen"] = datetime.now(timezone.utc).isoformat()
        with open(agent_file, "w") as f:
            f.write(serialize_yaml(agent) + "\n")


# --- OpenAI API call ---

def call_openai(system_prompt, user_msg):
    if not API_KEY:
        raise RuntimeError("No API key. Set CODEX_API_KEY or OPENAI_API_KEY env var.")

    payload = json.dumps({
        "model": API_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ],
        "max_tokens": 2048,
        "temperature": 0.3,
    }).encode("utf-8")

    req = urllib.request.Request(API_URL, data=payload, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    })

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        if e.code == 429 or "quota" in body.lower() or "rate" in body.lower():
            raise RuntimeError(f"CREDITS_EXHAUSTED: {e.code} {body[:200]}")
        raise RuntimeError(f"API error: {e.code} {body[:200]}")


# --- Main loop ---

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Swarm Codex Adapter")
    parser.add_argument("--swarm-root", default=SWARM_ROOT)
    parser.add_argument("--name", default=AGENT_NAME)
    parser.add_argument("--capabilities", default=",".join(CAPABILITIES))
    parser.add_argument("--interval", type=int, default=SYNC_INTERVAL)
    parser.add_argument("--once", action="store_true", help="Run single cycle then exit")
    args = parser.parse_args()

    global SWARM_ROOT, AGENT_NAME, CAPABILITIES
    SWARM_ROOT = args.swarm_root
    AGENT_NAME = args.name
    CAPABILITIES = [c.strip() for c in args.capabilities.split(",") if c.strip()]

    agent_id = get_agent_id()
    print(f"[swarm] Codex adapter starting")
    print(f"[swarm] Agent: {AGENT_NAME} ({agent_id[:8]})")
    print(f"[swarm] Root: {SWARM_ROOT}")
    print(f"[swarm] Capabilities: {CAPABILITIES}")
    print(f"[swarm] Model: {API_MODEL}")
    print()

    # Register
    git_pull()
    register_agent(agent_id)
    git_push(f"swarm: {agent_id[:8]} joined as {AGENT_NAME}")

    cycle = 0
    while True:
        cycle += 1
        print(f"[cycle {cycle}] Syncing...")

        try:
            # Pull
            git_pull()
            heartbeat(agent_id)

            # Read state
            state = read_swarm_state()
            prompt = format_state_as_prompt(state, agent_id)

            # Build user message
            my_tasks = [t for t in state["tasks"]
                       if t.get("assigned_to") == agent_id and t.get("status") != "done"]
            unread = [m for m in state["messages"][-10:]
                     if m.get("to") == agent_id or m.get("to") == "broadcast"]

            if my_tasks or unread:
                user_msg = "Check your tasks and messages. Take appropriate action."
                if my_tasks:
                    user_msg += f" You have {len(my_tasks)} active task(s)."
                if unread:
                    user_msg += f" You have {len(unread)} recent message(s)."
            else:
                open_tasks = [t for t in state["tasks"] if t.get("status") == "open"]
                if open_tasks:
                    user_msg = f"There are {len(open_tasks)} open task(s). Consider claiming one that matches your capabilities."
                else:
                    user_msg = "No pending work. Stand by."

            # Call API
            print(f"  Calling {API_MODEL}...")
            response = call_openai(prompt, user_msg)
            print(f"  Response: {response[:100]}...")

            # Parse and apply actions
            actions = parse_actions(response)
            if actions:
                print(f"  Actions: {len(actions)}")
                apply_actions(actions, agent_id)
            else:
                print("  No actions.")

            # Push
            git_push(f"swarm: {agent_id[:8]} cycle {cycle}")

        except RuntimeError as e:
            if "CREDITS_EXHAUSTED" in str(e):
                print(f"  [!] Credits exhausted! Marking agent as down.")
                update_status(agent_id, "credits_exhausted")
                send_message(agent_id, "broadcast",
                    f"Agent {AGENT_NAME} ({PROVIDER}) out of credits. Tasks may need reassignment.")
                git_push(f"swarm: {agent_id[:8]} credits exhausted")
                if args.once:
                    break
                time.sleep(300)  # wait 5 min before retry
                continue
            print(f"  [!] Error: {e}", file=sys.stderr)

        except Exception as e:
            print(f"  [!] Error: {e}", file=sys.stderr)

        if args.once:
            break

        print(f"  Sleeping {args.interval}s...")
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
