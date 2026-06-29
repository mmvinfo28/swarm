'use strict';

// actions — parse ##SWARM:VERB:payload## markers from an LLM response and apply them.
// One JS code path shared by the background runner. Mirrors the Python adapter's verbs.

const agentRegistry = require('./agent-registry');
const taskManager = require('./task-manager');
const orchestrator = require('./orchestrator');
const ioBus = require('./io-bus');

// Match markers in prose. Fenced code blocks are stripped first (Phase 1.4) so an
// example marker the model writes inside ``` ``` can't trigger a real action.
const MARKER_RE = /##SWARM:([A-Z]+):?([\s\S]*?)##/g;

// Remove ```…``` and ~~~…~~~ fenced blocks before scanning for markers.
function stripCodeFences(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ');
}

function parseActions(text) {
  const actions = [];
  if (!text) return actions;
  text = stripCodeFences(text);
  let m;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(text)) !== null) {
    const verb = m[1].trim().toUpperCase();
    const payload = (m[2] || '').trim();

    if (verb === 'CLAIM') {
      if (payload) actions.push({ type: 'claim', taskId: payload });
    } else if (verb === 'DONE') {
      const i = payload.indexOf(':');
      actions.push({ type: 'done', taskId: (i === -1 ? payload : payload.slice(0, i)).trim(), result: i === -1 ? '' : payload.slice(i + 1).trim() });
    } else if (verb === 'CREATE') {
      const parts = payload.split(':');
      actions.push({ type: 'create', title: (parts[0] || 'Untitled').trim(), priority: (parts[1] || 'medium').trim(), tags: (parts[2] || '').split(',').map(s => s.trim()).filter(Boolean) });
    } else if (verb === 'SPLIT') {
      const i = payload.indexOf(':');
      const taskId = (i === -1 ? payload : payload.slice(0, i)).trim();
      const subs = i === -1 ? [] : payload.slice(i + 1).split('|').map(s => s.trim()).filter(Boolean);
      actions.push({ type: 'split', taskId, subtasks: subs });
    } else if (verb === 'DELEGATE') {
      const i = payload.indexOf(':');
      actions.push({ type: 'delegate', taskId: (i === -1 ? payload : payload.slice(0, i)).trim(), toAgent: i === -1 ? '' : payload.slice(i + 1).trim() });
    } else if (verb === 'MSG') {
      const i = payload.indexOf(':');
      actions.push({ type: 'msg', to: (i === -1 ? payload : payload.slice(0, i)).trim(), content: i === -1 ? '' : payload.slice(i + 1).trim() });
    } else if (verb === 'BROADCAST' || verb === 'ROOM') {
      actions.push({ type: 'room', content: payload });
    } else if (verb === 'STATUS') {
      actions.push({ type: 'status', status: payload });
    } else if (verb === 'ESCALATE') {
      if (payload) actions.push({ type: 'escalate', content: payload });
    } else if (verb === 'FILES') {
      // ##SWARM:FILES:id:a.html,b.js## — declare the files a task will own, so no
      // other active task can claim them (Option B file-ownership lock).
      const i = payload.indexOf(':');
      const taskId = (i === -1 ? payload : payload.slice(0, i)).trim();
      const files = (i === -1 ? '' : payload.slice(i + 1)).split(',').map(s => s.trim()).filter(Boolean);
      if (taskId && files.length) actions.push({ type: 'files', taskId, files });
    }
  }
  return actions;
}

function resolveAgent(root, ref) {
  if (!ref) return null;
  return agentRegistry.findByName(root, ref) || agentRegistry.getAgent(root, ref);
}

