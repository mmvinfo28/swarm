'use strict';

// claude driver — runs Claude headless via `claude -p` (print mode).
// No API key — uses the user's Claude plan. Prompt is piped via stdin (avoids
// arg-quoting issues on Windows). SWARM_DISABLE_HOOKS=1 stops the spawned Claude
// from re-triggering the swarm SessionStart/UserPromptSubmit hooks (recursion guard).

const { spawnSync } = require('child_process');

const WIN = process.platform === 'win32';
const TIMEOUT = parseInt(process.env.SWARM_DRIVER_TIMEOUT || '180000', 10);

function available() {
  try {
    const r = spawnSync('claude', ['--version'], { stdio: 'ignore', shell: WIN, timeout: 15000, windowsHide: true });
    return r.status === 0;
  } catch (_) { return false; }
}

module.exports = {
  name: 'claude',
  available,
  async run(systemPrompt, userPrompt) {
    const prompt = `${systemPrompt}\n\n${userPrompt}`;
    // Default flags keep it text-only and non-interactive. Override via SWARM_CLAUDE_FLAGS.
    const flags = (process.env.SWARM_CLAUDE_FLAGS || '-p --output-format text').split(/\s+/).filter(Boolean);
    const res = spawnSync('claude', flags, {
      input: prompt,
      encoding: 'utf-8',
      shell: WIN,
      timeout: TIMEOUT,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: Object.assign({}, process.env, { SWARM_DISABLE_HOOKS: '1' }),
    });
    if (res.error) throw new Error('claude spawn failed: ' + res.error.message);
    if (res.status !== 0) throw new Error('claude -p exit ' + res.status + ': ' + String(res.stderr || '').slice(0, 300));
    return { text: res.stdout || '' };
  },
};
