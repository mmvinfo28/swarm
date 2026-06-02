'use strict';

// Driver picker. SWARM_DRIVER=fake forces the test driver. Otherwise pick by
// provider, preferring the free CLI path; throws a clear error if unavailable.

const fake = require('./fake');
const claude = require('./claude');
const gemini = require('./gemini');
const codex = require('./codex');

const REGISTRY = { fake, claude, gemini, codex };

function pick(provider) {
  if ((process.env.SWARM_DRIVER || '').toLowerCase() === 'fake') return fake;
  const key = (provider || 'claude').toLowerCase();
  const d = REGISTRY[key];
  if (!d) throw new Error(`unknown driver: ${provider}`);
  if (!d.available()) {
    throw new Error(`driver "${key}" not available — ` + (
      key === 'claude' ? 'install the Claude CLI (claude -p).' :
      key === 'gemini' ? 'install the gemini CLI or set GEMINI_API_KEY.' :
      key === 'codex'  ? 'install the codex CLI or set CODEX_API_KEY/OPENAI_API_KEY.' :
      'unavailable.'
    ));
  }
  return d;
}

module.exports = { pick, REGISTRY };
