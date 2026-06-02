'use strict';

// codex driver — prefers the `codex` CLI (no API key) if installed; otherwise
// falls back to the OpenAI API when CODEX_API_KEY / OPENAI_API_KEY is set.

const { spawnSync } = require('child_process');

const WIN = process.platform === 'win32';
const TIMEOUT = parseInt(process.env.SWARM_DRIVER_TIMEOUT || '180000', 10);
const MODEL = process.env.CODEX_MODEL || 'gpt-4o';
const API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';

function key() { return process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || ''; }

function cliAvailable() {
  try { return spawnSync('codex', ['--version'], { stdio: 'ignore', shell: WIN, timeout: 15000 }).status === 0; }
  catch (_) { return false; }
}

function available() { return cliAvailable() || !!key(); }

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
    if (cliAvailable()) {
      // `codex exec` runs a one-shot non-interactive prompt.
      const res = spawnSync('codex', ['exec', `${systemPrompt}\n\n${userPrompt}`], { encoding: 'utf-8', shell: WIN, timeout: TIMEOUT, maxBuffer: 16 * 1024 * 1024, env: process.env });
      if (res.status === 0) return { text: res.stdout || '' };
      // fall through to API on CLI failure
    }
    if (key()) return { text: await viaApi(systemPrompt, userPrompt) };
    throw new Error('codex unavailable: install the codex CLI or set CODEX_API_KEY/OPENAI_API_KEY');
  },
};
