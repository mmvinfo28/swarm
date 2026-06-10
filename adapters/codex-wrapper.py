#!/usr/bin/env python3
"""
Swarm Adapter — OpenAI Codex / GPT

Wraps OpenAI API to participate in a swarm team.
Loop: pull -> read state -> format prompt -> call API -> parse actions -> write state -> push

Requirements: OPENAI_API_KEY env var (or CODEX_API_KEY)
Dependencies: Python 3.8+ stdlib only (uses urllib, no pip packages)

Usage:
  python codex-wrapper.py [--swarm-root /path/to/repo] [--name "Codex-Bob"] [--capabilities backend,python]

Available action markers (put on their own line in LLM response):
  ##SWARM:CLAIM:task-uuid##                     — claim an open task
  ##SWARM:DONE:task-uuid:result text##          — mark your task complete with result
  ##SWARM:CREATE:title:priority:tag1,tag2##     — create a new task (priority: critical/high/medium/low)
  ##SWARM:SPLIT:task-uuid:Sub 1|Sub 2|Sub 3##  — split a task into named subtasks
  ##SWARM:DELEGATE:task-uuid:agent-uuid##       — reassign task to a specific agent
  ##SWARM:MSG:agent-uuid:message text##         — send direct message to agent
  ##SWARM:BROADCAST:message text##              — broadcast to all agents
  ##SWARM:STATUS:working|idle##                 — update your status
"""

import os
import sys
import re
import json
import time
import uuid
import shutil
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
# Offline test mode — skip the API, act deterministically. Lets the full loop be
# verified with zero API spend.
FAKE_LLM = os.environ.get("SWARM_FAKE_LLM", "").strip().lower() not in ("", "0", "false", "no")
# Pluggable LLM call. Defaults to OpenAI; the gemini wrapper sets this to call_gemini
# so both providers share one main loop (single source of truth).
LLM_FN = None


# --- Minimal YAML (read/write subset we need) ---

def parse_yaml(text):
    """Parse simple YAML (scalars, lists, flat maps). Enough for .swarm/ files."""
    result = {}
    current_key = None

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
    if len(val) >= 2 and val.startswith('"') and val.endswith('"'):
        # Strip quotes and unescape \" and \\ (inverse of _serialize_value).
        return re.sub(r'\\(["\\])', r'\1', val[1:-1])
    if len(val) >= 2 and val.startswith("'") and val.endswith("'"):
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
                        if isinstance(item, dict):
                            lines.append(f"{prefix}  -")
                            lines.append(serialize_yaml(item, indent + 2))
                        else:
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
        if any(c in val for c in ':{}[]#,&*?|>!%@`"\'\n'):
            escaped = val.replace('\\', '\\\\').replace('"', '\\"')
            return f'"{escaped}"'
        return val
    return str(val)


# --- Git operations ---

# On Windows, hide the console window each subprocess would otherwise flash.
_NO_WINDOW = 0
if os.name == "nt":
    _NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


