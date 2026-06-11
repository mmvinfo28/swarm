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

  // Warn about tags that don't match any agent capability (typo detection).
  if (task.tags && task.tags.length) {
    const agents = agentRegistry.listAgents(swarmRoot);
    const allCaps = new Set();
    for (const a of agents) for (const c of (a.capabilities || [])) allCaps.add(c.toLowerCase());
    const warnings = [];
    for (const tag of task.tags) {
      if (allCaps.has(tag.toLowerCase())) continue;
      let closest = null, bestDist = Infinity;
      for (const cap of allCaps) {
        const d = levenshtein(tag, cap);
        if (d < bestDist) { bestDist = d; closest = cap; }
      }
      if (closest && bestDist <= 2) warnings.push(`tag "${tag}" matches no agent — did you mean "${closest}"?`);
      else if (allCaps.size > 0) warnings.push(`tag "${tag}" matches no agent capability`);
    }
    if (warnings.length) task._tagWarnings = warnings;
  }

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
    review_status: 'pending_review',
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
    assigned_to: null,
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

  // Bug: workers grabbed big monolith tasks before the lead could split them.
  // Skip splittable tasks here — only the lead's distribute() splits + hands out parts.
  const multipleAgents = agentRegistry.listAgents(swarmRoot)
    .filter(a => a.status !== 'offline').length > 1;
  const openTasks = listTasks(swarmRoot, { status: 'open' })
    .filter(t => !(multipleAgents && shouldAutoSplit(t.title, t.description)));
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
      ? taskTags.reduce((sum, t) => sum + fuzzyCapMatch(t, agentCaps), 0) / taskTags.length
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

function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = tmp;
    }
  }
  return dp[m];
}

function fuzzyCapMatch(tag, agentCaps) {
  if (agentCaps.has(tag)) return 1.0;
  let bestSim = 0;
  for (const cap of agentCaps) {
    const dist = levenshtein(tag, cap);
    const maxLen = Math.max(tag.length, cap.length);
    if (maxLen === 0) continue;
    const sim = 1 - dist / maxLen;
    if (sim > bestSim) bestSim = sim;
  }
  return bestSim >= 0.7 ? bestSim : 0;
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
      ? taskTags.reduce((sum, t) => sum + fuzzyCapMatch(t, agentCaps), 0) / taskTags.length
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

function acceptTask(swarmRoot, taskId) {
  const task = getTask(swarmRoot, taskId);
  if (!task) return null;
  return updateTask(swarmRoot, taskId, {
    review_status: 'accepted',
    reviewed_at: new Date().toISOString(),
  });
}

function rejectTask(swarmRoot, taskId, reason) {
  const task = getTask(swarmRoot, taskId);
  if (!task) return null;
  return updateTask(swarmRoot, taskId, {
    status: 'open',
    review_status: 'rejected',
    rejection_reason: reason || null,
    assigned_to: null,
    reviewed_at: new Date().toISOString(),
  });
}

function listPendingReview(swarmRoot) {
  return listTasks(swarmRoot).filter(t => t.status === 'done' && t.review_status === 'pending_review');
}

// --- Auto-split heuristic (token + capability aware) ---
//
// Goal: stop one worker swallowing a big multi-deliverable task before the lead
// can break it up and hand parts to the others. A task is a split candidate when
// it either (a) names multiple deliverables (keyword signal) or (b) is large by
// token estimate AND can actually be broken into >=2 real parts.

const SPLIT_SIGNALS = /\b(and|plus|also|with|including|\+|,)\b/gi;
const PAGE_SIGNALS = /\b(page|screen|view|panel|form|dashboard|modal|tab)\b/gi;
const COMPONENT_SIGNALS = /\b(component|module|service|endpoint|api|route|table|section)\b/gi;

// ~4 chars per token — cheap, model-agnostic size estimate.
const BIG_TASK_TOKENS = 120; // ~480 chars of title + description

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// Break a task into candidate part-titles. Tries explicit deliverables first
// (conjunctions/commas), then falls back to sentences/bullets for big blobs.
// Caps at maxParts so we never make more parts than there are workers to take them.
function splitCandidates(title, description, maxParts) {
  maxParts = maxParts && maxParts > 1 ? maxParts : 99;
  const text = `${title || ''}${description ? '. ' + description : ''}`;

  // 1) Explicit deliverables: split on conjunctions / commas / plus.
  let parts = text
    .split(/(?:\band\b|\bplus\b|\balso\b|\bwith\b|\bincluding\b|[,+])/i)
    .map(s => s.trim())
    .filter(s => s.length > 5 && s.length < 200);

  // 2) Fallback for big single-blob tasks: sentences / newlines / bullets.
  if (parts.length < 2) {
    parts = text
      .split(/(?:[.;\n]|(?:^|\s)[-*•]\s)/m)
      .map(s => s.trim())
      .filter(s => s.length > 5 && s.length < 200);
  }

  // De-dupe (case-insensitive), then cap to maxParts.
  const seen = new Set();
  const uniq = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }
  return uniq.slice(0, maxParts);
}

function shouldAutoSplit(title, description) {
  const text = `${title || ''} ${description || ''}`.toLowerCase();
  const splitWords = (text.match(SPLIT_SIGNALS) || []).length;
  const pages = (text.match(PAGE_SIGNALS) || []).length;
  const components = (text.match(COMPONENT_SIGNALS) || []).length;
  const keywordSplit =
    (splitWords >= 2 && (pages >= 2 || components >= 2)) || pages >= 3 || components >= 3;
  if (keywordSplit) return true;
  // Big tasks are split candidates too — but only if they can really be broken up
  // (otherwise we'd flag an unsplittable task and nobody would ever claim it).
  if (estimateTokens(text) >= BIG_TASK_TOKENS && splitCandidates(title, description).length >= 2) {
    return true;
  }
  return false;
}

function autoSplitTask(swarmRoot, taskId, maxParts) {
  const task = getTask(swarmRoot, taskId);
  if (!task) return null;
  const parts = splitCandidates(task.title, task.description, maxParts);
  if (parts.length < 2) return null;
  return splitTask(swarmRoot, taskId, parts.map(p => ({ title: p, priority: task.priority, tags: task.tags })));
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
  // Auto-split
  shouldAutoSplit,
  autoSplitTask,
  splitCandidates,
  estimateTokens,
  // Fuzzy matching
  levenshtein,
  fuzzyCapMatch,
  // Review workflow
  acceptTask,
  rejectTask,
  listPendingReview,
};
