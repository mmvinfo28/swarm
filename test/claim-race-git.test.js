'use strict';

// Phase 4 capstone — PROVE claims are conflict-free across machines with REAL git.
// Two clones of a bare remote race the same claim. Because a claim writes only its
// (uniquely-named) ticket in git mode, the loser's rebase merges cleanly — no conflict
// on the shared task file — and reconcileClaims converges both clones to one winner.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tm = require('../lib/task-manager');

const gitMissing = spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0;

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}
function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r;
}
function commitAll(cwd, msg) {
  gitOk(cwd, ['add', '-A']);
  gitOk(cwd, ['commit', '-q', '-m', msg]);
}
function configure(cwd) {
  gitOk(cwd, ['config', 'user.email', 't@example.com']);
  gitOk(cwd, ['config', 'user.name', 'Tester']);
}

test('two clones racing the same claim: clean rebase + converged winner', { skip: gitMissing && 'git not installed' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-git-'));
  const remote = path.join(base, 'remote.git');
  const A = path.join(base, 'A');
  const B = path.join(base, 'B');

  gitOk(base, ['init', '--bare', '-q', '-b', 'master', remote]);
  gitOk(base, ['clone', '-q', remote, A]);
  gitOk(base, ['clone', '-q', remote, B]);
  configure(A); configure(B);

  // A bootstraps the .swarm board with one open task, pushes.
  for (const d of ['tasks', 'claims', 'agents']) fs.mkdirSync(path.join(A, '.swarm', d), { recursive: true });
  const task = tm.createTask(A, 'Shared task', '', { tags: ['backend'] });
  commitAll(A, 'init swarm');
  gitOk(A, ['push', '-q', 'origin', 'master']);
  gitOk(B, ['pull', '-q', 'origin', 'master']);

  // Sanity: both clones are git repos → claimTask must DEFER (ticket only).
  const rA = tm.claimTask(A, task.id, 'agent-A');
  const rB = tm.claimTask(B, task.id, 'agent-B');
  assert.strictEqual(rA.pending, true, 'git-mode claim is deferred');
  assert.strictEqual(rB.pending, true);
  // Shared task file untouched by either claim (no pre-sync write = nothing to conflict).
  assert.strictEqual(tm.getTask(A, task.id).assigned_to, null);
  assert.strictEqual(tm.getTask(B, task.id).assigned_to, null);

  commitAll(A, 'A claim'); commitAll(B, 'B claim');
  gitOk(A, ['push', '-q', 'origin', 'master']);              // A wins the git race

  const bPush = git(B, ['push', '-q', 'origin', 'master']);
  assert.notStrictEqual(bPush.status, 0, 'B push rejected (non-fast-forward)');

  // THE KEY ASSERTION: B rebases onto A with NO conflict (only distinct ticket files).
  const rebase = git(B, ['pull', '--rebase', '--autostash', '-q', 'origin', 'master']);
  assert.strictEqual(rebase.status, 0, 'B rebase clean — no conflict on the task file');
  assert.strictEqual(git(B, ['ls-files', '-u']).stdout.trim(), '', 'no unmerged paths');
  gitOk(B, ['push', '-q', 'origin', 'master']);
  gitOk(A, ['pull', '--rebase', '--autostash', '-q', 'origin', 'master']);

  // Both clones now hold both tickets. Reconcile converges them to the same winner.
  const relA = tm.reconcileClaims(A, 'agent-A');
  const relB = tm.reconcileClaims(B, 'agent-B');

  const winnerA = tm.getTask(A, task.id).assigned_to;
  const winnerB = tm.getTask(B, task.id).assigned_to;
  assert.strictEqual(winnerA, winnerB, 'both clones converge to the same assignee');
  assert.strictEqual(winnerA, 'agent-A', 'earliest ticket wins');
  assert.strictEqual(tm.getTask(A, task.id).status, 'in_progress');
  assert.strictEqual(relA.length, 0, 'winner releases nothing');
  assert.strictEqual(relB.length, 1, 'loser B is released');
  assert.strictEqual(relB[0].winner, 'agent-A');

  // Materialized assignment is identical on both sides → pushing it never conflicts.
  commitAll(A, 'A reconcile');
  gitOk(A, ['push', '-q', 'origin', 'master']);
  const finalPull = git(B, ['pull', '--rebase', '--autostash', '-q', 'origin', 'master']);
  assert.strictEqual(finalPull.status, 0, 'materialized winner merges cleanly across clones');

  fs.rmSync(base, { recursive: true, force: true });
});
