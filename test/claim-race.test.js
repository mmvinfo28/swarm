'use strict';

// Phase 1.1 — claim race must be conflict-free cross-machine.
// reconcileClaims() converges every claimed task to its earliest-ticket winner after
// a sync, releasing the optimistic-but-losing holder. Zero npm deps (node:test).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tm = require('../lib/task-manager');
const yaml = require('../lib/yaml');

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-claim-'));
  for (const d of ['tasks', 'claims', 'agents']) {
    fs.mkdirSync(path.join(root, '.swarm', d), { recursive: true });
  }
  return root;
}

// Write a claim ticket with an explicit timestamp so ordering is deterministic
// (real createClaimTicket uses Date.now(), which can collide within a ms).
function writeTicket(root, taskId, agentId, iso) {
  const ts = iso.replace(/[:.]/g, '-');
  const fp = path.join(root, '.swarm', 'claims', `claim-${taskId}-${agentId}-${ts}.yaml`);
  fs.writeFileSync(fp, yaml.serialize({ task_id: taskId, agent_id: agentId, timestamp: iso }) + '\n', 'utf-8');
}

test('loser of a cross-machine claim race is released; winner keeps the task', () => {
  const root = mkRoot();
  const A = 'agent-aaaa';   // earlier claim → should win
  const B = 'agent-bbbb';   // later claim → should lose

  const task = tm.createTask(root, 'Build the login form', '', { tags: ['frontend'] });

  // Two machines each optimistically claimed before seeing the other's ticket.
  writeTicket(root, task.id, A, '2026-06-29T10:00:00.000Z');
  writeTicket(root, task.id, B, '2026-06-29T10:00:01.000Z');
  // After the git merge, the task file reflects B's optimistic write (it pushed last).
  tm.updateTask(root, task.id, { assigned_to: B, status: 'in_progress' });

  // B's machine reconciles after pull.
  const releasedB = tm.reconcileClaims(root, B);
  assert.strictEqual(releasedB.length, 1, 'B should be told it lost exactly one task');
  assert.strictEqual(releasedB[0].taskId, task.id);
  assert.strictEqual(releasedB[0].winner, A);

  // The shared task file now belongs to the true winner A.
  assert.strictEqual(tm.getTask(root, task.id).assigned_to, A);
  assert.strictEqual(tm.getTask(root, task.id).status, 'in_progress');

  // A's machine reconciles too — winner keeps it, nothing released, idempotent.
  const releasedA = tm.reconcileClaims(root, A);
  assert.strictEqual(releasedA.length, 0, 'winner releases nothing');
  assert.strictEqual(tm.getTask(root, task.id).assigned_to, A);

  fs.rmSync(root, { recursive: true, force: true });
});

test('a lead reassignment is not reverted by a stale claim ticket', () => {
  const root = mkRoot();
  const A = 'agent-aaaa';
  const B = 'agent-bbbb';
  const task = tm.createTask(root, 'Ship feature', '', { tags: ['backend'] });

  // A claims (in_progress + ticket A).
  tm.claimTask(root, task.id, A);
  // Lead then reassigns to B (e.g. A went down). assignTask prunes the old ticket.
  tm.assignTask(root, task.id, B);

  const released = tm.reconcileClaims(root, B);
  assert.strictEqual(released.length, 0);
  assert.strictEqual(tm.getTask(root, task.id).assigned_to, B, 'reassignment stands');

  fs.rmSync(root, { recursive: true, force: true });
});

test('lead-assigned task (no claim ticket) is left untouched by reconcile', () => {
  const root = mkRoot();
  const A = 'agent-aaaa';
  const task = tm.createTask(root, 'Write API docs', '', { tags: ['api'] });
  tm.assignTask(root, task.id, A); // status 'assigned', no claim ticket

  const released = tm.reconcileClaims(root, A);
  assert.strictEqual(released.length, 0);
  assert.strictEqual(tm.getTask(root, task.id).assigned_to, A);
  assert.strictEqual(tm.getTask(root, task.id).status, 'assigned', 'no ticket → not converted to in_progress');

  fs.rmSync(root, { recursive: true, force: true });
});
