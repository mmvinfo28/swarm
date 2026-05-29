'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('./yaml');
const gitSync = require('./git-sync');
const agentRegistry = require('./agent-registry');
const taskManager = require('./task-manager');
const messageBus = require('./message-bus');
const hierarchy = require('./hierarchy');

// --- Escalation Detection ---

const ESCALATION_TRIGGERS = {
  DECISION_NEEDED: 'decision_needed',
  SECURITY_ISSUE: 'security_issue',
  SCOPE_CHANGE: 'scope_change',
  CONFLICT: 'conflict',
  BUDGET_RISK: 'budget_risk',
  UNCERTAIN: 'uncertain',
};

const DECISION_KEYWORDS = [
  'should we', 'which one', 'or should', 'what approach',
  'tradeoff', 'trade-off', 'alternative', 'vs', 'versus',
  'not sure', 'uncertain', 'depends on', 'risky',
  'breaking change', 'migration', 'delete', 'remove all',
  'security', 'vulnerability', 'exploit', 'injection',
  'budget', 'cost', 'pricing', 'payment',
  'deadline', 'delay', 'blocked by external',
];

const AUTO_SAFE_TYPES = [
  'status_update', 'knowledge_share', 'auto_reply',
];

function detectEscalation(message, context) {
  const content = (message.content || '').toLowerCase();
  const reasons = [];

  // Hard decision patterns
  for (const kw of DECISION_KEYWORDS) {
    if (content.includes(kw)) {
      reasons.push({ trigger: ESCALATION_TRIGGERS.DECISION_NEEDED, keyword: kw });
      break;
    }
  }

  // Security mentions
  if (/secur|vulnerab|exploit|inject|xss|csrf|auth.?bypass/i.test(content)) {
    reasons.push({ trigger: ESCALATION_TRIGGERS.SECURITY_ISSUE });
  }

  // Scope changes
  if (/scope|requirement.?change|pivot|redesign|rewrite|start over/i.test(content)) {
    reasons.push({ trigger: ESCALATION_TRIGGERS.SCOPE_CHANGE });
  }

  // Agent conflict (two agents disagree)
  if (context && context.disagreement) {
    reasons.push({ trigger: ESCALATION_TRIGGERS.CONFLICT });
  }

  return {
    shouldEscalate: reasons.length > 0,
    reasons,
    severity: reasons.some(r => r.trigger === ESCALATION_TRIGGERS.SECURITY_ISSUE) ? 'high'
      : reasons.some(r => r.trigger === ESCALATION_TRIGGERS.SCOPE_CHANGE) ? 'high'
      : reasons.length > 1 ? 'medium'
      : 'low',
  };
}

// --- Escalation Queue ---

function escalationPath(swarmRoot) {
  return path.join(swarmRoot, '.swarm', 'escalations');
}

function createEscalation(swarmRoot, agentId, message, escalationInfo, suggestion) {
  const dir = escalationPath(swarmRoot);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const id = require('crypto').randomUUID();
  const escalation = {
    id,
    agent_id: agentId,
    message_id: message.id,
    message_from: message.from,
    message_content: message.content,
    type: escalationInfo.reasons.map(r => r.trigger),
    severity: escalationInfo.severity,
    suggestion: suggestion || null,
    status: 'pending',
    created_at: new Date().toISOString(),
    resolved_at: null,
    resolution: null,
    resolved_by: null,
  };

  fs.writeFileSync(
    path.join(dir, `esc-${id}.yaml`),
    yaml.serialize(escalation) + '\n', 'utf-8'
  );
  return escalation;
}

function resolveEscalation(swarmRoot, escalationId, resolution, resolvedBy) {
  const dir = escalationPath(swarmRoot);
  const filePath = path.join(dir, `esc-${escalationId}.yaml`);
  if (!fs.existsSync(filePath)) return null;

  const esc = yaml.parse(fs.readFileSync(filePath, 'utf-8'));
  esc.status = 'resolved';
  esc.resolution = resolution;
  esc.resolved_by = resolvedBy || 'human';
  esc.resolved_at = new Date().toISOString();
  fs.writeFileSync(filePath, yaml.serialize(esc) + '\n', 'utf-8');
  return esc;
}

function getPendingEscalations(swarmRoot, agentId) {
  const dir = escalationPath(swarmRoot);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.startsWith('esc-') && f.endsWith('.yaml'))
    .map(f => yaml.parse(fs.readFileSync(path.join(dir, f), 'utf-8')))
    .filter(e => e && e.status === 'pending' && (!agentId || e.agent_id === agentId));
}

