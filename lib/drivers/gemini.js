'use strict';

// gemini driver — prefers the `gemini` CLI (no API key) if installed; otherwise
// falls back to the Gemini API when GEMINI_API_KEY is set.

const { spawnSync } = require('child_process');

const WIN = process.platform === 'win32';
const TIMEOUT = parseInt(process.env.SWARM_DRIVER_TIMEOUT || '180000', 10);
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

function cliAvailable() {
  try { return spawnSync('gemini', ['--version'], { stdio: 'ignore', shell: WIN, timeout: 15000, windowsHide: true }).status === 0; }
  catch (_) { return false; }
}

function available() {
  return cliAvailable() || !!process.env.GEMINI_API_KEY;
}

async function viaApi(prompt) {
  const key = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 4096, temperature: 0.2 } }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) throw new Error('CREDITS_EXHAUSTED: ' + body.slice(0, 200));
    throw new Error('gemini API ' + res.status + ': ' + body.slice(0, 200));
  }
  const data = await res.json();
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('');
}

module.exports = {
  name: 'gemini',
  available,
  async run(systemPrompt, userPrompt) {
    const prompt = `${systemPrompt}\n\n${userPrompt}`;
    if (cliAvailable()) {
      const res = spawnSync('gemini', ['-p'], { input: prompt, encoding: 'utf-8', shell: WIN, timeout: TIMEOUT, maxBuffer: 16 * 1024 * 1024, env: process.env, windowsHide: true });
      if (res.status === 0) return { text: res.stdout || '' };
      // fall through to API on CLI failure
    }
    if (process.env.GEMINI_API_KEY) return { text: await viaApi(prompt) };
    throw new Error('gemini unavailable: install the gemini CLI or set GEMINI_API_KEY');
  },
};
