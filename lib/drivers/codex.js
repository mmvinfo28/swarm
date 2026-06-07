'use strict';

// codex driver — prefers the `codex` CLI (no API key) if available; otherwise falls
// back to the OpenAI API when CODEX_API_KEY / OPENAI_API_KEY is set.
//
// The CLI is found even when not on PATH: env SWARM_CODEX_BIN, then `codex` on PATH,
// then the known install locations (e.g. %LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const WIN = process.platform === 'win32';
const TIMEOUT = parseInt(process.env.SWARM_DRIVER_TIMEOUT || '180000', 10);
const MODEL = process.env.CODEX_MODEL || 'gpt-4o';
const API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';

function key() { return process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || ''; }

function candidatePaths() {
  const c = [];
  const la = process.env.LOCALAPPDATA;
  const home = process.env.USERPROFILE || process.env.HOME;
  if (la) c.push(path.join(la, 'OpenAI', 'Codex', 'bin', 'codex.exe'));
  if (home) {
    c.push(path.join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    c.push(path.join(home, '.codex', 'bin', 'codex'));
  }
  return c;
}

// Resolve the codex binary once. Returns a path/name or null.
let _bin; // memoized
function resolveBin() {
  if (_bin !== undefined) return _bin;
  // 1. explicit override
  if (process.env.SWARM_CODEX_BIN && fs.existsSync(process.env.SWARM_CODEX_BIN)) { _bin = process.env.SWARM_CODEX_BIN; return _bin; }
  // 2. on PATH (no shell — avoids the arg-escaping deprecation warning)
  try { if (spawnSync('codex', ['--version'], { stdio: 'ignore', timeout: 15000 }).status === 0) { _bin = 'codex'; return _bin; } } catch (_) {}
  // 3. known install locations
  for (const p of candidatePaths()) { if (fs.existsSync(p)) { _bin = p; return _bin; } }
  _bin = null;
  return _bin;
}

function cliAvailable() { return !!resolveBin(); }
function available() { return cliAvailable() || !!key(); }

// The CLI default model can be one a ChatGPT-account login rejects. Use the model from
// the user's config.toml (what their IDE uses), overridable via SWARM_CODEX_MODEL.
function readConfigModel() {
  try {
    const home = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.codex');
    const cfg = fs.readFileSync(path.join(home, 'config.toml'), 'utf-8');
    const m = cfg.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch (_) { return null; }
}
function resolveModel() { return process.env.SWARM_CODEX_MODEL || readConfigModel() || null; }

async function viaApi(systemPrompt, userPrompt) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], max_tokens: 4096, temperature: 0.2 }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) throw new Error('CREDITS_EXHAUSTED: ' + body.slice(0, 200));
    throw new Error('openai API ' + res.status + ': ' + body.slice(0, 200));
  }
  const data = await res.json();
  return ((((data.choices || [])[0] || {}).message) || {}).content || '';
}

module.exports = {
  name: 'codex',
  available,
  async run(systemPrompt, userPrompt) {
    const bin = resolveBin();
    if (bin) {
      // `codex exec` runs one-shot, non-interactive. We:
      //  --ignore-user-config  → skip a possibly-broken ~/.codex/config.toml (auth still works)
      //  --sandbox read-only   → it reasons + emits markers, never edits repo files
      //  -o <file>             → capture ONLY the final assistant message (clean for parsing)
      const useShell = WIN && bin === 'codex';
      const outFile = path.join(os.tmpdir(), `swarm-codex-${crypto.randomBytes(4).toString('hex')}.txt`);
      const effort = process.env.SWARM_CODEX_EFFORT || 'low'; // low = faster + cheaper per tick
      const model = resolveModel();
      const args = ['exec', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only',
        '-c', `model_reasoning_effort=${effort}`];
      if (model) args.push('-c', `model=${model}`);
      args.push('-o', outFile, `${systemPrompt}\n\n${userPrompt}`);
      const res = spawnSync(bin, args, {
        encoding: 'utf-8', shell: useShell, timeout: TIMEOUT, maxBuffer: 16 * 1024 * 1024, env: process.env,
      });
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf-8'); } catch (_) { text = res.stdout || ''; }
      try { fs.unlinkSync(outFile); } catch (_) {}
      if (res.status === 0 || text.trim()) return { text };
      if (!key()) throw new Error('codex exec failed: ' + String((res.stderr || (res.error && res.error.message) || 'unknown')).slice(0, 300));
      // else fall through to API
    }
    if (key()) return { text: await viaApi(systemPrompt, userPrompt) };
    throw new Error('codex unavailable: install the codex CLI or set CODEX_API_KEY/OPENAI_API_KEY');
  },
};
