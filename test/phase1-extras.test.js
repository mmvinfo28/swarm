'use strict';

// Phase 1.3 (config read), 1.4 (markers not in code fences), 1.5 (stop reopens).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tm = require('../lib/task-manager');
const actions = require('../lib/actions');
const launch = require('../lib/launch');
const yaml = require('../lib/yaml');

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-p1x-'));
  for (const d of ['tasks', 'claims', 'agents']) {
    fs.mkdirSync(path.join(root, '.swarm', d), { recursive: true });
  }
  return root;
}

// ── 1.3 config ──────────────────────────────────────────────────────────────
test('maxTasksPerAgent reads config.yaml, falls back to 3', () => {
  const root = mkRoot();
  assert.strictEqual(tm.maxTasksPerAgent(root), 3, 'no config → default 3');
  fs.writeFileSync(path.join(root, '.swarm', 'config.yaml'),
    yaml.serialize({ max_tasks_per_agent: 7 }) + '\n', 'utf-8');
  assert.strictEqual(tm.maxTasksPerAgent(root), 7, 'config value honored');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── 1.4 markers in fences ─────────────────────────────────────────────────────
test('a real marker fires; the same marker inside a code fence does not', () => {
  const real = actions.parseActions('On it. ##SWARM:CLAIM:task-1##');
  assert.strictEqual(real.length, 1);
  assert.strictEqual(real[0].type, 'claim');

  const fenced = actions.parseActions('Here is an example:\n```\n##SWARM:DONE:task-1:nope##\n```\nIDLE');
  assert.strictEqual(fenced.length, 0, 'fenced example must not trigger');

  const mixed = actions.parseActions('##SWARM:CLAIM:task-1##\n```js\n##SWARM:DONE:task-1:x##\n```');
  assert.strictEqual(mixed.length, 1, 'only the un-fenced marker counts');
  assert.strictEqual(mixed[0].type, 'claim');
});

// ── 1.5 stop reopens (default) / cancels (--cancel) ───────────────────────────
test('plain stop reopens active tasks; --cancel cancels them', () => {
  const root = mkRoot();
  const t = tm.createTask(root, 'Resume me', '', { tags: ['backend'] });
  tm.claimTask(root, t.id, 'agent-x'); // → in_progress + claim ticket

  launch.stop(root); // default: reopen
  let after = tm.getTask(root, t.id);
  assert.strictEqual(after.status, 'open', 'reopened');
  assert.strictEqual(after.assigned_to, null, 'unassigned');
  const claimsLeft = fs.readdirSync(path.join(root, '.swarm', 'claims')).filter(f => f.endsWith('.yaml'));
  assert.strictEqual(claimsLeft.length, 0, 'claim tickets pruned');

  // Now a cancel run on a fresh active task.
  const t2 = tm.createTask(root, 'Abandon me', '', { tags: ['backend'] });
  tm.claimTask(root, t2.id, 'agent-x');
  launch.stop(root, { cancel: true });
  assert.strictEqual(tm.getTask(root, t2.id).status, 'cancelled');

  fs.rmSync(root, { recursive: true, force: true });
});