def git(cmd):
    try:
        result = subprocess.run(
            f"git {cmd}", shell=True, cwd=SWARM_ROOT,
            capture_output=True, text=True, timeout=30,
            creationflags=_NO_WINDOW,
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
        safe_msg = msg.replace('"', '\\"')
        git(f'commit -m "{safe_msg}"')
        git("push")


# --- Directory bootstrapping ---

def ensure_swarm_dirs():
    """Create all required .swarm/ directories and files if missing."""
    base = os.path.join(SWARM_ROOT, ".swarm")
    for d in ["agents", "tasks", "claims", "messages", "escalations"]:
        os.makedirs(os.path.join(base, d), exist_ok=True)

    # hierarchy.yaml — create if missing
    hierarchy_file = os.path.join(base, "hierarchy.yaml")
    if not os.path.exists(hierarchy_file):
        with open(hierarchy_file, "w", encoding="utf-8") as f:
            f.write(serialize_yaml({
                "lead": None,
                "roles": {},
                "sub_teams": [],
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }) + "\n")

    # config.yaml — create if missing
    config_file = os.path.join(base, "config.yaml")
    if not os.path.exists(config_file):
        repo_name = os.path.basename(SWARM_ROOT)
        with open(config_file, "w", encoding="utf-8") as f:
            f.write(serialize_yaml({
                "project": repo_name,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "transport": "git",
                "sync_interval": 15,
                "max_tasks_per_agent": 3,
            }) + "\n")


# --- Agent registration ---

def get_agent_id():
    # Provider-specific id file so codex and gemini keep separate identities.
    id_file = AGENT_ID_FILE or os.path.join(SWARM_ROOT, ".swarm", "agents", f".{PROVIDER}-agent-id")
    if os.path.exists(id_file):
        return open(id_file, encoding="utf-8").read().strip()
    agent_id = str(uuid.uuid4())
    os.makedirs(os.path.dirname(id_file), exist_ok=True)
    with open(id_file, "w", encoding="utf-8") as f:
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
    with open(agent_file, "w", encoding="utf-8") as f:
        f.write(serialize_yaml(agent) + "\n")
    return agent


def heartbeat(agent_id):
    agent_file = os.path.join(SWARM_ROOT, ".swarm", "agents", f"agent-{agent_id}.yaml")
    if not os.path.exists(agent_file):
        return register_agent(agent_id)
    agent = parse_yaml(open(agent_file, encoding="utf-8").read())
    agent["last_seen"] = datetime.now(timezone.utc).isoformat()
    with open(agent_file, "w", encoding="utf-8") as f:
        f.write(serialize_yaml(agent) + "\n")
    return agent


# --- Read swarm state ---

def read_swarm_state():
    state = {"agents": [], "tasks": [], "messages": [], "escalations": []}

    agents_dir = os.path.join(SWARM_ROOT, ".swarm", "agents")
    if os.path.isdir(agents_dir):
        for f in os.listdir(agents_dir):
            if f.startswith("agent-") and f.endswith(".yaml"):
                try:
                    state["agents"].append(parse_yaml(open(os.path.join(agents_dir, f), encoding="utf-8").read()))
                except Exception:
                    pass

    tasks_dir = os.path.join(SWARM_ROOT, ".swarm", "tasks")
    if os.path.isdir(tasks_dir):
        for f in os.listdir(tasks_dir):
            if f.startswith("task-") and f.endswith(".yaml"):
                try:
                    state["tasks"].append(parse_yaml(open(os.path.join(tasks_dir, f), encoding="utf-8").read()))
                except Exception:
                    pass

    msgs_dir = os.path.join(SWARM_ROOT, ".swarm", "messages")
    if os.path.isdir(msgs_dir):
        files = sorted([f for f in os.listdir(msgs_dir) if f.endswith(".yaml")])[-20:]
        for f in files:
            try:
                state["messages"].append(parse_yaml(open(os.path.join(msgs_dir, f), encoding="utf-8").read()))
            except Exception:
                pass

    esc_dir = os.path.join(SWARM_ROOT, ".swarm", "escalations")
    if os.path.isdir(esc_dir):
        for f in os.listdir(esc_dir):
            if f.startswith("esc-") and f.endswith(".yaml"):
                try:
                    esc = parse_yaml(open(os.path.join(esc_dir, f), encoding="utf-8").read())
                    if esc.get("status") == "pending":
                        state["escalations"].append(esc)
                except Exception:
                    pass

    return state


def load_codex_guide():
    """Load CODEX.md from adapters/ dir. Searches multiple candidate paths."""
    candidates = []

    # 1. Same dir as this script file (normal execution)
    try:
        candidates.append(os.path.dirname(os.path.abspath(__file__)))
    except NameError:
        pass

    # 2. Dir of argv[0] — when exec()'d from gemini-wrapper, argv[0] is that wrapper
    if sys.argv and sys.argv[0] not in ('-c', '') and sys.argv[0].endswith('.py'):
        candidates.append(os.path.dirname(os.path.abspath(sys.argv[0])))

    # 3. adapters/ relative to cwd (covers test/dev scenarios)
    candidates.append(os.path.join(os.getcwd(), 'adapters'))

    # 4. adapters/ sibling to SWARM_ROOT (plugin installed next to repo)
    candidates.append(os.path.join(os.path.dirname(os.path.abspath(SWARM_ROOT)), 'adapters'))

    for d in candidates:
        guide_path = os.path.join(d, "CODEX.md")
        if os.path.exists(guide_path):
            try:
                return open(guide_path, encoding="utf-8").read()
            except Exception:
                pass
    return ""


def discover_server_url():
    """Check .swarm/.server-url written by lib/server.js."""
    url_file = os.path.join(SWARM_ROOT, ".swarm", ".server-url")
    if os.path.exists(url_file):
        url = open(url_file, encoding="utf-8").read().strip()
        if url:
            return url
    return os.environ.get("SWARM_SERVER_URL", "")


def format_state_as_prompt(state, agent_id):
    """Format swarm state as system prompt context for the LLM."""
    guide = load_codex_guide()

    lines = []
    # Prepend the full guide so the LLM always has operational context
    if guide:
        lines.append(guide)
        lines.append("")
        lines.append("=" * 60)
        lines.append("CURRENT SWARM STATE (live snapshot)")
        lines.append("=" * 60)
        lines.append("")
    else:
        lines.append("You are an AI agent in a multi-agent swarm team working on a shared codebase.")
        lines.append("Read the current state carefully and take concrete action.")
        lines.append("")

    # Agents
    lines.append("## Team Members")
    for a in state["agents"]:
        you = " (YOU)" if a.get("id") == agent_id else ""
        lines.append(f"- {a.get('name', '?')} id={a.get('id', '?')[:8]} ({a.get('provider', '?')}) [{a.get('status', '?')}]{you}")
        caps = a.get("capabilities", [])
        if caps:
            lines.append(f"  Capabilities: {', '.join(caps) if isinstance(caps, list) else caps}")

    # Tasks
    lines.append("")
    lines.append("## Tasks")
    open_tasks = [t for t in state["tasks"] if t.get("status") == "open"]
    my_tasks   = [t for t in state["tasks"] if t.get("assigned_to") == agent_id and t.get("status") not in ("done", "split")]

    if my_tasks:
        lines.append("### YOUR Active Tasks (work on these NOW)")
        for t in my_tasks:
            lines.append(f"- id={t.get('id', '?')} [{t.get('priority', 'medium')}] {t.get('title', '?')} (status: {t.get('status', '?')})")
            if t.get("description"):
                lines.append(f"  Description: {t['description']}")
            if t.get("tags"):
                lines.append(f"  Tags: {t['tags']}")
            lines.append(f"  INSTRUCTION: Perform the actual work for this task. Write real output/code/analysis.")
            lines.append(f"  When done, use: ##SWARM:DONE:{t['id']}:your complete result here##")

    if open_tasks:
        lines.append("### Open Tasks (available to claim)")
        for t in open_tasks:
            lines.append(f"- id={t.get('id', '?')} [{t.get('priority', 'medium')}] {t.get('title', '?')} (tags: {t.get('tags', [])})")
            if t.get("description"):
                lines.append(f"  {t['description'][:120]}")

    # Recent messages
    recent = state["messages"][-10:]
    if recent:
        lines.append("")
        lines.append("## Recent Messages")
        agent_names = {a.get("id"): a.get("name", "?") for a in state["agents"]}
        for m in recent:
            frm = agent_names.get(m.get("from"), (m.get("from") or "?")[:8])
            to  = m.get("to", "?")
            to  = "ALL" if to == "broadcast" else agent_names.get(to, to[:8] if to else "?")
            lines.append(f"- [{frm} -> {to}]: {m.get('content', '')}")

    # Escalations
    if state["escalations"]:
        lines.append("")
        lines.append("## Pending Escalations (need human decision — do NOT auto-resolve)")
        for e in state["escalations"]:
            lines.append(f"- [{e.get('severity', '?')}] {e.get('message_content', '?')}")

    lines.append("")
    lines.append("## How to take action")
    lines.append("Put action markers on their own lines at the END of your response.")
    lines.append("You can include multiple action lines.")
    lines.append("")
    lines.append("### Task actions")
    lines.append("  ##SWARM:CLAIM:task-uuid##")
    lines.append("    Claim an open task. Replace task-uuid with the full id from the task list above.")
    lines.append("")
    lines.append("  ##SWARM:DONE:task-uuid:result##")
    lines.append("    Mark your task complete. RESULT must be the ACTUAL output — code, analysis,")
    lines.append("    findings, implementation notes. Do not use placeholder text.")
    lines.append("    Example: ##SWARM:DONE:abc-123:Implemented login form in src/LoginForm.jsx. Added")
    lines.append("    email/password fields, validation, and submit handler calling POST /api/auth/login.##")
    lines.append("")
    lines.append("  ##SWARM:CREATE:title:priority:tags##")
    lines.append("    Create a new task. Priority: critical/high/medium/low. Tags: comma-separated.")
    lines.append("    Example: ##SWARM:CREATE:Write unit tests for auth module:high:testing,auth##")
    lines.append("")
    lines.append("  ##SWARM:SPLIT:task-uuid:Subtask A title|Subtask B title|Subtask C title##")
    lines.append("    Split a large task into smaller subtasks (separate titles with |).")
    lines.append("    The parent task becomes 'split' status; subtasks are created as open.")
    lines.append("    Example: ##SWARM:SPLIT:abc-123:Design DB schema|Build API endpoints|Write tests##")
    lines.append("")
    lines.append("  ##SWARM:DELEGATE:task-uuid:agent-uuid##")
    lines.append("    Reassign a task to another agent (use their full id from Team Members above).")
    lines.append("")
    lines.append("### Communication")
    lines.append("  ##SWARM:MSG:agent-uuid:message##   — direct message to agent")
    lines.append("  ##SWARM:BROADCAST:message##         — message to all agents")
    lines.append("  ##SWARM:STATUS:working|idle##       — update your status")
    lines.append("")
    lines.append("### Rules")
    lines.append("- Only claim tasks that match your capabilities.")
    lines.append("- When working on a task, produce REAL output — actual code, real analysis, concrete results.")
    lines.append("- Split large tasks before claiming if they are too broad.")
    lines.append("- Delegate if another agent is better suited.")
    lines.append("- If a task is ambiguous, broadcast a question before claiming.")

    return "\n".join(lines)


# --- Parse LLM response for actions ---

# Match ##SWARM:VERB:payload## anywhere in the text — even inside code fences,
# indented, or with surrounding prose. The payload runs until the closing ##.
_MARKER_RE = re.compile(r"##SWARM:([A-Z]+):?(.*?)##", re.DOTALL)


def parse_actions(response):
    """Extract action markers from an LLM response. Robust to code fences and inline text."""
    actions = []
    for m in _MARKER_RE.finditer(response or ""):
        verb = m.group(1).strip().upper()
        payload = (m.group(2) or "").strip()

        if verb == "CLAIM":
            if payload:
                actions.append({"type": "claim", "task_id": payload})

        elif verb == "DONE":
            parts = payload.split(":", 1)
            actions.append({
                "type": "done",
                "task_id": parts[0].strip(),
                "result": parts[1].strip() if len(parts) > 1 else "",
            })

        elif verb == "CREATE":
            parts = payload.split(":", 2)
            title    = parts[0].strip() if len(parts) > 0 and parts[0].strip() else "Untitled task"
            priority = parts[1].strip() if len(parts) > 1 else "medium"
            tags_raw = parts[2].strip() if len(parts) > 2 else ""
            tags = [t.strip() for t in tags_raw.split(",") if t.strip()]
            actions.append({"type": "create", "title": title, "priority": priority, "tags": tags})

        elif verb == "SPLIT":
            parts = payload.split(":", 1)
            task_id    = parts[0].strip()
            sub_titles = [s.strip() for s in parts[1].split("|") if s.strip()] if len(parts) > 1 else []
            actions.append({"type": "split", "task_id": task_id, "subtasks": sub_titles})

        elif verb == "DELEGATE":
            parts = payload.split(":", 1)
            actions.append({
                "type": "delegate",
                "task_id": parts[0].strip(),
                "to_agent": parts[1].strip() if len(parts) > 1 else "",
            })

        elif verb == "MSG":
            parts = payload.split(":", 1)
            actions.append({
                "type": "msg",
                "to": parts[0].strip(),
                "content": parts[1].strip() if len(parts) > 1 else "",
            })

        elif verb == "BROADCAST":
            actions.append({"type": "broadcast", "content": payload})

        elif verb == "STATUS":
            actions.append({"type": "status", "status": payload})

    return actions


# --- Apply actions ---

def apply_actions(actions, agent_id):
    for action in actions:
        try:
            t = action["type"]
            if t == "claim":
                claim_task(agent_id, action["task_id"])
            elif t == "done":
                complete_task(agent_id, action["task_id"], action.get("result", ""))
            elif t == "create":
                create_task(agent_id, action["title"], action.get("priority", "medium"), action.get("tags", []))
            elif t == "split":
                split_task(agent_id, action["task_id"], action.get("subtasks", []))
            elif t == "delegate":
                delegate_task(agent_id, action["task_id"], action.get("to_agent", ""))
            elif t == "msg":
                send_message(agent_id, action["to"], action.get("content", ""))
            elif t == "broadcast":
                send_message(agent_id, "broadcast", action.get("content", ""))
            elif t == "status":
                update_status(agent_id, action["status"])
        except Exception as e:
            print(f"  [!] Action failed: {action.get('type')} — {e}", file=sys.stderr)


def claim_task(agent_id, task_id):
    # 1. Create claim ticket (conflict-free — one file per agent)
    claims_dir = os.path.join(SWARM_ROOT, ".swarm", "claims")
    os.makedirs(claims_dir, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    ts = now.replace(":", "-").replace(".", "-")
    ticket = {"task_id": task_id, "agent_id": agent_id, "timestamp": now}
    fp = os.path.join(claims_dir, f"claim-{task_id}-{agent_id}-{ts}.yaml")
    with open(fp, "w", encoding="utf-8") as f:
        f.write(serialize_yaml(ticket) + "\n")

    # 2. Update task file (optimistic — check for conflicts on next pull)
    task_file = os.path.join(SWARM_ROOT, ".swarm", "tasks", f"task-{task_id}.yaml")
    if os.path.exists(task_file):
        task = parse_yaml(open(task_file, encoding="utf-8").read())
        if task.get("status") == "done":
            print(f"  [!] Task {task_id[:8]} already done — skipping claim", file=sys.stderr)
            return
        task["assigned_to"] = agent_id
        task["status"] = "in_progress"
        task["updated_at"] = datetime.now(timezone.utc).isoformat()
        with open(task_file, "w", encoding="utf-8") as f:
            f.write(serialize_yaml(task) + "\n")

    # 3. Update agent status
    update_status(agent_id, "working", current_task=task_id)
    print(f"  [+] Claimed task {task_id[:8]}")


def complete_task(agent_id, task_id, result):
    task_file = os.path.join(SWARM_ROOT, ".swarm", "tasks", f"task-{task_id}.yaml")
    if os.path.exists(task_file):
        task = parse_yaml(open(task_file, encoding="utf-8").read())
        task["status"] = "done"
        task["result"] = result
        task["updated_at"] = datetime.now(timezone.utc).isoformat()
        with open(task_file, "w", encoding="utf-8") as f:
            f.write(serialize_yaml(task) + "\n")

    # Clean up claim tickets
    claims_dir = os.path.join(SWARM_ROOT, ".swarm", "claims")
    if os.path.isdir(claims_dir):
        for f in os.listdir(claims_dir):
            if f.startswith(f"claim-{task_id}-"):
                try:
                    os.unlink(os.path.join(claims_dir, f))
                except Exception:
                    pass

    update_status(agent_id, "idle")
    print(f"  [+] Completed task {task_id[:8]}: {result[:80]}")


def create_task(agent_id, title, priority="medium", tags=None):
    task_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    task = {
        "id": task_id,
        "title": title,
        "description": "",
        "created_by": agent_id,
        "assigned_to": None,
        "status": "open",
        "priority": priority if priority in ("critical", "high", "medium", "low") else "medium",
        "tags": tags or [],
        "dependencies": [],
        "subtasks": [],
        "parent_task": None,
        "created_at": now,
        "updated_at": now,
        "result": None,
        "files_changed": [],
    }
    tasks_dir = os.path.join(SWARM_ROOT, ".swarm", "tasks")
    os.makedirs(tasks_dir, exist_ok=True)
    with open(os.path.join(tasks_dir, f"task-{task_id}.yaml"), "w", encoding="utf-8") as f:
        f.write(serialize_yaml(task) + "\n")
    print(f"  [+] Created task {task_id[:8]}: {title}")
    return task_id


def split_task(agent_id, parent_task_id, subtask_titles):
    """Split a parent task into named subtasks."""
    if not subtask_titles:
        print(f"  [!] No subtask titles provided for split of {parent_task_id[:8]}", file=sys.stderr)
        return

    parent_file = os.path.join(SWARM_ROOT, ".swarm", "tasks", f"task-{parent_task_id}.yaml")
    if not os.path.exists(parent_file):
        print(f"  [!] Parent task {parent_task_id[:8]} not found", file=sys.stderr)
        return

    parent = parse_yaml(open(parent_file, encoding="utf-8").read())
    subtask_ids = []

    for title in subtask_titles:
        sub_id = create_task(
            agent_id,
            title,
            priority=parent.get("priority", "medium"),
            tags=parent.get("tags", []) if isinstance(parent.get("tags"), list) else [],
        )
        subtask_ids.append(sub_id)

        # Set parent reference on subtask
        sub_file = os.path.join(SWARM_ROOT, ".swarm", "tasks", f"task-{sub_id}.yaml")
        if os.path.exists(sub_file):
            sub = parse_yaml(open(sub_file, encoding="utf-8").read())
            sub["parent_task"] = parent_task_id
            with open(sub_file, "w", encoding="utf-8") as f:
                f.write(serialize_yaml(sub) + "\n")

    # Update parent
    parent["status"] = "split"
    parent["subtasks"] = subtask_ids
    parent["updated_at"] = datetime.now(timezone.utc).isoformat()
    with open(parent_file, "w", encoding="utf-8") as f:
        f.write(serialize_yaml(parent) + "\n")

    send_message(agent_id, "broadcast",
        f"Split task '{parent.get('title', parent_task_id[:8])}' into {len(subtask_ids)} subtasks: {', '.join(subtask_titles)}")
    print(f"  [+] Split task {parent_task_id[:8]} into {len(subtask_ids)} subtasks")


def delegate_task(from_agent, task_id, to_agent_id):
    """Reassign a task to another agent."""
    task_file = os.path.join(SWARM_ROOT, ".swarm", "tasks", f"task-{task_id}.yaml")
    if not os.path.exists(task_file):
        print(f"  [!] Task {task_id[:8]} not found", file=sys.stderr)
        return

    task = parse_yaml(open(task_file, encoding="utf-8").read())
    old_assignee = task.get("assigned_to")
    task["assigned_to"] = to_agent_id
    task["status"] = "assigned"
    task["updated_at"] = datetime.now(timezone.utc).isoformat()
    with open(task_file, "w", encoding="utf-8") as f:
        f.write(serialize_yaml(task) + "\n")

    send_message(from_agent, to_agent_id,
        f"Task '{task.get('title', task_id[:8])}' delegated to you. Please claim and work on it.")
    print(f"  [+] Delegated task {task_id[:8]} to agent {to_agent_id[:8]}")


def send_message(agent_id, to, content):
    msgs_dir = os.path.join(SWARM_ROOT, ".swarm", "messages")
    os.makedirs(msgs_dir, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    ts = now.replace(":", "-").replace(".", "-")
    msg = {
        "id": str(uuid.uuid4()),
        "from": agent_id,
        "to": to,
        "type": "chat",
        "content": content,
        "timestamp": now,
    }
    fp = os.path.join(msgs_dir, f"{ts}-{agent_id[:8]}.yaml")
    with open(fp, "w", encoding="utf-8") as f:
        f.write(serialize_yaml(msg) + "\n")
    dest = "all" if to == "broadcast" else to[:8]
    print(f"  [+] Sent message to {dest}")


def update_status(agent_id, status, current_task=None):
    agent_file = os.path.join(SWARM_ROOT, ".swarm", "agents", f"agent-{agent_id}.yaml")
    if not os.path.exists(agent_file):
        return
    agent = parse_yaml(open(agent_file, encoding="utf-8").read())
    agent["status"] = status
    agent["last_seen"] = datetime.now(timezone.utc).isoformat()
    if current_task is not None:
        agent["current_task"] = current_task
    elif status == "idle":
        agent["current_task"] = None
    with open(agent_file, "w", encoding="utf-8") as f:
        f.write(serialize_yaml(agent) + "\n")


# --- Lead distribution (single source of truth via node CLI) ---

def _adapter_dir():
    try:
        return os.path.dirname(os.path.abspath(__file__))
    except NameError:
        for cand in [os.path.join(os.getcwd(), "adapters"), os.getcwd()]:
            if os.path.exists(os.path.join(cand, "codex-wrapper.py")):
                return cand
        return os.getcwd()


def _plugin_root():
    # adapters/ lives directly under the plugin root
    return os.path.dirname(_adapter_dir())


def is_lead(agent_id):
    hierarchy_file = os.path.join(SWARM_ROOT, ".swarm", "hierarchy.yaml")
    if not os.path.exists(hierarchy_file):
        return False
    try:
        h = parse_yaml(open(hierarchy_file, encoding="utf-8").read())
        return h.get("lead") == agent_id
    except Exception:
        return False


def run_distribute(agent_id):
    """If this agent is the lead, distribute open tasks via the node orchestrator CLI.

    Single source of truth: lib/orchestrator.js. Gracefully skips if node is absent.
    """
    if not is_lead(agent_id):
        return
    node = shutil.which("node")
    cli = os.path.join(_plugin_root(), "lib", "orchestrator-cli.js")
    if not node or not os.path.exists(cli):
        return
    try:
        result = subprocess.run(
            [node, cli, "distribute", SWARM_ROOT, agent_id],
            capture_output=True, text=True, timeout=30,
            creationflags=_NO_WINDOW,
        )
        out = (result.stdout or "").strip()
        if out:
            try:
                parsed = json.loads(out.splitlines()[-1])
                n = len(parsed.get("assignments", []))
                if n:
                    print(f"  [lead] Distributed {n} task(s) to agents.")
            except Exception:
                pass
    except Exception as e:
        print(f"  [lead] distribute skipped: {e}", file=sys.stderr)


# --- Fake LLM (offline test mode) ---

def fake_llm_response(state, agent_id):
    """Deterministic response for SWARM_FAKE_LLM=1 — no API call, no spend.

    If the agent has an assigned/in_progress task, complete it with a stub result.
    Otherwise claim the best-matching open task. Lets the full loop be tested offline.
    """
    mine = [t for t in state["tasks"]
            if t.get("assigned_to") == agent_id and t.get("status") in ("assigned", "in_progress")]
    if mine:
        t = mine[0]
        return (
            f"[FAKE_LLM] Completing assigned task.\n"
            f"##SWARM:DONE:{t['id']}:[fake] Completed '{t.get('title','')}' — "
            f"stub result produced by SWARM_FAKE_LLM test mode.##\n"
            f"##SWARM:STATUS:idle##"
        )
    open_tasks = [t for t in state["tasks"] if t.get("status") == "open"]
    if open_tasks:
        # Prefer a capability match, else take the first.
        match = next(
            (t for t in open_tasks
             if any(c in (t.get("tags") or []) for c in CAPABILITIES)),
            open_tasks[0],
        )
        return f"[FAKE_LLM] Claiming open task.\n##SWARM:CLAIM:{match['id']}##"
    return "[FAKE_LLM] No work available. Standing by."


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
        "max_tokens": 4096,
        "temperature": 0.2,
    }).encode("utf-8")

    req = urllib.request.Request(API_URL, data=payload, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    })

    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        if e.code == 429 or "quota" in body.lower() or "rate" in body.lower():
            raise RuntimeError(f"CREDITS_EXHAUSTED: {e.code} {body[:200]}")
        raise RuntimeError(f"API error: {e.code} {body[:200]}")


