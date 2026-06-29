'use strict';

// Phase 3.1 — task dependencies (pipelines): a blocked task is hidden from claiming,
// and completing its last dependency newly-unblocks it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tm = require('../lib/task-manager');
const reg = require('../lib/agent-registry');

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-dep-'));
  for (const d of ['tasks', 'claims', 'agents']) {
    fs.mkdirSync(path.join(root, '.swarm', d), { recursive: true });
  }
  return root;
}

test('getNewlyUnblocked fires only when ALL dependencies are done', () => {
  const root = mkRoot();
  const A = tm.createTask(root, 'Design schema', '', { tags: ['backend'] });
  const B = tm.createTask(root, 'Write migration', '', { tags: ['backend'] });
  const C = tm.createTask(root, 'Wire API', '', { tags: ['api'], dependencies: [A.id, B.id] });

  assert.strictEqual(tm.isTaskBlocked(root, C.id), true, 'C blocked by A+B');

  // Need an agent for completeTask's status flips? completeTask only touches the task.
  tm.assignTask(root, A.id, 'agent-x');
  tm.completeTask(root, A.id, 'schema.sql', []);
  assert.deepStrictEqual(tm.getNewlyUnblocked(root, A.id), [], 'still blocked by B');
  assert.strictEqual(tm.isTaskBlocked(root, C.id), true);

  tm.assignTask(root, B.id, 'agent-x');
  tm.completeTask(root, B.id, '001_init.sql', []);
  const unblocked = tm.getNewlyUnblocked(root, B.id);
  assert.strictEqual(unblocked.length, 1);
  assert.strictEqual(unblocked[0].id, C.id);
  assert.strictEqual(tm.isTaskBlocked(root, C.id), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('findBestTask never offers a blocked task', () => {
  const root = mkRoot();
  const agent = reg.register(root, 'Dev', 'cli', ['api'], 'tester');
  const other = reg.register(root, 'Other', 'cli', ['backend'], 'tester');
  const A = tm.createTask(root, 'Prereq', '', { tags: ['backend'] });
  const C = tm.createTask(root, 'Wire API', '', { tags: ['api'], dependencies: [A.id] });

  // A is already being handled by `other`, so the only OPEN task is the blocked C.
  tm.assignTask(root, A.id, other.id);
  assert.strictEqual(tm.findBestTask(root, agent.id), null, 'C is blocked → nothing to claim');

  tm.completeTask(root, A.id, 'done', []);
  const best = tm.findBestTask(root, agent.id);
  assert.ok(best && best.id === C.id, 'C offered once unblocked');

  fs.rmSync(root, { recursive: true, force: true });
});
