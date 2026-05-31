#!/usr/bin/env python3
"""
Swarm Adapter — Google Gemini

Thin shim over codex-wrapper.py. Reuses the entire codex main loop (distribution,
assignment handling, robust marker parsing, fake-LLM test mode) and only swaps the
LLM call for Gemini's API. Single source of truth: codex-wrapper.py.

Requirements: GEMINI_API_KEY env var
Dependencies: Python 3.8+ stdlib only

Usage:
  python gemini-wrapper.py [--swarm-root /path/to/repo] [--name "Gemini-Carol"] [--capabilities testing,qa]
"""

import os
import sys
import json
import urllib.request
import urllib.error

# Load codex-wrapper as a shared module namespace. Provide __name__ so its
# `if __name__ == "__main__"` guard does NOT auto-run during exec.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_codex = {"__name__": "swarm_codex_shared"}
_codex_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "codex-wrapper.py")
exec(open(_codex_path, encoding="utf-8").read(), _codex)


# --- Gemini config ---

API_KEY = os.environ.get("GEMINI_API_KEY", "")
API_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_NAME = os.environ.get("SWARM_AGENT_NAME", f"Gemini-{os.getenv('USER', 'agent')}")


# --- Gemini API call (the only provider-specific piece) ---

def call_gemini(system_prompt, user_msg):
    if not API_KEY:
        raise RuntimeError("No API key. Set GEMINI_API_KEY env var.")

    url = API_URL.format(model=API_MODEL) + f"?key={API_KEY}"
    payload = json.dumps({
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_msg}]}],
        "generationConfig": {"maxOutputTokens": 4096, "temperature": 0.2},
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})

    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
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


# --- Main: configure the shared codex loop for Gemini, then run it ---

def main():
    _codex["PROVIDER"]   = "gemini"
    _codex["AGENT_NAME"] = DEFAULT_NAME
    _codex["API_KEY"]    = API_KEY
    _codex["API_MODEL"]  = API_MODEL
    _codex["API_URL"]    = API_URL
    _codex["LLM_FN"]     = call_gemini   # codex loop calls this instead of OpenAI
    _codex["main"]()


if __name__ == "__main__":
    main()
