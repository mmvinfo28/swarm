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

// Recursion guard: headless workers (claude -p driver) set this so the spawned
// Claude doesn't re-trigger swarm hooks.
if (process.env.SWARM_DISABLE_HOOKS) process.exit(0);

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

    // If this agent is the lead, auto-distribute open tasks to best-matched agents
    // (sends each assignee an actionable work prompt). Hands-off delegation.
    try {
      const orchestrator = require(path.join(__dirname, '..', 'lib', 'orchestrator'));
      const hierarchy = require(path.join(__dirname, '..', 'lib', 'hierarchy'));
      if (hierarchy.isLead(swarmRoot, agentId)) {
        const res = orchestrator.distribute(swarmRoot, agentId);
        if (res && res.assignments && res.assignments.length > 0) {
          contextParts.push(
            `📤 You (lead) auto-distributed ${res.assignments.length} task(s): ` +
            res.assignments.map(a => `"${a.title}" → ${a.agentName}`).join(', ')
          );
        }
      }
    } catch (_) {}

    // Check escalations
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

    // Surface unread messages + task assignments addressed to this agent.
    // Uses a dedicated cursor flag so it doesn't clobber agent-loop's cursor.
    try {
      const messageBus = require(path.join(__dirname, '..', 'lib', 'message-bus'));
      const { readFlag, safeWriteFlag, claudeDir } = require('./swarm-config');
      const cursorPath = path.join(claudeDir, '.swarm-msg-cursor');
      const since = readFlag(cursorPath);
      const unread = messageBus.getUnread(swarmRoot, agentId, since);
      if (unread.length > 0) {
        const assignments = unread.filter(m => m.type === 'task_assignment');
        const chats = unread.filter(m => m.type !== 'task_assignment');
        if (assignments.length > 0) {
          contextParts.push(
            `📨 ${assignments.length} task assignment(s) for you — claim and do the work:\n` +
            assignments.slice(0, 3).map(m => `  • ${(m.content || '').slice(0, 160)}`).join('\n')
          );
        }
        if (chats.length > 0) {
          contextParts.push(
            `💬 ${chats.length} new message(s):\n` +
            chats.slice(0, 5).map(m => `  • ${(m.content || '').slice(0, 120)}`).join('\n')
          );
        }
        const latest = unread[unread.length - 1];
        if (latest && latest.timestamp) safeWriteFlag(cursorPath, latest.timestamp);
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