function getResolvedEscalations(swarmRoot, since) {
  const dir = escalationPath(swarmRoot);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.startsWith('esc-') && f.endsWith('.yaml'))
    .map(f => yaml.parse(fs.readFileSync(path.join(dir, f), 'utf-8')))
    .filter(e => {
      if (!e || e.status !== 'resolved') return false;
      if (since && new Date(e.resolved_at).getTime() <= new Date(since).getTime()) return false;
      return true;
    });
}

// --- Sync cursor (track last processed timestamp per agent) ---

function cursorPath(swarmRoot, agentId) {
  return path.join(swarmRoot, '.swarm', 'agents', `cursor-${agentId}.yaml`);
}

function getLastProcessed(swarmRoot, agentId) {
  const fp = cursorPath(swarmRoot, agentId);
  if (!fs.existsSync(fp)) return null;
  const data = yaml.parse(fs.readFileSync(fp, 'utf-8'));
  return data ? data.last_processed : null;
}

function setLastProcessed(swarmRoot, agentId, timestamp) {
  const fp = cursorPath(swarmRoot, agentId);
  fs.writeFileSync(fp, yaml.serialize({
    agent_id: agentId,
    last_processed: timestamp,
  }) + '\n', 'utf-8');
}

// --- Agent Brain: Process one sync cycle ---

function processInbox(swarmRoot, agentId, respondFn) {
  const agent = agentRegistry.getAgent(swarmRoot, agentId);
  if (!agent) return { error: 'agent not found' };

  const lastProcessed = getLastProcessed(swarmRoot, agentId);
  const unreadMsgs = messageBus.getMessages(swarmRoot, {
    since: lastProcessed,
    forAgent: agentId,
  }).filter(m => m.from !== agentId);

  const actions = [];

  // 1. Check resolved escalations — apply human decisions
  const resolvedEscs = getResolvedEscalations(swarmRoot, agent.last_seen);
  for (const esc of resolvedEscs) {
    if (esc.agent_id === agentId) {
      actions.push({
        type: 'apply_human_decision',
        escalation: esc,
        resolution: esc.resolution,
      });
      // Auto-reply with human decision
      messageBus.sendAutoReply(swarmRoot, agentId, {
        id: esc.message_id,
        from: esc.message_from,
      }, `Human decided: ${esc.resolution}`);
    }
  }

  // 2. Process unread messages (only new ones since last cursor)
  for (const msg of unreadMsgs) {
    if (AUTO_SAFE_TYPES.includes(msg.type)) continue;

    const escalation = detectEscalation(msg, null);

    if (escalation.shouldEscalate) {
      // Generate suggestion but don't auto-act
      const suggestion = respondFn
        ? respondFn(msg, agent, 'suggest')
        : null;

      const esc = createEscalation(swarmRoot, agentId, msg, escalation, suggestion);
      actions.push({
        type: 'escalated',
        messageId: msg.id,
        escalationId: esc.id,
        severity: escalation.severity,
        reasons: escalation.reasons.map(r => r.trigger),
      });
    } else {
      // Safe to auto-reply
      if (respondFn) {
        const reply = respondFn(msg, agent, 'reply');
        if (reply) {
          messageBus.sendAutoReply(swarmRoot, agentId, msg, reply);
          actions.push({ type: 'auto_replied', messageId: msg.id, reply });
        }
      }
    }
  }

  // 3. Check team health — failover if needed
  const health = agentRegistry.healthCheck(swarmRoot);
  const downAgents = health.agents.filter(a => a.health === 'down' && a.id !== agentId);
  for (const downAgent of downAgents) {
    if (downAgent.orphaned_tasks > 0 && hierarchy.isLead(swarmRoot, agentId)) {
      const reassigned = agentRegistry.reassignOrphanedTasks(swarmRoot, downAgent.id);
      if (reassigned.length > 0) {
        messageBus.broadcast(swarmRoot, agentId, messageBus.MSG_TYPES.STATUS_UPDATE,
          `${downAgent.name} is down. Reassigned ${reassigned.length} tasks.`);
        actions.push({ type: 'failover', downAgent: downAgent.id, reassigned });
      }
    }
  }

  // 4. Check for urgent unassigned tasks
  const urgent = taskManager.getUrgentUnassigned(swarmRoot);
  if (urgent.length > 0 && agent.status === 'idle') {
    const best = urgent[0];
    actions.push({
      type: 'suggest_claim',
      taskId: best.id,
      title: best.title,
      priority: best.priority,
    });
  }

  // 5. Check preemption for critical tasks
  if (agent.current_task) {
    for (const critTask of urgent) {
      const preempt = taskManager.shouldPreempt(swarmRoot, agentId, critTask.id);
      if (preempt.preempt) {
        actions.push({
          type: 'preemption_suggested',
          currentTask: preempt.pauseTask,
          criticalTask: preempt.startTask,
          reason: preempt.reason,
        });
        break;
      }
    }
  }

  // 6. Heartbeat + save cursor
  agentRegistry.heartbeat(swarmRoot, agentId);
  setLastProcessed(swarmRoot, agentId, new Date().toISOString());

  return {
    agent: agent.name,
    actions,
    health: { healthy: health.healthy, down: health.down },
    pending_escalations: getPendingEscalations(swarmRoot, agentId).length,
  };
}

