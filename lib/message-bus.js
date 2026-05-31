'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('./yaml');

const MESSAGES_DIR = 'messages';

function messagesPath(swarmRoot) {
  return path.join(swarmRoot, '.swarm', MESSAGES_DIR);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function makeFilename(from) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const short = (from || 'unknown').slice(0, 8);
  return `${ts}-${short}.yaml`;
}

function send(swarmRoot, from, to, type, content, refs) {
  const id = crypto.randomUUID();
  const msg = {
    id,
    from,
    to: to || 'broadcast',
    type: type || 'chat',
    content,
    timestamp: new Date().toISOString(),
    references: refs || null,
  };

  const dir = messagesPath(swarmRoot);
  ensureDir(dir);
  const filename = makeFilename(from);
  fs.writeFileSync(path.join(dir, filename), yaml.serialize(msg) + '\n', 'utf-8');
  return msg;
}

function broadcast(swarmRoot, from, type, content, refs) {
  return send(swarmRoot, from, 'broadcast', type, content, refs);
}

function getMessages(swarmRoot, opts) {
  opts = opts || {};
  const dir = messagesPath(swarmRoot);
  if (!fs.existsSync(dir)) return [];

  let files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.yaml'))
    .sort();

  let messages = files.map(f => {
    try {
      return yaml.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    } catch (_) {
      return null;
    }
  }).filter(m => m && m.id);

  if (opts.since) {
    const sinceTime = new Date(opts.since).getTime();
    messages = messages.filter(m => new Date(m.timestamp).getTime() > sinceTime);
  }

  if (opts.forAgent) {
    messages = messages.filter(m =>
      m.to === opts.forAgent || m.to === 'broadcast' || m.from === opts.forAgent
    );
  }

  if (opts.type) {
    messages = messages.filter(m => m.type === opts.type);
  }

  if (opts.limit) {
    messages = messages.slice(-opts.limit);
  }

  return messages;
}

function getUnread(swarmRoot, agentId, lastSyncTime) {
  return getMessages(swarmRoot, {
    since: lastSyncTime,
    forAgent: agentId,
  }).filter(m => m.from !== agentId);
}

function getConversation(swarmRoot, agentA, agentB, limit) {
  return getMessages(swarmRoot).filter(m =>
    (m.from === agentA && m.to === agentB) ||
    (m.from === agentB && m.to === agentA)
  ).slice(-(limit || 50));
}

function countMessages(swarmRoot) {
  const dir = messagesPath(swarmRoot);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).length;
}

function pruneOld(swarmRoot, maxAge) {
  maxAge = maxAge || 24 * 60 * 60 * 1000;
  const dir = messagesPath(swarmRoot);
  if (!fs.existsSync(dir)) return 0;

  const now = Date.now();
  let pruned = 0;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml'));

  for (const f of files) {
    try {
      const msg = yaml.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (msg && msg.timestamp && (now - new Date(msg.timestamp).getTime()) > maxAge) {
        fs.unlinkSync(path.join(dir, f));
        pruned++;
      }
    } catch (_) {}
  }
  return pruned;
}

// --- Auto-communication protocol ---

const MSG_TYPES = {
  CHAT: 'chat',
  AUTO_REPLY: 'auto_reply',
  TASK_NEGOTIATION: 'task_negotiation',
  HELP_REQUEST: 'help_request',
  KNOWLEDGE_SHARE: 'knowledge_share',
  STATUS_UPDATE: 'status_update',
  TASK_HANDOFF: 'task_handoff',
  TASK_ASSIGNMENT: 'task_assignment',
  CREDIT_ALERT: 'credit_alert',
  PRIORITY_CHANGE: 'priority_change',
};

// Actionable message types — when an agent receives one of these addressed to it,
// it should act (not just read). Used by adapters and the sync hook.
const ACTIONABLE_TYPES = [
  MSG_TYPES.TASK_ASSIGNMENT,
  MSG_TYPES.TASK_HANDOFF,
  MSG_TYPES.HELP_REQUEST,
  MSG_TYPES.TASK_NEGOTIATION,
];

/**
 * Assign work to an agent: sends a task_assignment message carrying the
 * actionable prompt. The assignee acts on this on its next cycle.
 */
function assignWork(swarmRoot, from, to, taskId, prompt) {
  return send(swarmRoot, from, to, MSG_TYPES.TASK_ASSIGNMENT, prompt, {
    tasks: [taskId],
  });
}

function sendAutoReply(swarmRoot, from, replyToMsg, content) {
  return send(swarmRoot, from, replyToMsg.from, MSG_TYPES.AUTO_REPLY, content, {
    reply_to: replyToMsg.id,
    tasks: replyToMsg.references ? replyToMsg.references.tasks : [],
  });
}

function requestHelp(swarmRoot, from, taskId, question) {
  return broadcast(swarmRoot, from, MSG_TYPES.HELP_REQUEST, question, {
    tasks: [taskId],
  });
}

function shareKnowledge(swarmRoot, from, to, content, taskRefs) {
  return send(swarmRoot, from, to, MSG_TYPES.KNOWLEDGE_SHARE, content, {
    tasks: taskRefs || [],
  });
}

function notifyTaskHandoff(swarmRoot, from, to, taskId, reason) {
  return send(swarmRoot, from, to, MSG_TYPES.TASK_HANDOFF,
    `Task ${taskId.slice(0, 8)} handed off: ${reason}`, {
    tasks: [taskId],
  });
}

function alertCreditExhaustion(swarmRoot, agentId, orphanedTasks) {
  return broadcast(swarmRoot, agentId, MSG_TYPES.CREDIT_ALERT,
    `Agent ${agentId.slice(0, 8)} out of credits. ${orphanedTasks.length} tasks need reassignment.`, {
    tasks: orphanedTasks,
    agents: [agentId],
  });
}

function notifyPriorityChange(swarmRoot, from, taskId, oldPriority, newPriority, reason) {
  return broadcast(swarmRoot, from, MSG_TYPES.PRIORITY_CHANGE,
    `Task ${taskId.slice(0, 8)}: ${oldPriority} → ${newPriority}. ${reason}`, {
    tasks: [taskId],
  });
}

function getPendingAutoReplies(swarmRoot, agentId) {
  const unread = getUnread(swarmRoot, agentId, null);
  return unread.filter(m =>
    m.to === agentId &&
    [MSG_TYPES.HELP_REQUEST, MSG_TYPES.TASK_NEGOTIATION, MSG_TYPES.TASK_HANDOFF].includes(m.type)
  );
}

function buildAgentContext(swarmRoot, agentId) {
  const unread = getUnread(swarmRoot, agentId, null);
  const pending = getPendingAutoReplies(swarmRoot, agentId);
  const recent = getMessages(swarmRoot, { limit: 10 });

  return {
    unread_count: unread.length,
    pending_replies: pending.length,
    messages: unread,
    pending,
    recent_activity: recent,
    needs_response: pending.length > 0,
  };
}

module.exports = {
  send,
  broadcast,
  getMessages,
  getUnread,
  getConversation,
  countMessages,
  pruneOld,
  // Auto-communication
  MSG_TYPES,
  ACTIONABLE_TYPES,
  assignWork,
  sendAutoReply,
  requestHelp,
  shareKnowledge,
  notifyTaskHandoff,
  alertCreditExhaustion,
  notifyPriorityChange,
  getPendingAutoReplies,
  buildAgentContext,
};
