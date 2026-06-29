#!/usr/bin/env node
// swarm — PreToolUse file-ownership guard (Phase 1.2)
//
// Makes the `##SWARM:FILES##` lock REAL instead of advisory. A headless worker
// (claude -p driver) runs with `--permission-mode acceptEdits` and could otherwise
// edit ANY file, ignoring which task owns it. This hook denies Write/Edit to a file
// that another ACTIVE task (assigned/in_progress) has declared it owns.
//
// Identity comes from env the claude driver sets on the worker: SWARM_AGENT_ID +
// SWARM_ROOT. The human's interactive Claude has neither → guard allows everything
// (we never want to block the operator). So enforcement applies only to workers.
//
// NOTE: deliberately does NOT honor SWARM_DISABLE_HOOKS — that flag is the recursion
// guard for SessionStart/UserPromptSubmit; PreToolUse has no recursion risk and MUST
// stay active inside the headless worker, which sets that very flag.

'use strict';

const fs = require('fs');
const path = require('path');

const GUARDED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function allow() { process.exit(0); }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// Normalize a path for overlap comparison: repo-relative if under root, forward
// slashes, no leading ./, lowercase. Mirrors task-manager.normFile semantics.
function norm(p, root) {
  if (!p) return '';
  let f = String(p);
  try {
    const abs = path.isAbsolute(f) ? f : path.resolve(root, f);
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) f = rel;
  } catch (_) {}
  return f.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

let input = '';
process.stdin.on('data', c => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const tool = data.tool_name;
    if (!GUARDED_TOOLS.has(tool)) return allow();

    const me = process.env.SWARM_AGENT_ID;
    if (!me) return allow(); // not a swarm worker (e.g. the human operator) → no guard

    const root = process.env.SWARM_ROOT
      || require('./swarm-config').findSwarmRoot(data.cwd || process.cwd());
    if (!root) return allow();

    const ti = data.tool_input || {};
    const target = ti.file_path || ti.notebook_path;
    if (!target) return allow();
    const targetKey = norm(target, root);
    if (!targetKey) return allow();

    const tm = require(path.join(__dirname, '..', 'lib', 'task-manager'));
    // Files owned by ACTIVE tasks that are NOT mine → locked to me.
    const myTasks = new Set(
      tm.listTasks(root, { assignedTo: me })
        .filter(t => t.status === 'assigned' || t.status === 'in_progress')
        .map(t => t.id)
    );
    for (const t of tm.listTasks(root)) {
      if (t.status !== 'assigned' && t.status !== 'in_progress') continue;
      if (myTasks.has(t.id)) continue;
      for (const f of (t.files || [])) {
        if (norm(f, root) === targetKey) {
          return deny(
            `File "${target}" is owned by another active swarm task (${String(t.id).slice(0, 8)}). ` +
            `Do NOT edit it — pick a different file or task, or declare your own files with ` +
            `##SWARM:FILES:<yourTaskId>:<files>## first.`
          );
        }
      }
    }
    return allow();
  } catch (_) {
    // Never block on guard failure — fail open so a bug here can't freeze a worker.
    return allow();
  }
});
