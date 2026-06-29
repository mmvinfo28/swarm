'use strict';

// Phase 1.2 — PreToolUse file-ownership guard must DENY a worker editing a file
// owned by another active task, and ALLOW otherwise. Drives the hook as a real
// subprocess (it reads stdin JSON and writes a permission decision).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tm = require('../lib/task-manager');

const HOOK = path.join(__dirname, '..', 'hooks', 'swarm-file-guard.js');

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-guard-'));
  for (const d of ['tasks', 'claims', 'agents']) {
    fs.mkdirSync(path.join(root, '.swarm', d), { recursive: true });
  }
  return root;
}

function runGuard(root, agentId, toolName, filePath) {
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: { file_path: filePath },
    cwd: root,
  });
  const env = Object.assign({}, process.env, { SWARM_ROOT: root });
  if (agentId) env.SWARM_AGENT_ID = agentId; else delete env.SWARM_AGENT_ID;
  const r = spawnSync(process.execPath, [HOOK], { input: payload, encoding: 'utf-8', env });
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

function decision(res) {
  return res && res.hookSpecificOutput ? res.hookSpecificOutput.permissionDecision : 'allow';
}

test('denies a worker editing a file owned by ANOTHER active task', () => {
  const root = mkRoot();
  const owner = 'agent-owner';
  const intruder = 'agent-intruder';

  const t = tm.createTask(root, 'Build shared lib', '', { tags: ['backend'] });
  tm.assignTask(root, t.id, owner);
  tm.setTaskFiles(root, t.id, ['shared.js']);

  const res = runGuard(root, intruder, 'Write', path.join(root, 'shared.js'));
  assert.strictEqual(decision(res), 'deny');
  assert.match(res.hookSpecificOutput.permissionDecisionReason, /owned by another active swarm task/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('allows the OWNER to edit its own file', () => {
  const root = mkRoot();
  const owner = 'agent-owner';
  const t = tm.createTask(root, 'Build shared lib', '', { tags: ['backend'] });
  tm.assignTask(root, t.id, owner);
  tm.setTaskFiles(root, t.id, ['shared.js']);

  const res = runGuard(root, owner, 'Write', path.join(root, 'shared.js'));
  assert.strictEqual(decision(res), 'allow');

  fs.rmSync(root, { recursive: true, force: true });
});

test('allows a file no active task owns', () => {
  const root = mkRoot();
  const owner = 'agent-owner';
  const t = tm.createTask(root, 'Build shared lib', '', { tags: ['backend'] });
  tm.assignTask(root, t.id, owner);
  tm.setTaskFiles(root, t.id, ['shared.js']);

  const res = runGuard(root, 'agent-other', 'Edit', path.join(root, 'unrelated.js'));
  assert.strictEqual(decision(res), 'allow');

  fs.rmSync(root, { recursive: true, force: true });
});

test('no SWARM_AGENT_ID (human operator) → never blocked', () => {
  const root = mkRoot();
  const owner = 'agent-owner';
  const t = tm.createTask(root, 'Build shared lib', '', { tags: ['backend'] });
  tm.assignTask(root, t.id, owner);
  tm.setTaskFiles(root, t.id, ['shared.js']);

  const res = runGuard(root, null, 'Write', path.join(root, 'shared.js'));
  assert.strictEqual(decision(res), 'allow');

  fs.rmSync(root, { recursive: true, force: true });
});
