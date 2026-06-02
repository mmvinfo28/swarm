'use strict';

// io-bus — per-agent inbox/outbox message queues.
//
// Layout:
//   .swarm/io/<agentId>/inbox/<ts>-<from8>.yaml        unprocessed messages TO this agent
//   .swarm/io/<agentId>/inbox/processed/<ts>-...        after the agent handles them
//   .swarm/io/<agentId>/outbox/<ts>-<to8>.yaml          what this agent produced/sent
//
// Every delivered message is ALSO mirrored into the flat .swarm/messages/ via
// message-bus.send, so the existing dashboard message panel + git history keep working.
// One file per message = conflict-free.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('./yaml');
const messageBus = require('./message-bus');

function ioRoot(root) { return path.join(root, '.swarm', 'io'); }
function inboxDir(root, id) { return path.join(ioRoot(root), id, 'inbox'); }
function processedDir(root, id) { return path.join(inboxDir(root, id), 'processed'); }
function outboxDir(root, id) { return path.join(ioRoot(root), id, 'outbox'); }

function ensure(dir) { fs.mkdirSync(dir, { recursive: true }); }
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function makeMsg(input) {
  return {
    id: input.id || crypto.randomUUID(),
    from: input.from || 'human',
    to: input.to,
    type: input.type || 'chat',
    content: input.content || '',
    references: input.refs || input.references || null,
    timestamp: input.timestamp || new Date().toISOString(),
  };
}

/**
 * Deliver a message into one agent's inbox (+ mirror to messages/).
 */
function deliver(root, toId, input) {
  const msg = makeMsg(Object.assign({}, input, { to: toId }));
  const dir = inboxDir(root, toId);
  ensure(dir);
  const short = (msg.from || 'x').slice(0, 8);
  fs.writeFileSync(path.join(dir, `${stamp()}-${short}.yaml`), yaml.serialize(msg) + '\n', 'utf-8');

  // Mirror to flat messages/ for dashboard + history (best-effort).
  try { messageBus.send(root, msg.from, toId, msg.type, msg.content, msg.references); } catch (_) {}

  // Also record in sender's outbox for audit / panel feed.
  if (msg.from && msg.from !== 'human') {
    try { writeOutbox(root, msg.from, msg); } catch (_) {}
  }
  return msg;
}

/**
 * Deliver to every agent's inbox except the sender. Used for broadcasts.
 */
function deliverBroadcast(root, fromId, input, agentIds) {
  const ids = agentIds || listAgentIds(root);
  const delivered = [];
  for (const id of ids) {
    if (id === fromId) continue;
    delivered.push(deliver(root, id, Object.assign({}, input, { from: fromId, to: 'broadcast' })));
  }
  // Mirror a single broadcast row too.
  try { messageBus.broadcast(root, fromId, input.type || 'chat', input.content || '', input.refs); } catch (_) {}
  return delivered;
}

function listAgentIds(root) {
  const adir = path.join(root, '.swarm', 'agents');
  if (!fs.existsSync(adir)) return [];
  return fs.readdirSync(adir)
    .filter(f => f.startsWith('agent-') && f.endsWith('.yaml'))
    .map(f => f.slice('agent-'.length, -'.yaml'.length));
}

/**
 * Unprocessed inbox messages for an agent, oldest first.
 */
function readInbox(root, id) {
  const dir = inboxDir(root, id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.yaml'))
    .sort()
    .map(f => {
      try { return Object.assign(yaml.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) || {}, { _file: f }); }
      catch (_) { return null; }
    })
    .filter(Boolean);
}

function inboxCount(root, id) {
  const dir = inboxDir(root, id);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).length;
}

/**
 * Move a handled inbox file into processed/.
 */
function markProcessed(root, id, file) {
  const src = path.join(inboxDir(root, id), file);
  const dstDir = processedDir(root, id);
  ensure(dstDir);
  try { fs.renameSync(src, path.join(dstDir, file)); } catch (_) {}
}

function writeOutbox(root, id, input) {
  const msg = makeMsg(input);
  const dir = outboxDir(root, id);
  ensure(dir);
  const short = (msg.to || 'all').slice(0, 8);
  fs.writeFileSync(path.join(dir, `${stamp()}-${short}.yaml`), yaml.serialize(msg) + '\n', 'utf-8');
  return msg;
}

function readOutbox(root, id, limit) {
  const dir = outboxDir(root, id);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).sort();
  const slice = limit ? files.slice(-limit) : files;
  return slice.map(f => {
    try { return yaml.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch (_) { return null; }
  }).filter(Boolean);
}

/**
 * Recent io across all agents for the control panel flow view.
 */
function recentFlow(root, limit) {
  limit = limit || 40;
  const ids = listAgentIds(root);
  const rows = [];
  for (const id of ids) {
    for (const m of readOutbox(root, id, 20)) rows.push(Object.assign({ box: 'out', agent: id }, m));
    for (const m of readInbox(root, id)) rows.push(Object.assign({ box: 'in', agent: id }, m));
  }
  rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return rows.slice(-limit);
}

module.exports = {
  deliver,
  deliverBroadcast,
  readInbox,
  inboxCount,
  markProcessed,
  writeOutbox,
  readOutbox,
  recentFlow,
  listAgentIds,
};
