'use strict';

// agent-loop — escalation engine (queue + detection + human-facing format).
//
// HISTORY: this file used to also host a git-polling sync loop (processInbox /
// syncCycle / startLoop / startHybridLoop). The live worker is runner.js (fast local
// poll + ##SWARM:..## actions via lib/actions.js), which never used those loops, so
// they were removed in Phase 2 consolidation. What remains is the escalation store
// used by actions.js, swarm-cli.js, the swarm-sync hook, the dashboards, and the
// realtime message bus. Filename kept to avoid churning every require() path.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('./yaml');

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

  const id = crypto.randomUUID();
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

module.exports = {
  ESCALATION_TRIGGERS,
  detectEscalation,
  createEscalation,
  resolveEscalation,
  getPendingEscalations,
  getResolvedEscalations,
  formatEscalationForHuman,
};