function applyActions(root, agentId, actions) {
  const applied = [];
  for (const a of actions) {
    try {
      if (a.type === 'claim') {
        // RULE: can only claim a task that is open / unassigned / already yours.
        const t = taskManager.getTask(root, a.taskId);
        if (!t) { applied.push({ type: 'claim', ok: false, error: 'no such task' }); continue; }
        if (t.status === 'done') { applied.push({ type: 'claim', ok: false, error: 'already done' }); continue; }
        if (t.status === 'split') { applied.push({ type: 'claim', ok: false, error: 'task is split — claim a part, not the parent' }); continue; }
        if (t.assigned_to && t.assigned_to !== agentId) { applied.push({ type: 'claim', ok: false, error: 'assigned to another agent' }); continue; }
        // No grabbing a splittable task whole while there are other agents — split it first.
        const live = agentRegistry.listAgents(root).filter(x => x.status !== 'offline');
        if (t.status === 'open' && live.length > 1 && taskManager.shouldAutoSplit(t.title, t.description)) {
          const subs = taskManager.autoSplitTask(root, a.taskId, live.length);
          if (subs && subs.length) {
            applied.push({ type: 'claim', ok: false, error: `too big — auto-split into ${subs.length} parts; claim ONE part`, split: subs.length });
            continue;
          }
        }
        const r = taskManager.claimTask(root, a.taskId, agentId);
        if (r.ok) agentRegistry.updateStatus(root, agentId, 'working', a.taskId);
        applied.push({ type: 'claim', ok: r.ok, taskId: a.taskId, error: r.error });

      } else if (a.type === 'done') {
        // RULE: can only complete a task that is assigned to YOU. Blocks agents from
        // "doing" work they were never given (the codex misbehavior).
        const t = taskManager.getTask(root, a.taskId);
        if (!t) { applied.push({ type: 'done', ok: false, error: 'task not found' }); continue; }
        if (t.assigned_to !== agentId) {
          applied.push({ type: 'done', ok: false, error: 'not yours — CLAIM it first' });
          continue;
        }
        taskManager.completeTask(root, a.taskId, a.result, []);
        agentRegistry.updateStatus(root, agentId, 'idle', null);
        ioBus.deliverBroadcast(root, agentId, { type: 'status_update', content: `Completed "${t.title}".` });
        applied.push({ type: 'done', ok: true, taskId: a.taskId });

      } else if (a.type === 'create') {
        const t = taskManager.createTask(root, a.title, '', { createdBy: agentId, priority: a.priority, tags: a.tags });
        // Split + cap-route the new task immediately so it can't be grabbed whole.
        try { orchestrator.distributeNow(root); } catch (_) {}
        applied.push({ type: 'create', ok: true, taskId: t.id });

      } else if (a.type === 'split') {
        const subs = taskManager.splitTask(root, a.taskId, a.subtasks.map(t => ({ title: t })));
        applied.push({ type: 'split', ok: !!subs, count: subs ? subs.length : 0 });

      } else if (a.type === 'delegate') {
        const target = resolveAgent(root, a.toAgent);
        if (!target) { applied.push({ type: 'delegate', ok: false, error: 'agent not found' }); continue; }
        taskManager.assignTask(root, a.taskId, target.id);
        const t = taskManager.getTask(root, a.taskId);
        ioBus.deliver(root, target.id, { from: agentId, type: 'task_assignment', content: orchestrator.buildAssignmentPrompt(t), refs: { tasks: [a.taskId] } });
        applied.push({ type: 'delegate', ok: true, taskId: a.taskId, to: target.id });

      } else if (a.type === 'msg') {
        // Replying to the human operator: 'human' is not a registered agent, so
        // surface the answer in the common room (the dashboard renders it). This
        // is what makes dashboard → LLM direct messages actually get a reply.
        const ref = String(a.to || '').toLowerCase();
        if (ref === 'human' || ref === 'user' || ref === 'panel' || ref === 'dashboard' || ref === 'operator') {
          ioBus.postRoom(root, agentId, a.content, 'chat');
          applied.push({ type: 'msg', ok: true, to: 'human' });
          continue;
        }
        const target = resolveAgent(root, a.to);
        if (!target) { applied.push({ type: 'msg', ok: false, error: 'agent not found: ' + a.to }); continue; }
        ioBus.deliver(root, target.id, { from: agentId, type: 'chat', content: a.content });
        applied.push({ type: 'msg', ok: true, to: target.id });

      } else if (a.type === 'room' || a.type === 'broadcast') {
        ioBus.postRoom(root, agentId, a.content, 'chat');
        applied.push({ type: 'room', ok: true });

      } else if (a.type === 'files') {
        // Declare file ownership for a task you hold. Reject files already locked by
        // another active task (Option B) so two agents never edit the same file.
        const t = taskManager.getTask(root, a.taskId);
        if (!t) { applied.push({ type: 'files', ok: false, error: 'no such task' }); continue; }
        if (t.assigned_to && t.assigned_to !== agentId) { applied.push({ type: 'files', ok: false, error: 'not your task' }); continue; }
        const conflict = taskManager.fileConflict(root, Object.assign({}, t, { files: a.files }));
        if (conflict) {
          applied.push({ type: 'files', ok: false, error: `file "${conflict.file}" locked by active task ${String(conflict.taskId).slice(0, 8)}` });
          // Tell the agent so it picks a different file/task instead of colliding.
          try { ioBus.deliver(root, agentId, { from: 'system', type: 'chat', content: `File "${conflict.file}" is owned by another active task — do NOT edit it. Pick a different file or task.` }); } catch (_) {}
          continue;
        }
        taskManager.setTaskFiles(root, a.taskId, a.files);
        applied.push({ type: 'files', ok: true, taskId: a.taskId, files: a.files });

      } else if (a.type === 'status') {
        agentRegistry.updateStatus(root, agentId, a.status);
        applied.push({ type: 'status', ok: true, status: a.status });

      } else if (a.type === 'escalate') {
        // Worker needs a human decision/approval — raise an actionable escalation the
        // user can resolve from the dashboard (Bug #5: room posts weren't actionable).
        const agentLoop = require('./agent-loop');
        const crypto = require('crypto');
        const esc = agentLoop.createEscalation(
          root, agentId,
          { id: crypto.randomUUID(), from: agentId, content: a.content },
          { reasons: [{ trigger: 'agent_request' }], severity: 'medium' },
          null
        );
        // Mirror to the room so it's also visible in the live feed.
        try { ioBus.postRoom(root, agentId, '[needs your decision] ' + a.content, 'chat'); } catch (_) {}
        applied.push({ type: 'escalate', ok: true, id: esc.id });
      }
    } catch (err) {
      applied.push({ type: a.type, ok: false, error: err.message });
    }
  }
  return applied;
}

module.exports = { parseActions, applyActions, MARKER_RE };
