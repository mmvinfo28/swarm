'use strict';

// auth-check — can the claude CLI authenticate headless (`claude -p`)?
// No network call: reads the CLI's on-disk oauth token expiry
// (~/.claude/.credentials.json) or accepts an explicit API key env.
// Used by the runner (preflight + auto-recovery), launch (start warning)
// and the dashboard (banner). This is what makes "no API key" mode
// self-diagnosing instead of silently hammering a 401.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const LOGIN_HINT = 'Open a terminal, run `claude`, type /login and finish the browser login. Workers resume automatically.';

function credentialsPath() {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

// → { ok, via, reason?, expiresAt? }
function status() {
  if (process.env.ANTHROPIC_API_KEY) return { ok: true, via: 'api-key' };
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath(), 'utf-8'));
    const o = raw.claudeAiOauth || raw;
    const exp = o.expiresAt || o.expires_at;
    if (!exp) return { ok: true, via: 'oauth' }; // no expiry recorded — assume ok
    const expIso = new Date(exp).toISOString();
    if (new Date(exp).getTime() > Date.now()) return { ok: true, via: 'oauth', expiresAt: expIso };
    return {
      ok: false, via: 'oauth', expiresAt: expIso,
      reason: `Claude CLI login expired ${expIso.slice(0, 10)}. ${LOGIN_HINT}`,
    };
  } catch (_) {
    return { ok: false, via: 'none', reason: `No Claude CLI credentials found. ${LOGIN_HINT}` };
  }
}

// Does an error/output string look like an auth failure from the CLI/API?
const AUTH_RE = /AUTH_FAILED|\b401\b|invalid authentication|invalid.?api.?key|failed to authenticate|not logged in|oauth token.*(expired|revoked)|please run.*login/i;
function isAuthError(msg) { return AUTH_RE.test(String(msg || '')); }

module.exports = { status, isAuthError, credentialsPath, LOGIN_HINT };