// --- Full Sync Cycle ---

function syncCycle(swarmRoot, agentId, respondFn) {
  // Step 1: Pull latest
  const pullResult = gitSync.pull(swarmRoot);
  if (!pullResult.ok) {
    return { ok: false, phase: 'pull', error: pullResult.error };
  }

  // Step 2: Process inbox + auto-actions
  const result = processInbox(swarmRoot, agentId, respondFn);

  // Step 3: Commit & push if changes made
  if (gitSync.hasChanges(swarmRoot)) {
    const syncResult = gitSync.syncAndCommit(
      `swarm: ${agentId.slice(0, 8)} sync cycle`,
      swarmRoot
    );
    if (!syncResult.ok && !syncResult.noop) {
      return { ok: false, phase: 'push', error: syncResult.error, result };
    }
  }

  return { ok: true, ...result };
}

// --- Continuous Loop Runner (git-only, original) ---

function startLoop(swarmRoot, agentId, respondFn, opts) {
  opts = opts || {};
  const interval = opts.interval || 15000;
  const onCycle = opts.onCycle || (() => {});
  const onError = opts.onError || ((err) => { console.error('[swarm]', err); });
  const onEscalation = opts.onEscalation || (() => {});

  let running = true;
  let cycleCount = 0;

  function tick() {
    if (!running) return;
    cycleCount++;

    try {
      const result = syncCycle(swarmRoot, agentId, respondFn);
      onCycle(result, cycleCount);

      if (result.actions) {
        const escalations = result.actions.filter(a => a.type === 'escalated');
        for (const esc of escalations) {
          onEscalation(esc);
        }
      }
    } catch (err) {
      onError(err);
    }

    if (running) {
      setTimeout(tick, interval);
    }
  }

  setTimeout(tick, 0);

  return {
    stop() { running = false; },
    isRunning() { return running; },
    getCycleCount() { return cycleCount; },
  };
}

// --- Hybrid Loop Runner (WebSocket messages + git state) ---

