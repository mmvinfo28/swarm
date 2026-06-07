'use strict';

// actions — parse ##SWARM:VERB:payload## markers from an LLM response and apply them.
// One JS code path shared by the background runner. Mirrors the Python adapter's verbs.

const agentRegistry = require('./agent-registry');
const taskManager = require('./task-manager');
const orchestrator = require('./orchestrator');
const ioBus = require('./io-bus');

// Match markers anywhere (code fences, inline, multiline).
const MARKER_RE = /##SWARM:([A-Z]+):?([\s\S]*?)##/g;

function parseActions(text) {
  const actions = [];
  if (!text) return actions;
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
        const r = taskManager.claimTask(root, a.taskId, agentId);
        if (r.ok) agentRegistry.updateStatus(root, agentId, 'working', a.taskId);
        applied.push({ type: 'claim', ok: r.ok, taskId: a.taskId, error: r.error });

      } else if (a.type === 'done') {
        const t = taskManager.getTask(root, a.taskId);
        if (!t) { applied.push({ type: 'done', ok: false, error: 'task not found' }); continue; }
        taskManager.completeTask(root, a.taskId, a.result, []);
        agentRegistry.updateStatus(root, agentId, 'idle', null);
        ioBus.deliverBroadcast(root, agentId, { type: 'status_update', content: `Completed "${t.title}".` });
        applied.push({ type: 'done', ok: true, taskId: a.taskId });

      } else if (a.type === 'create') {
        const t = taskManager.createTask(root, a.title, '', { createdBy: agentId, priority: a.priority, tags: a.tags });
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
        const target = resolveAgent(root, a.to);
        if (!target) { applied.push({ type: 'msg', ok: false, error: 'agent not found: ' + a.to }); continue; }
        ioBus.deliver(root, target.id, { from: agentId, type: 'chat', content: a.content });
        applied.push({ type: 'msg', ok: true, to: target.id });

      } else if (a.type === 'room' || a.type === 'broadcast') {
        ioBus.postRoom(root, agentId, a.content, 'chat');
        applied.push({ type: 'room', ok: true });

      } else if (a.type === 'status') {
        agentRegistry.updateStatus(root, agentId, a.status);
        applied.push({ type: 'status', ok: true, status: a.status });
      }
    } catch (err) {
      applied.push({ type: a.type, ok: false, error: err.message });
    }
  }
  return applied;
}

module.exports = { parseActions, applyActions, MARKER_RE };
