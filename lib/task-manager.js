'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('./yaml');
const agentRegistry = require('./agent-registry');

const TASKS_DIR = 'tasks';
const CLAIMS_DIR = 'claims';
// Fallback only — the live value comes from config.yaml via maxTasksPerAgent().
const MAX_TASKS_PER_AGENT = 3;

// Lazily detect whether the swarm is a git repo. In git mode a claim defers writing
// the shared task file (avoids the cross-machine rebase conflict); local-only mode
// materializes immediately. Required lazily so task-manager doesn't hard-depend on git.
let _gitSync = null;
function gitMode(swarmRoot) {
  try {
    if (_gitSync === null) { _gitSync = require('./git-sync'); }
    return !!(_gitSync && _gitSync.isGitRepo(swarmRoot));
  } catch (_) { return false; }
}

// Phase 1.3: honor config.yaml instead of the hardcoded const. Read fresh each call
// (config is tiny and may be edited live from the dashboard / `modify config`).
function maxTasksPerAgent(swarmRoot) {
  try {
    const fp = path.join(swarmRoot, '.swarm', 'config.yaml');
    if (fs.existsSync(fp)) {
      const cfg = yaml.parse(fs.readFileSync(fp, 'utf-8')) || {};
      const v = parseInt(cfg.max_tasks_per_agent, 10);
      if (Number.isFinite(v) && v > 0) return v;
    }
  } catch (_) {}
  return MAX_TASKS_PER_AGENT;
}

// Phase 1.3: git-sync cadence (seconds) from config.yaml, same live-read contract as
// maxTasksPerAgent. The runner uses this to decide how often a tick pulls/pushes git.
// Falls back to DEFAULT_SYNC_INTERVAL when unset or invalid.
const DEFAULT_SYNC_INTERVAL = 30;
function syncIntervalSeconds(swarmRoot) {
  try {
    const fp = path.join(swarmRoot, '.swarm', 'config.yaml');
    if (fs.existsSync(fp)) {
      const cfg = yaml.parse(fs.readFileSync(fp, 'utf-8')) || {};
      const v = parseInt(cfg.sync_interval, 10);
      if (Number.isFinite(v) && v > 0) return v;
    }
  } catch (_) {}
  return DEFAULT_SYNC_INTERVAL;
}

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

// Does this agent hold ANY claim ticket for the task (winner or not)? Used by
// reconcileClaims to tell a deferred loser it lost (it has a ticket but isn't winner).
function agentHasClaimTicket(swarmRoot, taskId, agentId) {
  const dir = claimsPath(swarmRoot);
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some(f =>
    f.startsWith(`claim-${taskId}-${agentId}-`) && f.endsWith('.yaml'));
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
    // Human gave no tags? Infer capability tags from the text so the task still
    // routes to the right worker instead of being grabbed by whoever's free (BUG-2).
    tags: (opts.tags && opts.tags.length) ? opts.tags : inferCaps(`${title || ''} ${description || ''}`),
    dependencies: opts.dependencies || [],
    subtasks: [],
    parent_task: opts.parentTask || null,
    created_at: now,
    updated_at: now,
    result: null,
    // Option B file-ownership: files this task intends to own. While the task is
    // active (assigned/in_progress) no other task may claim an overlapping file.
    files: opts.files || [],
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
  // A deliberate (lead/failover) assignment supersedes any prior claim race — drop
  // stale claim tickets so reconcileClaims can't later revert this assignment.
  pruneClaimsForTask(swarmRoot, taskId);
  return updateTask(swarmRoot, taskId, {
    assigned_to: agentId,
    status: 'assigned',
  });
}

