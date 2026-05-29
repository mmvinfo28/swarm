#!/usr/bin/env python3
"""
Swarm Adapter — Google Gemini

Wraps Google AI API to participate in a swarm team.
Same architecture as codex-wrapper.py but uses Gemini API.

Requirements: GEMINI_API_KEY env var
Dependencies: Python 3.8+ stdlib only

Usage:
  python gemini-wrapper.py [--swarm-root /path/to/repo] [--name "Gemini-Carol"] [--capabilities testing,qa]
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

# Import shared functions from codex wrapper (same directory)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module

# We reuse most of codex-wrapper's functions
_codex = {}
exec(open(os.path.join(os.path.dirname(__file__), "codex-wrapper.py")).read(), _codex)

# Override only what differs
parse_yaml = _codex["parse_yaml"]
serialize_yaml = _codex["serialize_yaml"]
git = _codex["git"]
git_pull = _codex["git_pull"]
git_push = _codex["git_push"]
get_agent_id = _codex["get_agent_id"]
register_agent = _codex["register_agent"]
heartbeat = _codex["heartbeat"]
read_swarm_state = _codex["read_swarm_state"]
format_state_as_prompt = _codex["format_state_as_prompt"]
parse_actions = _codex["parse_actions"]
apply_actions = _codex["apply_actions"]
update_status = _codex["update_status"]
send_message = _codex["send_message"]

# --- Config ---

SWARM_ROOT = os.environ.get("SWARM_ROOT", os.getcwd())
AGENT_NAME = os.environ.get("SWARM_AGENT_NAME", f"Gemini-{os.getenv('USER', 'agent')}")
PROVIDER = "gemini"
CAPABILITIES = os.environ.get("SWARM_CAPABILITIES", "").split(",")
CAPABILITIES = [c.strip() for c in CAPABILITIES if c.strip()]
SYNC_INTERVAL = int(os.environ.get("SWARM_SYNC_INTERVAL", "15"))
API_KEY = os.environ.get("GEMINI_API_KEY", "")
API_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
AGENT_ID_FILE = os.path.join(SWARM_ROOT, ".swarm", "agents", ".gemini-agent-id")


# --- Gemini API call ---

def call_gemini(system_prompt, user_msg):
    if not API_KEY:
        raise RuntimeError("No API key. Set GEMINI_API_KEY env var.")

    url = API_URL.format(model=API_MODEL) + f"?key={API_KEY}"

    payload = json.dumps({
        "system_instruction": {
            "parts": [{"text": system_prompt}]
        },
        "contents": [
            {"role": "user", "parts": [{"text": user_msg}]}
        ],
        "generationConfig": {
            "maxOutputTokens": 2048,
            "temperature": 0.3,
        }
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
    })

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            candidates = data.get("candidates", [])
            if candidates:
                parts = candidates[0].get("content", {}).get("parts", [])
                if parts:
                    return parts[0].get("text", "")
            return ""
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        if e.code == 429 or "quota" in body.lower() or "rate" in body.lower():
            raise RuntimeError(f"CREDITS_EXHAUSTED: {e.code} {body[:200]}")
        raise RuntimeError(f"API error: {e.code} {body[:200]}")


# --- Main loop ---

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Swarm Gemini Adapter")
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

    # Override globals in imported codex module too
    _codex["SWARM_ROOT"] = SWARM_ROOT
    _codex["AGENT_NAME"] = AGENT_NAME
    _codex["PROVIDER"] = PROVIDER
    _codex["CAPABILITIES"] = CAPABILITIES
    _codex["AGENT_ID_FILE"] = os.path.join(SWARM_ROOT, ".swarm", "agents", ".gemini-agent-id")

    agent_id = get_agent_id()
    print(f"[swarm] Gemini adapter starting")
    print(f"[swarm] Agent: {AGENT_NAME} ({agent_id[:8]})")
    print(f"[swarm] Root: {SWARM_ROOT}")
    print(f"[swarm] Capabilities: {CAPABILITIES}")
    print(f"[swarm] Model: {API_MODEL}")
    print()

    # Register
    git_pull()
    _codex["PROVIDER"] = "gemini"
    register_agent(agent_id)
    git_push(f"swarm: {agent_id[:8]} joined as {AGENT_NAME}")

    cycle = 0
    while True:
        cycle += 1
        print(f"[cycle {cycle}] Syncing...")

        try:
            git_pull()
            heartbeat(agent_id)

            state = read_swarm_state()
            prompt = format_state_as_prompt(state, agent_id)

            my_tasks = [t for t in state["tasks"]
                       if t.get("assigned_to") == agent_id and t.get("status") != "done"]
            unread = [m for m in state["messages"][-10:]
                     if m.get("to") == agent_id or m.get("to") == "broadcast"]

            if my_tasks or unread:
                user_msg = "Check your tasks and messages. Take appropriate action."
            else:
                open_tasks = [t for t in state["tasks"] if t.get("status") == "open"]
                if open_tasks:
                    user_msg = f"There are {len(open_tasks)} open task(s). Consider claiming one."
                else:
                    user_msg = "No pending work. Stand by."

            print(f"  Calling {API_MODEL}...")
            response = call_gemini(prompt, user_msg)
            print(f"  Response: {response[:100]}...")

            actions = parse_actions(response)
            if actions:
                print(f"  Actions: {len(actions)}")
                apply_actions(actions, agent_id)
            else:
                print("  No actions.")

            git_push(f"swarm: {agent_id[:8]} cycle {cycle}")

        except RuntimeError as e:
            if "CREDITS_EXHAUSTED" in str(e):
                print(f"  [!] Credits exhausted!")
                update_status(agent_id, "credits_exhausted")
                send_message(agent_id, "broadcast",
                    f"Agent {AGENT_NAME} ({PROVIDER}) out of credits.")
                git_push(f"swarm: {agent_id[:8]} credits exhausted")
                if args.once:
                    break
                time.sleep(300)
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
