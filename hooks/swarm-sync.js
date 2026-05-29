#!/usr/bin/env node
// swarm — UserPromptSubmit hook
//
// Runs on every user message:
//   1. Read prompt from stdin
//   2. If in swarm repo: git pull, check for new assignments/messages
//   3. Emit hookSpecificOutput with team updates
//
// Pattern follows caveman-mode-tracker.js: read stdin JSON, emit JSON to stdout.

'use strict';

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const prompt = (data.prompt || '').trim();

    const { findSwarmRoot, getAgentId, buildStatusSummary } = require('./swarm-config');
    const path = require('path');

    const swarmRoot = findSwarmRoot();
    if (!swarmRoot) return;

    const agentId = getAgentId();

    // Heartbeat on every prompt
    try {
      const agentRegistry = require(path.join(__dirname, '..', 'lib', 'agent-registry'));
      agentRegistry.heartbeat(swarmRoot, agentId);
    } catch (_) {}

    // Git pull for latest state (non-blocking best-effort)
    try {
      const gitSync = require(path.join(__dirname, '..', 'lib', 'git-sync'));
      if (gitSync.isGitRepo(swarmRoot)) {
        gitSync.pull(swarmRoot, 1); // single attempt, don't block
      }
    } catch (_) {}

    // Build context for this turn
    const contextParts = [];

    // Check unread messages
    try {
      const agentLoop = require(path.join(__dirname, '..', 'lib', 'agent-loop'));
      const pending = agentLoop.getPendingEscalations(swarmRoot, agentId);
      if (pending.length > 0) {
        contextParts.push(`🔔 ${pending.length} ESCALATION(S) NEED YOUR DECISION:`);
        for (const esc of pending.slice(0, 3)) { // max 3 to avoid context bloat
          contextParts.push(agentLoop.formatEscalationForHuman(esc));
        }
      }
    } catch (_) {}

    // Check for tasks assigned to this agent
    try {
      const taskMgr = require(path.join(__dirname, '..', 'lib', 'task-manager'));
      const myTasks = taskMgr.listTasks(swarmRoot, { assignedTo: agentId })
        .filter(t => t.status === 'assigned' || t.status === 'in_progress');
      if (myTasks.length > 0) {
        contextParts.push(`📋 Your active tasks: ${myTasks.map(t => `"${t.title}" (${t.status})`).join(', ')}`);
      }

      // Urgent unassigned
      const urgent = taskMgr.getUrgentUnassigned(swarmRoot);
      if (urgent.length > 0) {
        contextParts.push(`⚡ ${urgent.length} urgent unassigned task(s): ${urgent.map(t => `"${t.title}" (${t.priority})`).join(', ')}`);
      }
    } catch (_) {}

    // Check team health
    try {
      const agentRegistry = require(path.join(__dirname, '..', 'lib', 'agent-registry'));
      const health = agentRegistry.healthCheck(swarmRoot);
      if (health.down > 0) {
        const downNames = health.agents
          .filter(a => a.health === 'down')
          .map(a => `${a.name} (${a.status})`);
        contextParts.push(`⚠ ${health.down} agent(s) down: ${downNames.join(', ')}`);
      }
    } catch (_) {}

    // Emit context if we have anything to report
    if (contextParts.length > 0) {
      const summary = buildStatusSummary(swarmRoot);
      const fullContext = (summary ? summary + '\n\n' : '') + contextParts.join('\n\n');

      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: fullContext,
        },
      }));
    }
  } catch (e) {
    // Silent fail
  }
});
