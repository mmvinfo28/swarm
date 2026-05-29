'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('./yaml');
const agentRegistry = require('./agent-registry');

const TASKS_DIR = 'tasks';
const CLAIMS_DIR = 'claims';
const MAX_TASKS_PER_AGENT = 3;

function tasksPath(swarmRoot) {
  return path.join(swarmRoot, '.swarm', TASKS_DIR);
}

function claimsPath(swarmRoot) {
  return path.join(swarmRoot, '.swarm', CLAIMS_DIR);
}

function taskFile(swarmRoot, taskId) {
  return path.join(tasksPath(swarmRoot), `task-${taskId}.yaml`);
}

// --- Conflict-free claim ticket system ---
// Instead of modifying task file (conflict risk),
// each agent creates its own claim ticket file.
// Winner = earliest timestamp. Losers see winner on next git pull.

function claimTicketFile(swarmRoot, taskId, agentId, timestamp) {
  // Filename: claim-{task-uuid}-{agent-uuid}-{ts}.yaml
  // Lexicographic sort = chronological sort. Winner = first file.
  const ts = (timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
  return path.join(claimsPath(swarmRoot), `claim-${taskId}-${agentId}-${ts}.yaml`);
}

function createClaimTicket(swarmRoot, taskId, agentId) {
  const dir = claimsPath(swarmRoot);
  ensureDir(dir);
  const now = new Date().toISOString();
  const ticket = {
    task_id: taskId,
    agent_id: agentId,
    timestamp: now,
  };
  const fp = claimTicketFile(swarmRoot, taskId, agentId, now);
  fs.writeFileSync(fp, yaml.serialize(ticket) + '\n', 'utf-8');
  return ticket;
}

function resolveClaimWinner(swarmRoot, taskId) {
  // Read all claim tickets for this task, sort by filename (= by timestamp)
  const dir = claimsPath(swarmRoot);
  if (!fs.existsSync(dir)) return null;

  const tickets = fs.readdirSync(dir)
    .filter(f => f.startsWith(`claim-${taskId}-`) && f.endsWith('.yaml'))
    .sort()  // lexicographic = chronological
    .map(f => yaml.parse(fs.readFileSync(path.join(dir, f), 'utf-8')))
    .filter(t => t && t.agent_id);

  return tickets.length > 0 ? tickets[0] : null;  // earliest = winner
}

function getMyActiveClaim(swarmRoot, taskId, agentId) {
  const winner = resolveClaimWinner(swarmRoot, taskId);
  if (!winner) return null;
  return winner.agent_id === agentId ? winner : null;
}

function pruneClaimsForTask(swarmRoot, taskId) {
  // Call after task is done — remove all claim tickets for it
  const dir = claimsPath(swarmRoot);
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir)
    .filter(f => f.startsWith(`claim-${taskId}-`) && f.endsWith('.yaml'))
    .forEach(f => fs.unlinkSync(path.join(dir, f)));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createTask(swarmRoot, title, description, opts) {
  opts = opts || {};
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const task = {
    id,
    title,
    description: description || '',
    created_by: opts.createdBy || null,
    assigned_to: opts.assignedTo || null,
    status: opts.assignedTo ? 'assigned' : 'open',
    priority: opts.priority || 'medium',
    tags: opts.tags || [],
    dependencies: opts.dependencies || [],
    subtasks: [],
    parent_task: opts.parentTask || null,
    created_at: now,
    updated_at: now,
    result: null,
    files_changed: [],
  };

  const dir = tasksPath(swarmRoot);
  ensureDir(dir);
  fs.writeFileSync(taskFile(swarmRoot, id), yaml.serialize(task) + '\n', 'utf-8');
  return task;
}

function getTask(swarmRoot, taskId) {
  const filePath = taskFile(swarmRoot, taskId);
  if (!fs.existsSync(filePath)) return null;
  return yaml.parse(fs.readFileSync(filePath, 'utf-8'));
}

function updateTask(swarmRoot, taskId, updates) {
  const task = getTask(swarmRoot, taskId);
  if (!task) return null;

  for (const key of Object.keys(updates)) {
    task[key] = updates[key];
  }
  task.updated_at = new Date().toISOString();
  fs.writeFileSync(taskFile(swarmRoot, taskId), yaml.serialize(task) + '\n', 'utf-8');
  return task;
}

function assignTask(swarmRoot, taskId, agentId) {
  return updateTask(swarmRoot, taskId, {
    assigned_to: agentId,
    status: 'assigned',
  });
}

function claimTask(swarmRoot, taskId, agentId) {
  const task = getTask(swarmRoot, taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (task.status === 'done') return { ok: false, error: 'task already completed' };

  // Step 1: Create claim ticket (conflict-free — new file, never conflicts)
  createClaimTicket(swarmRoot, taskId, agentId);

  // Step 2: Resolve winner from all existing tickets (after git pull + push)
  // Note: full resolution happens post-sync. Pre-sync we optimistically proceed.
  const winner = resolveClaimWinner(swarmRoot, taskId);
  const won = winner && winner.agent_id === agentId;

  if (!won) {
    return {
      ok: false,
      error: 'claim lost — ' + (winner ? winner.agent_id : 'unknown') + ' claimed first',
      winner: winner ? winner.agent_id : null,
    };
  }

  // Step 3: Winner updates task file (only winner does this)
  const updated = updateTask(swarmRoot, taskId, {
    assigned_to: agentId,
    status: 'in_progress',
  });
  return { ok: true, task: updated, won: true };
}

function verifyClaimAfterSync(swarmRoot, taskId, agentId) {
  // Call after git pull+push to verify claim still won
  const winner = resolveClaimWinner(swarmRoot, taskId);
  if (!winner) return { ok: false, error: 'no claim found' };
  if (winner.agent_id !== agentId) {
    return { ok: false, error: 'claim lost to ' + winner.agent_id, winner: winner.agent_id };
  }
  return { ok: true };
}

function completeTask(swarmRoot, taskId, result, filesChanged) {
  pruneClaimsForTask(swarmRoot, taskId);
  return updateTask(swarmRoot, taskId, {
    status: 'done',
    result: result || null,
    files_changed: filesChanged || [],
  });
}

function splitTask(swarmRoot, taskId, subtaskDefs) {
  const parent = getTask(swarmRoot, taskId);
  if (!parent) return null;

  const created = [];
  for (const def of subtaskDefs) {
    const sub = createTask(swarmRoot, def.title, def.description, {
      createdBy: parent.created_by,
      priority: def.priority || parent.priority,
      tags: def.tags || parent.tags,
      parentTask: taskId,
    });
    created.push(sub);
  }

  updateTask(swarmRoot, taskId, {
    subtasks: created.map(s => s.id),
    status: 'split',
  });

  return created;
}

function listTasks(swarmRoot, filter) {
  const dir = tasksPath(swarmRoot);
  if (!fs.existsSync(dir)) return [];

  let tasks = fs.readdirSync(dir)
    .filter(f => f.startsWith('task-') && f.endsWith('.yaml'))
    .map(f => yaml.parse(fs.readFileSync(path.join(dir, f), 'utf-8')))
    .filter(t => t && t.id);

  if (filter) {
    if (filter.status) tasks = tasks.filter(t => t.status === filter.status);
    if (filter.assignedTo) tasks = tasks.filter(t => t.assigned_to === filter.assignedTo);
    if (filter.priority) tasks = tasks.filter(t => t.priority === filter.priority);
    if (filter.createdBy) tasks = tasks.filter(t => t.created_by === filter.createdBy);
    if (filter.unassigned) tasks = tasks.filter(t => !t.assigned_to);
  }

  return tasks;
}

function findBestTask(swarmRoot, agentId) {
  const agent = agentRegistry.getAgent(swarmRoot, agentId);
  if (!agent) return null;

  const openTasks = listTasks(swarmRoot, { status: 'open' });
  if (openTasks.length === 0) return null;

  const agentCaps = new Set(agent.capabilities || []);
  const activeCount = listTasks(swarmRoot, { assignedTo: agentId })
    .filter(t => t.status === 'in_progress' || t.status === 'assigned')
    .length;

  if (activeCount >= MAX_TASKS_PER_AGENT) return null;

  const priorityWeight = { critical: 1.0, high: 0.75, medium: 0.5, low: 0.25 };

  const scored = openTasks.map(task => {
    const taskTags = task.tags || [];
    const capMatch = taskTags.length > 0
      ? taskTags.filter(t => agentCaps.has(t)).length / taskTags.length
      : 0.5;
    const loadBalance = 1 - (activeCount / MAX_TASKS_PER_AGENT);
    const prio = priorityWeight[task.priority] || 0.5;

    const score = capMatch * 0.5 + loadBalance * 0.3 + prio * 0.2;
    return { task, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0] ? scored[0].task : null;
}

function getTasksByParent(swarmRoot, parentId) {
  return listTasks(swarmRoot).filter(t => t.parent_task === parentId);
}

function isTaskBlocked(swarmRoot, taskId) {
  const task = getTask(swarmRoot, taskId);
  if (!task || !task.dependencies || task.dependencies.length === 0) return false;

  for (const depId of task.dependencies) {
    const dep = getTask(swarmRoot, depId);
    if (!dep || dep.status !== 'done') return true;
  }
  return false;
}

function getStats(swarmRoot) {
  const all = listTasks(swarmRoot);
  return {
    total: all.length,
    open: all.filter(t => t.status === 'open').length,
    assigned: all.filter(t => t.status === 'assigned').length,
    in_progress: all.filter(t => t.status === 'in_progress').length,
    done: all.filter(t => t.status === 'done').length,
    blocked: all.filter(t => isTaskBlocked(swarmRoot, t.id)).length,
  };
}

// --- Dynamic prioritization ---

const PRIORITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };

function escalatePriority(swarmRoot, taskId, newPriority, reason) {
  const task = getTask(swarmRoot, taskId);
  if (!task) return null;

  const oldPriority = task.priority;
  const oldLevel = PRIORITY_ORDER[oldPriority] || 0;
  const newLevel = PRIORITY_ORDER[newPriority] || 0;

  if (newLevel <= oldLevel) return task;

  return updateTask(swarmRoot, taskId, {
    priority: newPriority,
    escalation_reason: reason || null,
    escalated_at: new Date().toISOString(),
  });
}

function shouldPreempt(swarmRoot, agentId, newTaskId) {
  const agent = agentRegistry.getAgent(swarmRoot, agentId);
  if (!agent || !agent.current_task) return { preempt: false };

  const currentTask = getTask(swarmRoot, agent.current_task);
  const newTask = getTask(swarmRoot, newTaskId);
  if (!currentTask || !newTask) return { preempt: false };

  const currentLevel = PRIORITY_ORDER[currentTask.priority] || 0;
  const newLevel = PRIORITY_ORDER[newTask.priority] || 0;

  if (newLevel > currentLevel && newTask.priority === 'critical') {
    return {
      preempt: true,
      reason: `critical task "${newTask.title}" overrides ${currentTask.priority} task "${currentTask.title}"`,
      pauseTask: currentTask.id,
      startTask: newTask.id,
    };
  }

  return { preempt: false };
}

function preemptAndReassign(swarmRoot, agentId, newTaskId) {
  const check = shouldPreempt(swarmRoot, agentId, newTaskId);
  if (!check.preempt) return { ok: false, reason: 'no preemption needed' };

  updateTask(swarmRoot, check.pauseTask, {
    status: 'open',
    assigned_to: null,
    paused_by: agentId,
    paused_at: new Date().toISOString(),
  });

  claimTask(swarmRoot, newTaskId, agentId);
  agentRegistry.updateStatus(swarmRoot, agentId, 'working', newTaskId);

  return { ok: true, paused: check.pauseTask, started: newTaskId };
}

function rebalanceTasks(swarmRoot) {
  const agents = agentRegistry.listAgents(swarmRoot)
    .filter(a => a.status !== 'offline' && a.status !== 'credits_exhausted' && a.status !== 'error');
  const openTasks = listTasks(swarmRoot, { status: 'open' })
    .filter(t => !isTaskBlocked(swarmRoot, t.id));

  if (agents.length === 0 || openTasks.length === 0) return [];

  openTasks.sort((a, b) => (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0));

  const assignments = [];
  for (const task of openTasks) {
    const best = findBestAgentForTask(swarmRoot, task, agents);
    if (best) {
      assignments.push({ taskId: task.id, agentId: best.id, score: best._score });
    }
  }

  return assignments;
}

function findBestAgentForTask(swarmRoot, task, agents) {
  const taskTags = task.tags || [];
  const priorityWeight = { critical: 1.0, high: 0.75, medium: 0.5, low: 0.25 };

  let best = null;
  let bestScore = -1;

  for (const agent of agents) {
    const agentCaps = new Set(agent.capabilities || []);
    const activeCount = listTasks(swarmRoot, { assignedTo: agent.id })
      .filter(t => t.status === 'in_progress' || t.status === 'assigned')
      .length;

    if (activeCount >= MAX_TASKS_PER_AGENT) continue;

    const capMatch = taskTags.length > 0
      ? taskTags.filter(t => agentCaps.has(t)).length / taskTags.length
      : 0.5;
    const loadBalance = 1 - (activeCount / MAX_TASKS_PER_AGENT);
    const prio = priorityWeight[task.priority] || 0.5;

    const score = capMatch * 0.5 + loadBalance * 0.3 + prio * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = { ...agent, _score: score };
    }
  }

  return best;
}

function getUrgentUnassigned(swarmRoot) {
  return listTasks(swarmRoot)
    .filter(t =>
      !t.assigned_to &&
      t.status === 'open' &&
      (t.priority === 'critical' || t.priority === 'high') &&
      !isTaskBlocked(swarmRoot, t.id)
    )
    .sort((a, b) => (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0));
}

module.exports = {
  createTask,
  getTask,
  updateTask,
  assignTask,
  claimTask,
  verifyClaimAfterSync,
  completeTask,
  splitTask,
  listTasks,
  findBestTask,
  getTasksByParent,
  isTaskBlocked,
  getStats,
  // Claim tickets
  createClaimTicket,
  resolveClaimWinner,
  getMyActiveClaim,
  pruneClaimsForTask,
  // Dynamic prioritization
  PRIORITY_ORDER,
  escalatePriority,
  shouldPreempt,
  preemptAndReassign,
  rebalanceTasks,
  findBestAgentForTask,
  getUrgentUnassigned,
};