function startHybridLoop(swarmRoot, agentId, respondFn, opts) {
  opts = opts || {};
  const gitInterval = opts.gitInterval || 30000;
  const onCycle = opts.onCycle || (() => {});
  const onError = opts.onError || ((err) => { console.error('[swarm]', err); });
  const onEscalation = opts.onEscalation || (() => {});
  const onMessage = opts.onMessage || (() => {});

  let running = true;
  let cycleCount = 0;
  let wsBus = null;

  // --- WebSocket layer: instant messages ---
  async function connectWS() {
    try {
      const { RealtimeMessageBus } = require('./realtime-message-bus');
      wsBus = new RealtimeMessageBus({
        agentId,
        name: opts.agentName || agentId.slice(0, 8),
        provider: opts.provider || 'claude-code',
        serverUrl: opts.serverUrl || process.env.SWARM_SERVER_URL,
        port: opts.port,
        token: opts.token || process.env.SWARM_SERVER_TOKEN,
        autoReconnect: true,
      });

      wsBus.onMessage((msg) => {
        const escalation = detectEscalation(msg, null);
        if (escalation.shouldEscalate) {
          const suggestion = respondFn ? respondFn(msg, null, 'suggest') : null;
          const esc = createEscalation(swarmRoot, agentId, msg, escalation, suggestion);
          onEscalation({
            type: 'escalated',
            messageId: msg.id,
            escalationId: esc.id,
            severity: escalation.severity,
            reasons: escalation.reasons.map(r => r.trigger),
          });
        } else if (respondFn) {
          const reply = respondFn(msg, null, 'reply');
          if (reply && wsBus.connected) {
            wsBus.send(msg.from, reply);
          }
        }
        onMessage(msg);
      });

      wsBus.onPresence((event) => {
        onMessage({ type: 'presence', ...event });
      });

      wsBus.onStatus((event) => {
        onMessage({ type: 'status', ...event });
      });

      await wsBus.connect();
      return true;
    } catch (err) {
      onError(new Error('WebSocket connection failed, falling back to git-only: ' + err.message));
      return false;
    }
  }

  // --- Git layer: periodic state sync (tasks, agents, hierarchy) ---
  function gitTick() {
    if (!running) return;
    cycleCount++;

    try {
      // Git pull for state
      const pullResult = gitSync.pull(swarmRoot);
      if (!pullResult.ok) {
        onError(new Error('git pull failed: ' + pullResult.error));
      }

      // Process git-based actions (failover, task rebalancing, escalation resolution)
      const result = processInbox(swarmRoot, agentId, null);

      // Push git state changes
      if (gitSync.hasChanges(swarmRoot)) {
        gitSync.syncAndCommit(`swarm: ${agentId.slice(0, 8)} sync`, swarmRoot);
      }

      onCycle({
        ok: true,
        ...result,
        transport: wsBus && wsBus.connected ? 'hybrid' : 'git-only',
        ws_connected: wsBus ? wsBus.connected : false,
      }, cycleCount);

      // Handle escalations from git layer
      if (result.actions) {
        for (const action of result.actions) {
          if (action.type === 'escalated') onEscalation(action);
        }
      }
    } catch (err) {
      onError(err);
    }

    if (running) {
      setTimeout(gitTick, gitInterval);
    }
  }

  // --- Start both ---
  connectWS().then((wsOk) => {
    if (!wsOk) {
      // Fall back to git-only with faster interval
      onError(new Error('Running in git-only mode (no WebSocket server found)'));
    }
    setTimeout(gitTick, 0);
  });

  return {
    stop() {
      running = false;
      if (wsBus) wsBus.close();
    },
    isRunning() { return running; },
    getCycleCount() { return cycleCount; },
    getWsBus() { return wsBus; },
    isHybrid() { return wsBus && wsBus.connected; },

    // Direct messaging (uses WS if available, falls back to git)
    send(to, content, opts) {
      if (wsBus && wsBus.connected) {
        wsBus.send(to, content, opts);
      } else {
        messageBus.send(swarmRoot, agentId, to, 'chat', content);
      }
    },
    broadcast(content, opts) {
      if (wsBus && wsBus.connected) {
        wsBus.broadcast(content, opts);
      } else {
        messageBus.broadcast(swarmRoot, agentId, 'chat', content);
      }
    },
  };
}

// --- Format escalation for human display ---

function formatEscalationForHuman(escalation) {
  const lines = [];
  const severityIcon = { high: '🔴', medium: '🟡', low: '🟢' };

  lines.push(`${severityIcon[escalation.severity] || '⚪'} ESCALATION (${escalation.severity})`);
  lines.push(`From: agent ${(escalation.message_from || '').slice(0, 8)}`);
  lines.push(`Type: ${(escalation.type || []).join(', ')}`);
  lines.push(`Message: "${escalation.message_content}"`);
  if (escalation.suggestion) {
    lines.push(`AI suggests: ${escalation.suggestion}`);
  }
  lines.push(`ID: ${escalation.id}`);

  return lines.join('\n');
}

function formatCycleReport(result) {
  if (!result.ok) return `Sync failed at ${result.phase}: ${result.error}`;

  const lines = [];
  lines.push(`[${result.agent}] Cycle OK — healthy: ${result.health.healthy}, down: ${result.health.down}`);

  for (const action of (result.actions || [])) {
    switch (action.type) {
      case 'auto_replied':
        lines.push(`  ↩ Auto-replied to ${action.messageId.slice(0, 8)}`);
        break;
      case 'escalated':
        lines.push(`  ⚠ Escalated: ${action.reasons.join(', ')} (${action.severity})`);
        break;
      case 'failover':
        lines.push(`  🔄 Failover: ${action.reassigned.length} tasks from ${action.downAgent.slice(0, 8)}`);
        break;
      case 'suggest_claim':
        lines.push(`  📋 Suggest claim: "${action.title}" (${action.priority})`);
        break;
      case 'preemption_suggested':
        lines.push(`  ⚡ Preemption: ${action.reason}`);
        break;
      case 'apply_human_decision':
        lines.push(`  ✅ Applied human decision: ${action.resolution}`);
        break;
    }
  }

  if (result.pending_escalations > 0) {
    lines.push(`  🔔 ${result.pending_escalations} pending escalation(s) awaiting human`);
  }

  return lines.join('\n');
}

module.exports = {
  // Escalation
  ESCALATION_TRIGGERS,
  detectEscalation,
  createEscalation,
  resolveEscalation,
  getPendingEscalations,
  getResolvedEscalations,
  formatEscalationForHuman,
  // Brain
  processInbox,
  syncCycle,
  // Loop
  startLoop,
  startHybridLoop,
  // Display
  formatCycleReport,
};
