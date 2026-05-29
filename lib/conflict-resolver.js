'use strict';

const gitSync = require('./git-sync');
const taskManager = require('./task-manager');
const agentRegistry = require('./agent-registry');

function detectRace(swarmRoot, taskId, expectedAssignee) {
  const task = taskManager.getTask(swarmRoot, taskId);
  if (!task) return { race: false, error: 'task not found' };
  if (task.assigned_to && task.assigned_to !== expectedAssignee) {
    return { race: true, currentAssignee: task.assigned_to };
  }
  return { race: false };
}

function resolveTaskConflict(swarmRoot, taskId, loserAgentId) {
  const task = taskManager.getTask(swarmRoot, taskId);
  if (!task) return { ok: false, error: 'task not found' };

  if (task.assigned_to === loserAgentId) {
    taskManager.updateTask(swarmRoot, taskId, {
      assigned_to: null,
      status: 'open',
    });
  }

  agentRegistry.updateStatus(swarmRoot, loserAgentId, 'idle', null);

  const nextTask = taskManager.findBestTask(swarmRoot, loserAgentId);
  return {
    ok: true,
    reassigned: false,
    suggestedTask: nextTask ? nextTask.id : null,
  };
}

function handlePushFailure(swarmRoot, agentId, taskId) {
  const pullResult = gitSync.pull(swarmRoot);
  if (!pullResult.ok) {
    return { ok: false, error: 'pull failed: ' + pullResult.error };
  }

  if (taskId) {
    const raceCheck = detectRace(swarmRoot, taskId, agentId);
    if (raceCheck.race) {
      const resolution = resolveTaskConflict(swarmRoot, taskId, agentId);
      return {
        ok: true,
        raceDetected: true,
        resolution,
      };
    }
  }

  const pushResult = gitSync.push(swarmRoot);
  return {
    ok: pushResult.ok,
    raceDetected: false,
    error: pushResult.ok ? null : pushResult.error,
  };
}

function safeClaimAndPush(swarmRoot, taskId, agentId) {
  const pullResult = gitSync.pull(swarmRoot);
  if (!pullResult.ok) return { ok: false, error: 'pull failed: ' + pullResult.error };

  const task = taskManager.getTask(swarmRoot, taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (task.assigned_to && task.assigned_to !== agentId) {
    return { ok: false, error: 'task already claimed', claimedBy: task.assigned_to };
  }

  const claimResult = taskManager.claimTask(swarmRoot, taskId, agentId);
  if (!claimResult.ok) return claimResult;

  agentRegistry.updateStatus(swarmRoot, agentId, 'working', taskId);

  const syncResult = gitSync.syncAndCommit(
    `swarm: ${agentId.slice(0, 8)} claims task ${taskId.slice(0, 8)}`,
    swarmRoot
  );

  if (!syncResult.ok) {
    return handlePushFailure(swarmRoot, agentId, taskId);
  }

  return { ok: true, task: claimResult.task };
}

function safeCompleteAndPush(swarmRoot, taskId, agentId, result, filesChanged) {
  taskManager.completeTask(swarmRoot, taskId, result, filesChanged);
  agentRegistry.updateStatus(swarmRoot, agentId, 'idle', null);

  const syncResult = gitSync.syncAndCommit(
    `swarm: ${agentId.slice(0, 8)} completed task ${taskId.slice(0, 8)}`,
    swarmRoot
  );

  if (!syncResult.ok) {
    return handlePushFailure(swarmRoot, agentId, null);
  }

  return { ok: true };
}

module.exports = {
  detectRace,
  resolveTaskConflict,
  handlePushFailure,
  safeClaimAndPush,
  safeCompleteAndPush,
};
