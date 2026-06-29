'use strict';

// Phase 3.2 (graceful shutdown) + 3.3 (plan-approval).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const actions = require('../lib/actions');
const reg = require('../lib/agent-registry');
const al = require('../lib/agent-loop');
const runner = require('../lib/runner');

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-sd-'));
  for (const d of ['tasks', 'claims', 'agents', 'escalations']) {
    fs.mkdirSync(path.join(root, '.swarm', d), { recursive: true });
  }
  return root;
}

test('##SWARM:SHUTDOWN## flags the agent + raises a shutdown_request escalation', () => {
  const root = mkRoot();
  const a = reg.register(root, 'Worker', 'cli', ['backend'], 't');

  const applied = actions.applyActions(root, a.id, [{ type: 'shutdown', reason: 'end of day' }]);
  assert.strictEqual(applied[0].ok, true);
  assert.strictEqual(reg.getAgent(root, a.id).shutdown_requested, true);

  const pending = al.getPendingEscalations(root, a.id);
  assert.strictEqual(pending.length, 1);
  assert.deepStrictEqual(pending[0].type, ['shutdown_request']);

  fs.rmSync(root, { recursive: true, force: true });
});

test('##SWARM:PLAN## raises a plan_approval escalation', () => {
  const root = mkRoot();
  const a = reg.register(root, 'Worker', 'cli', ['frontend'], 't');

  const applied = actions.applyActions(root, a.id, [{ type: 'plan', content: 'Build the form in 3 steps' }]);
  assert.strictEqual(applied[0].ok, true);

  const pending = al.getPendingEscalations(root, a.id);
  assert.strictEqual(pending.length, 1);
  assert.deepStrictEqual(pending[0].type, ['plan_approval']);
  assert.match(pending[0].message_content, /3 steps/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('runner tick exits cleanly (no LLM) once shutdown is approved (agent.stop)', async () => {
  const root = mkRoot();
  const a = reg.register(root, 'Worker', 'cli', ['backend'], 't');
  reg.patch(root, a.id, { stop: true }); // human approved

  const res = await runner.tick(
    { root, agentId: a.id, provider: 'claude', log: () => {} },
    { pull: false }
  );
  assert.strictEqual(res.shutdown, true);
  assert.strictEqual(reg.getAgent(root, a.id).status, 'offline');

  fs.rmSync(root, { recursive: true, force: true });
});