// --- Option B: file-ownership lock -------------------------------------------
// Normalize a file path for overlap comparison (case-insensitive, forward slashes,
// no leading ./). Two tasks "own" the same file if their normalized paths match.
function normFile(f) {
  return String(f || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

// Files currently owned by ACTIVE tasks (assigned/in_progress) other than `exceptId`,
// mapped to the owning task id. Done/open/split tasks don't hold a lock.
function activeFileOwners(swarmRoot, exceptId) {
  const owners = {};
  for (const t of listTasks(swarmRoot)) {
    if (t.id === exceptId) continue;
    if (t.status !== 'assigned' && t.status !== 'in_progress') continue;
    for (const f of (t.files || [])) {
      const k = normFile(f);
      if (k) owners[k] = t.id;
    }
  }
  return owners;
}

// Does `task` want a file already locked by another active task? Returns the
// conflicting {file, taskId} or null. Empty files = no lock (backward compatible).
function fileConflict(swarmRoot, task) {
  const owners = activeFileOwners(swarmRoot, task.id);
  for (const f of (task.files || [])) {
    const k = normFile(f);
    if (k && owners[k]) return { file: f, taskId: owners[k] };
  }
  return null;
}

// Record/extend a task's intended files (called when an agent declares them).
function setTaskFiles(swarmRoot, taskId, files) {
  const task = getTask(swarmRoot, taskId);
  if (!task) return null;
  const merged = Array.from(new Set([...(task.files || []), ...(files || [])].map(f => String(f).trim()).filter(Boolean)));
  return updateTask(swarmRoot, taskId, { files: merged });
}

function claimTask(swarmRoot, taskId, agentId) {
  const task = getTask(swarmRoot, taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (task.status === 'done') return { ok: false, error: 'task already completed' };

  // Option B: refuse a claim whose files are already locked by another active task.
  const conflict = fileConflict(swarmRoot, task);
  if (conflict) {
    return {
      ok: false,
      error: `file locked — "${conflict.file}" is owned by active task ${String(conflict.taskId).slice(0, 8)}. Pick another task or wait.`,
      fileConflict: conflict,
    };
  }

  // Always safe: a claim ticket is a unique file — it never causes a merge conflict.
  createClaimTicket(swarmRoot, taskId, agentId);

  // GIT MODE: do NOT write assigned_to/status onto the shared task file yet. That file
  // is exactly what two racing clones would conflict on. Only the ticket is written;
  // reconcileClaims (after the next pull) materializes the winner onto the task file —
  // convergently, because every machine computes the same earliest-ticket winner. The
  // claim is "pending" until then; a deferred winner can still `done` (callers check
  // getMyActiveClaim), and a deferred loser is released by reconcileClaims.
  if (gitMode(swarmRoot)) {
    const winner = resolveClaimWinner(swarmRoot, taskId);
    return { ok: true, pending: true, won: !!(winner && winner.agent_id === agentId), task: getTask(swarmRoot, taskId) };
  }

  // LOCAL-ONLY (no git): no remote to race, so materialize immediately for an instant claim.
  const winner = resolveClaimWinner(swarmRoot, taskId);
  if (!(winner && winner.agent_id === agentId)) {
    return {
      ok: false,
      error: 'claim lost — ' + (winner ? winner.agent_id : 'unknown') + ' claimed first',
      winner: winner ? winner.agent_id : null,
    };
  }
  const updated = updateTask(swarmRoot, taskId, {
    assigned_to: agentId,
    status: 'in_progress',
  });
  return { ok: true, task: updated, won: true };
}

// Converge every claimed task's assignment to its claim-ticket winner. Run AFTER a
// git pull, on every machine. claimTask optimistically writes the shared task file
// pre-sync, so two machines can each set themselves assigned_to before they see each
// other's tickets. Tickets are conflict-free (one file each) and the winner is the
// earliest ticket — a value every machine computes identically from the same ticket
// set. So this pass is idempotent and convergent: all machines rewrite the task file
// to the SAME winner, and the optimistic-but-losing holder is released.
//
// Returns { released } = tasks `agentId` optimistically held but lost to an earlier
// claim, so the caller can flip the agent back to idle and tell it to pick another.
function reconcileClaims(swarmRoot, agentId) {
  const released = [];
  for (const t of listTasks(swarmRoot)) {
    // Materialize claim-ticket winners onto 'open' (deferred git-mode claim) and
    // 'in_progress' tasks. Lead-`assign`ed tasks are 'assigned' with tickets pruned,
    // so they're skipped — a deliberate assignment is never reverted by a stale ticket.
    if (t.status !== 'open' && t.status !== 'in_progress') continue;
    const winner = resolveClaimWinner(swarmRoot, t.id);
    if (!winner) continue; // no tickets → a plain open task; leave it alone
    // Converge the shared task file to the true winner (identical on every machine).
    if (t.assigned_to !== winner.agent_id || t.status !== 'in_progress') {
      updateTask(swarmRoot, t.id, { assigned_to: winner.agent_id, status: 'in_progress' });
    }
    // Did I claim this task but lose? (I hold a ticket, but I'm not the winner.)
    if (winner.agent_id !== agentId && agentHasClaimTicket(swarmRoot, t.id, agentId)) {
      released.push({ taskId: t.id, title: t.title, winner: winner.agent_id });
    }
  }
  return released;
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
    // Don't offer a task whose dependencies aren't done yet (Phase 3.1 — pipelines).
    .filter(t => !isTaskBlocked(swarmRoot, t.id))
    .filter(t => !(multipleAgents && shouldAutoSplit(t.title, t.description)));
  if (openTasks.length === 0) return null;

  const agentCaps = new Set(agent.capabilities || []);
  const maxTasks = maxTasksPerAgent(swarmRoot);
  const activeCount = listTasks(swarmRoot, { assignedTo: agentId })
    .filter(t => t.status === 'in_progress' || t.status === 'assigned')
    .length;

  if (activeCount >= maxTasks) return null;

  const priorityWeight = { critical: 1.0, high: 0.75, medium: 0.5, low: 0.25 };

  const scored = openTasks.map(task => {
    const taskTags = task.tags || [];
    const capMatch = taskTags.length > 0
      ? taskTags.reduce((sum, t) => sum + fuzzyCapMatch(t, agentCaps), 0) / taskTags.length
      : 0.5;
    const loadBalance = 1 - (activeCount / maxTasks);
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

// Phase 3.1 — open tasks that listed `completedTaskId` as a dependency and are now
// fully unblocked (all deps done). Used after a `done` to wake up the next pipeline
// stage and redistribute it.
function getNewlyUnblocked(swarmRoot, completedTaskId) {
  return listTasks(swarmRoot, { status: 'open' }).filter(t =>
    Array.isArray(t.dependencies) &&
    t.dependencies.includes(completedTaskId) &&
    !isTaskBlocked(swarmRoot, t.id)
  );
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
  const maxTasks = maxTasksPerAgent(swarmRoot);

  for (const agent of agents) {
    const agentCaps = new Set(agent.capabilities || []);
    const activeCount = listTasks(swarmRoot, { assignedTo: agent.id })
      .filter(t => t.status === 'in_progress' || t.status === 'assigned')
      .length;

    if (activeCount >= maxTasks) continue;

    const capMatch = taskTags.length > 0
      ? taskTags.reduce((sum, t) => sum + fuzzyCapMatch(t, agentCaps), 0) / taskTags.length
      : 0.5;
    const loadBalance = 1 - (activeCount / maxTasks);
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
  // Reopening clears the prior claim — drop tickets so a re-claim races cleanly.
  pruneClaimsForTask(swarmRoot, taskId);
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

// ~4 chars per token — cheap, model-agnostic size estimate.
const MIN_SPLIT_TOKENS = 12; // ~48 chars — below this a task is too small to bother splitting

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// A real deliverable part = >=2 words and at least one "content" word (len>=4).
// Filters dangling fragments like "implement" or "a modern" that are NOT separate
// deliverables but pieces of one (BUG-2: one webpage shredded into fake subtasks).
function isRealDeliverable(s) {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  return words.some(w => w.replace(/[^a-z0-9]/gi, '').length >= 4);
}

// Break a task into candidate part-titles. Splits ONLY on delimiters that join
// genuinely separate deliverables: "and", ",", "+", "plus". NOT on "also"/"with"/
// "including" — those introduce modifiers of ONE deliverable ("a page WITH links",
// "a form ALSO validated"), and splitting on them shredded single deliverables
// across two agents (BUG-2). Falls back to sentences/bullets for big blobs.
// Caps at maxParts so we never make more parts than there are workers to take them.
function splitCandidates(title, description, maxParts) {
  maxParts = maxParts && maxParts > 1 ? maxParts : 99;
  const text = `${title || ''}${description ? '. ' + description : ''}`;

  // 1) Explicit separate deliverables: conjunctions / commas / plus.
  let parts = text
    .split(/(?:\band\b|\bplus\b|[,+])/i)
    .map(s => s.trim())
    .filter(s => s.length > 5 && s.length < 200 && isRealDeliverable(s));

  // 2) Fallback for big single-blob tasks: sentences / newlines / bullets.
  if (parts.length < 2) {
    parts = text
      .split(/(?:[.;\n]|(?:^|\s)[-*•]\s)/m)
      .map(s => s.trim())
      .filter(s => s.length > 5 && s.length < 200 && isRealDeliverable(s));
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

// Infer capability tags from a task/part's text so subtasks route to the right
// worker even when the human gave no tags (BUG-2: split parts had empty tags → no
// cap routing → lead grabbed everything). Keyword → capability.
const CAP_KEYWORDS = {
  frontend: ['page', 'webpage', 'ui', 'html', 'css', 'button', 'form', 'style', 'component', 'visual', 'graph', 'chart', 'layout', 'react', 'vue', 'frontend', 'website', 'web'],
  backend: ['server', 'database', 'db', 'auth', 'backend', 'queue', 'worker', 'cache', 'migration', 'model', 'service'],
  api: ['api', 'endpoint', 'rest', 'graphql', 'route', 'webhook', 'integration'],
  testing: ['test', 'tests', 'testing', 'qa', 'verify', 'coverage', 'e2e', 'unit'],
};
function inferCaps(text) {
  const t = String(text || '').toLowerCase();
  const caps = [];
  for (const [cap, kws] of Object.entries(CAP_KEYWORDS)) {
    if (kws.some(kw => new RegExp(`\\b${kw}\\b`).test(t))) caps.push(cap);
  }
  return caps;
}

// A task is splittable when it actually breaks into >=2 real deliverable parts
// (conjunctions / commas / sentences / bullets) and isn't trivially short. This is
// deliberately aggressive — "page and API", "X, Y and Z", multi-sentence specs all
// split — so one agent can't swallow a multi-part job. Truly atomic one-liners
// (single clause) yield <2 parts and stay whole, avoiding a no-claimer deadlock.
function shouldAutoSplit(title, description) {
  if (estimateTokens(`${title || ''} ${description || ''}`) < MIN_SPLIT_TOKENS) return false;
  return splitCandidates(title, description).length >= 2;
}

function autoSplitTask(swarmRoot, taskId, maxParts) {
  const task = getTask(swarmRoot, taskId);
  if (!task) return null;
  const parts = splitCandidates(task.title, task.description, maxParts);
  if (parts.length < 2) return null;
  // Each subtask carries its own acceptance criteria so the assignee knows "done".
  // (Heuristic scaffold — the lead can refine via an explicit SPLIT.)
  return splitTask(swarmRoot, taskId, parts.map(p => ({
    title: p,
    description: `Part of "${task.title}".` +
      (task.description ? ` Context: ${task.description}.` : '') +
      ` Acceptance: implement this part end-to-end, verify it works, and report what you produced.`,
    priority: task.priority,
    // Carry the parent's tags + caps inferred from THIS part's text, so each
    // subtask routes to a worker with the right capability (BUG-2 cap routing).
    tags: Array.from(new Set([...(task.tags || []), ...inferCaps(p)])),
  })));
}

module.exports = {
  createTask,
  getTask,
  updateTask,
  assignTask,
  claimTask,
  reconcileClaims,
  completeTask,
  splitTask,
  listTasks,
  findBestTask,
  getTasksByParent,
  isTaskBlocked,
  getNewlyUnblocked,
  getStats,
  // Option B file-ownership lock
  setTaskFiles,
  fileConflict,
  activeFileOwners,
  inferCaps,
  // Claim tickets
  createClaimTicket,
  resolveClaimWinner,
  syncIntervalSeconds,
  getMyActiveClaim,
  agentHasClaimTicket,
  pruneClaimsForTask,
  // Dynamic prioritization
  PRIORITY_ORDER,
  escalatePriority,
  shouldPreempt,
  preemptAndReassign,
  rebalanceTasks,
  findBestAgentForTask,
  getUrgentUnassigned,
  // Config
  maxTasksPerAgent,
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
