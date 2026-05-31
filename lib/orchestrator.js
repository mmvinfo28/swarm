'use strict';

// Orchestrator — the delegation brain.
//
// The lead agent distributes open tasks to the best-matched active agents and
// sends each assignee an actionable work prompt (task_assignment message).
// Single source of truth: adapters (via orchestrator-cli.js) and the Claude
// sync hook both call distribute() here.

const taskManager = require('./task-manager');
const agentRegistry = require('./agent-registry');
const hierarchy = require('./hierarchy');
const messageBus = require('./message-bus');

const PRIORITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };
const ACTIVE_STATUSES = ['idle', 'working', 'reviewing'];

/**
 * Build an actionable prompt for an assigned task.
 */
function buildAssignmentPrompt(task) {
  const parts = [];
  parts.push(`You are assigned task "${task.title}" (priority: ${task.priority || 'medium'}).`);
  if (task.description) parts.push(`Description: ${task.description}`);
  if (Array.isArray(task.tags) && task.tags.length) parts.push(`Tags: ${task.tags.join(', ')}.`);
  parts.push(
    'Produce real, complete output for this task — actual code, analysis, or findings. ' +
    'When finished, mark it done with the actual result, not a placeholder.'
  );
  return parts.join(' ');
}

/**
 * Ensure a lead exists. Elects one if missing. Returns the lead agent id (or null).
 */
function ensureLead(swarmRoot) {
  const h = hierarchy.getHierarchy(swarmRoot);
  if (h && h.lead) {
    // Verify the lead is still a registered, non-offline agent.
    const leadAgent = agentRegistry.getAgent(swarmRoot, h.lead);
    if (leadAgent && leadAgent.status !== 'offline') return h.lead;
  }
  const elected = hierarchy.autoElectLead(swarmRoot);
  return elected ? elected.id : null;
}

/**
 * Tasks this agent should be working on right now.
 */
function assignmentsFor(swarmRoot, agentId) {
  return taskManager.listTasks(swarmRoot, { assignedTo: agentId })
    .filter(t => t.status === 'assigned' || t.status === 'in_progress');
}

/**
 * Distribute open tasks to best-matched active agents.
 * Lead-only unless opts.force. Returns { ok, reason?, assignments:[...] }.
 *
 * opts:
 *   force       — skip the lead check
 *   excludeLead — don't assign tasks to the lead itself (default false)
 */
function distribute(swarmRoot, leadId, opts) {
  opts = opts || {};

  if (!opts.force && !hierarchy.isLead(swarmRoot, leadId)) {
    return { ok: false, reason: 'not_lead', assignments: [] };
  }

  let agents = agentRegistry.listAgents(swarmRoot)
    .filter(a => ACTIVE_STATUSES.includes(a.status));
  if (opts.excludeLead) agents = agents.filter(a => a.id !== leadId);
  if (agents.length === 0) return { ok: true, assignments: [], reason: 'no_active_agents' };

  let open = taskManager.listTasks(swarmRoot, { status: 'open' })
    .filter(t => !taskManager.isTaskBlocked(swarmRoot, t.id));
  open.sort((a, b) => (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0));

  const assignments = [];
  for (const task of open) {
    // findBestAgentForTask reads live task counts from disk each call, and
    // assignTask (below) writes status 'assigned', so per-agent load stays
    // correct across this loop without us tracking it manually.
    const best = taskManager.findBestAgentForTask(swarmRoot, task, agents);
    if (!best) continue; // every candidate at capacity

    taskManager.assignTask(swarmRoot, task.id, best.id);
    messageBus.assignWork(swarmRoot, leadId, best.id, task.id, buildAssignmentPrompt(task));

    assignments.push({
      taskId: task.id,
      title: task.title,
      agentId: best.id,
      agentName: best.name,
      score: Number((best._score || 0).toFixed(3)),
    });
  }

  return { ok: true, assignments };
}

/**
 * Convenience: ensure a lead, then distribute if `agentId` is (or becomes) the lead.
 * Used by the sync hook for hands-off auto-distribution.
 */
function autoDistribute(swarmRoot, agentId) {
  const leadId = ensureLead(swarmRoot);
  if (!leadId || leadId !== agentId) {
    return { ok: false, reason: 'not_lead', leadId, assignments: [] };
  }
  return distribute(swarmRoot, leadId);
}

module.exports = {
  PRIORITY_ORDER,
  buildAssignmentPrompt,
  ensureLead,
  assignmentsFor,
  distribute,
  autoDistribute,
};
