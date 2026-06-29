'use strict';

// message-bus — the flat .swarm/messages/ store.
//
// ARCHITECTURE (read before "merging" this with io-bus): io-bus is the AUTHORITATIVE
// per-agent transport (inbox/outbox + common room). Every delivered message is mirrored
// here by io-bus as a single, append-only, one-file-per-message log. `messages/` is a
// DERIVED read model that exists specifically for cursored, read-only consumers:
//   • hooks/swarm-sync.js — surfaces unread DMs/assignments to the interactive agent,
//     tracking its own cursor over this flat log (cheap, no inbox-processing semantics);
//   • dashboard/index.js  — the legacy TUI message panel.
// The live web dashboard reads io-bus directly (recentFlow). Do NOT add a second writer
// or a competing store; the only writer is io-bus's mirror (io-bus.deliver / postRoom).
//
// Phase 2 consolidation removed the old "auto-communication protocol" helpers
// (assignWork/sendAutoReply/requestHelp/shareKnowledge/notify*/buildAgentContext/…) —
// they were leftovers from the retired agent-loop sync engine with zero callers.

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

// Message type vocabulary shared by orchestrator / swarm-cli / runner.
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

module.exports = {
  send,
  broadcast,
  getMessages,
  getUnread,
  MSG_TYPES,
};
