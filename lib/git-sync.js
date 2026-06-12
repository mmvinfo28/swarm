'use strict';

const { execSync } = require('child_process');
const path = require('path');

const TIMEOUT = parseInt(process.env.SWARM_GIT_TIMEOUT || '30000', 10);
const MAX_RETRIES = 3;
const BACKOFF_BASE = 1000;

function exec(cmd, cwd, timeout) {
  return execSync(cmd, {
    cwd: cwd || process.cwd(),
    timeout: timeout || TIMEOUT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true, // don't flash a console window on Windows
  }).trim();
}

function sleep(ms) {
  execSync(`node -e "setTimeout(()=>{},${ms})"`, { timeout: ms + 5000, windowsHide: true });
}

function pull(cwd, retries, timeout) {
  retries = retries || MAX_RETRIES;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      exec('git pull --rebase --autostash', cwd, timeout);
      return { ok: true };
    } catch (err) {
      if (attempt === retries) {
        return { ok: false, error: err.message };
      }
      sleep(BACKOFF_BASE * attempt);
    }
  }
  return { ok: false, error: 'max retries reached' };
}

function push(cwd, retries) {
  retries = retries || MAX_RETRIES;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      exec('git push', cwd);
      return { ok: true };
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('rejected') || msg.includes('non-fast-forward')) {
        const pullResult = pull(cwd, 1);
        if (!pullResult.ok) {
          return { ok: false, error: 'push rejected, pull failed: ' + pullResult.error, conflict: true };
        }
        continue;
      }
      if (attempt === retries) {
        return { ok: false, error: msg };
      }
      sleep(BACKOFF_BASE * attempt);
    }
  }
  return { ok: false, error: 'max retries reached' };
}

function hasChanges(cwd) {
  try {
    const status = exec('git status --porcelain -- .swarm', cwd);
    return status.length > 0;
  } catch (_) {
    return false;
  }
}

function hasUntrackedSwarm(cwd) {
  try {
    const status = exec('git status --porcelain -- .swarm', cwd);
    return status.split('\n').some(l => l.startsWith('??'));
  } catch (_) {
    return false;
  }
}

function commitSwarm(message, cwd) {
  try {
    exec('git add .swarm', cwd);
    const changes = exec('git diff --cached --name-only -- .swarm', cwd);
    if (!changes) return { ok: true, noop: true };
    exec(`git commit -m "${message.replace(/"/g, '\\"')}"`, cwd);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function syncAndCommit(message, cwd) {
  const pullRes = pull(cwd);
  if (!pullRes.ok) return pullRes;

  if (!hasChanges(cwd)) return { ok: true, noop: true };

  const commitRes = commitSwarm(message, cwd);
  if (!commitRes.ok) return commitRes;
  if (commitRes.noop) return commitRes;

  return push(cwd);
}

function isGitRepo(cwd) {
  try {
    exec('git rev-parse --is-inside-work-tree', cwd);
    return true;
  } catch (_) {
    return false;
  }
}

function getRepoRoot(cwd) {
  try {
    return exec('git rev-parse --show-toplevel', cwd);
  } catch (_) {
    return null;
  }
}

function getLastCommitHash(cwd) {
  try {
    return exec('git log -1 --format=%H -- .swarm', cwd);
  } catch (_) {
    return null;
  }
}

module.exports = {
  pull,
  push,
  hasChanges,
  hasUntrackedSwarm,
  commitSwarm,
  syncAndCommit,
  isGitRepo,
  getRepoRoot,
  getLastCommitHash,
};