# --- Main loop ---

def main():
    global SWARM_ROOT, AGENT_NAME, CAPABILITIES, AGENT_ID_FILE

    import argparse
    parser = argparse.ArgumentParser(description="Swarm Codex Adapter")
    parser.add_argument("--swarm-root", default=SWARM_ROOT)
    parser.add_argument("--name", default=AGENT_NAME)
    parser.add_argument("--capabilities", default=",".join(CAPABILITIES))
    parser.add_argument("--interval", type=int, default=SYNC_INTERVAL)
    parser.add_argument("--once", action="store_true", help="Run single cycle then exit")
    args = parser.parse_args()

    SWARM_ROOT = args.swarm_root
    AGENT_NAME = args.name
    CAPABILITIES = [c.strip() for c in args.capabilities.split(",") if c.strip()]
    AGENT_ID_FILE = os.path.join(SWARM_ROOT, ".swarm", "agents", f".{PROVIDER}-agent-id")

    agent_id = get_agent_id()

    # Auto-discover WebSocket server URL
    server_url = discover_server_url()
    if server_url:
        os.environ["SWARM_SERVER_URL"] = server_url
        print(f"[swarm] Server URL discovered: {server_url}")
    else:
        print(f"[swarm] No WS server found — git-only mode.")
        print(f"[swarm] Start server with: node lib/server.js")

    print(f"[swarm] {PROVIDER.capitalize()} adapter starting")
    print(f"[swarm] Agent:  {AGENT_NAME} ({agent_id[:8]})")
    print(f"[swarm] Root:   {SWARM_ROOT}")
    print(f"[swarm] Caps:   {CAPABILITIES}")
    print(f"[swarm] Model:  {API_MODEL}")
    print(f"[swarm] Mode:   {'FAKE_LLM (offline test)' if FAKE_LLM else ('live' if API_KEY else 'NO API KEY — idle')}")
    print()

    # Bootstrap dirs + register
    git_pull()
    ensure_swarm_dirs()
    register_agent(agent_id)
    git_push(f"swarm: {agent_id[:8]} joined as {AGENT_NAME}")
    print(f"[swarm] Registered and pushed. Starting main loop.")
    print(f"[swarm] Context guide: {os.path.join(os.path.dirname(os.path.abspath(__file__)), 'CODEX.md')}")
    print()

    cycle = 0
    while True:
        cycle += 1
        print(f"[cycle {cycle}] Syncing...")

        try:
            git_pull()
            heartbeat(agent_id)

            # If this agent is the lead, hand out open tasks to the best agents first.
            run_distribute(agent_id)

            state = read_swarm_state()
            system_prompt = format_state_as_prompt(state, agent_id)

            # Tasks assigned to me — highest-priority work.
            assigned = [t for t in state["tasks"]
                        if t.get("assigned_to") == agent_id and t.get("status") in ("assigned", "in_progress")]
            # Assignment prompts addressed to me.
            assignment_msgs = [m for m in state["messages"]
                               if m.get("to") == agent_id and m.get("type") == "task_assignment"]
            unread = [m for m in state["messages"][-10:]
                      if m.get("to") in (agent_id, "broadcast") and m.get("from") != agent_id]
            open_tasks = [t for t in state["tasks"] if t.get("status") == "open"]

            if assigned:
                titles = ", ".join(f"'{t.get('title', '?')}'" for t in assigned[:3])
                extra = ""
                if assignment_msgs:
                    extra = "\nAssignment notes:\n" + "\n".join(
                        f"- {m.get('content', '')}" for m in assignment_msgs[:3])
                user_msg = (
                    f"WORK NOW. {len(assigned)} task(s) are assigned to you: {titles}.\n"
                    f"Produce real, complete output for each, then mark done with "
                    f"##SWARM:DONE:task-id:your actual result##.\n"
                    f"If a task is too large, split it with ##SWARM:SPLIT:task-id:part1|part2##."
                    + extra
                )
            elif open_tasks:
                matching = [t for t in open_tasks
                            if not t.get("tags") or
                            any(c in (t.get("tags") or []) for c in CAPABILITIES)]
                if matching:
                    user_msg = (
                        f"There are {len(matching)} open task(s) matching your capabilities. "
                        f"Claim the most important one with ##SWARM:CLAIM:task-id## and start working."
                    )
                else:
                    user_msg = (
                        f"There are {len(open_tasks)} open task(s) but none match your capabilities exactly. "
                        f"Claim one if you can still contribute, or stand by."
                    )
            elif unread:
                user_msg = (
                    f"You have {len(unread)} unread message(s). Review and respond if needed "
                    f"with ##SWARM:MSG:agent-id:reply##."
                )
            else:
                user_msg = "No pending work. Stand by, or create tasks if you see work to be done."

            # --- Decide the response source ---
            if FAKE_LLM:
                response = fake_llm_response(state, agent_id)
                first = response.splitlines()[0] if response else ""
                print(f"  [fake-llm] {first[:90]}")
            elif not API_KEY:
                print("  [!] No API key set (CODEX_API_KEY / OPENAI_API_KEY). "
                      "Agent will idle. Set a key, or use SWARM_FAKE_LLM=1 to test the loop.")
                response = ""
            else:
                print(f"  Calling {API_MODEL}...")
                llm = LLM_FN or call_openai
                response = llm(system_prompt, user_msg)
                print(f"  Response ({len(response)} chars): {response[:120]}...")

            actions = parse_actions(response)
            if actions:
                print(f"  Actions ({len(actions)}): {[a['type'] for a in actions]}")
                apply_actions(actions, agent_id)
            else:
                print("  No actions taken.")

            git_push(f"swarm: {agent_id[:8]} cycle {cycle}")

        except RuntimeError as e:
            if "CREDITS_EXHAUSTED" in str(e):
                print(f"  [!] Credits exhausted. Marking agent down.")
                update_status(agent_id, "credits_exhausted")
                send_message(agent_id, "broadcast",
                    f"Agent {AGENT_NAME} ({PROVIDER}) out of credits. Tasks need reassignment.")
                git_push(f"swarm: {agent_id[:8]} credits exhausted")
                if args.once:
                    break
                print("  Waiting 5 min before retry...")
                time.sleep(300)
                continue
            print(f"  [!] Error: {e}", file=sys.stderr)

        except Exception as e:
            print(f"  [!] Unexpected error: {e}", file=sys.stderr)

        if args.once:
            break

        print(f"  Sleeping {args.interval}s...")
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
