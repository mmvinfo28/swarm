'use strict';

const { RealtimeClient, SwarmRealtimeServer } = require('./realtime');
const messageBus = require('./message-bus');

/**
 * Realtime Message Bus
 *
 * Persistent WebSocket connection for instant agent messaging.
 * Integrates with message-bus.js MSG_TYPES and auto-communication protocol.
 *
 * Usage:
 *   const bus = new RealtimeMessageBus({ agentId, name, serverUrl });
 *   await bus.connect();
 *   bus.send('agent-uuid', 'Hello');
 *   bus.onMessage((msg) => { ... });
 *   bus.close();
 */
class RealtimeMessageBus {
  constructor(opts) {
    opts = opts || {};
    this._client = new RealtimeClient({
      agentId: opts.agentId,
      name: opts.name,
      provider: opts.provider || 'claude-code',
      serverUrl: opts.serverUrl,
      port: opts.port,
      token: opts.token,
      rooms: opts.rooms || ['general'],
    });
    this._agentId = opts.agentId;
    this._connected = false;
    this._handlers = [];
    this._escalationHandler = null;
    this._reconnectTimer = null;
    this._reconnectDelay = opts.reconnectDelay || 3000;
    this._autoReconnect = opts.autoReconnect !== false;
    this._serverUrl = opts.serverUrl;
    this._opts = opts;
  }

  async connect() {
    await this._client.connect();
    this._connected = true;

    // Route incoming messages
    this._client.on('agent.message', (msg) => this._handleIncoming(msg));
    this._client.on('command', (msg) => this._handleIncoming(msg));
    this._client.on('agent.presence', (msg) => this._emit('presence', msg));
    this._client.on('agent.status', (msg) => this._emit('status', msg));

    // Auto-reconnect
    this._client.on('close', () => {
      this._connected = false;
      if (this._autoReconnect) this._scheduleReconnect();
    });

    this._client.on('error', () => {
      this._connected = false;
      if (this._autoReconnect) this._scheduleReconnect();
    });

    return { ok: true };
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        this._client = new RealtimeClient({
          agentId: this._opts.agentId,
          name: this._opts.name,
          provider: this._opts.provider || 'claude-code',
          serverUrl: this._serverUrl,
          port: this._opts.port,
          token: this._opts.token,
          rooms: this._opts.rooms || ['general'],
        });
        await this.connect();
      } catch (_) {
        if (this._autoReconnect) this._scheduleReconnect();
      }
    }, this._reconnectDelay);
  }

  // --- Send methods (use MSG_TYPES from message-bus) ---

  send(to, content, opts) {
    opts = opts || {};
    this._client.message(to, content, {
      room: opts.room || 'general',
      refs: opts.refs || null,
    });
  }

  broadcast(content, opts) {
    opts = opts || {};
    this._client.broadcast(content, {
      room: opts.room || 'general',
      refs: opts.refs || null,
    });
  }

  requestHelp(taskId, question) {
    this._client.send('agent.message', {
      from: this._agentId,
      to: 'broadcast',
      content: question,
      room: 'general',
      refs: { tasks: [taskId], type: messageBus.MSG_TYPES.HELP_REQUEST },
    });
  }

  shareKnowledge(to, content, taskRefs) {
    this.send(to, content, {
      refs: { tasks: taskRefs || [], type: messageBus.MSG_TYPES.KNOWLEDGE_SHARE },
    });
  }

  notifyTaskHandoff(to, taskId, reason) {
    this.send(to, `Task ${taskId.slice(0, 8)} handed off: ${reason}`, {
      refs: { tasks: [taskId], type: messageBus.MSG_TYPES.TASK_HANDOFF },
    });
  }

  alertCreditExhaustion(orphanedTasks) {
    this.broadcast(
      `Agent ${this._agentId.slice(0, 8)} out of credits. ${orphanedTasks.length} tasks need reassignment.`,
      { refs: { tasks: orphanedTasks, type: messageBus.MSG_TYPES.CREDIT_ALERT } }
    );
  }

  notifyPriorityChange(taskId, oldPri, newPri, reason) {
    this.broadcast(
      `Task ${taskId.slice(0, 8)}: ${oldPri} → ${newPri}. ${reason}`,
      { refs: { tasks: [taskId], type: messageBus.MSG_TYPES.PRIORITY_CHANGE } }
    );
  }

  updateStatus(status, currentTask) {
    this._client.status(status, { currentTask });
  }

  // --- Receive methods ---

  onMessage(handler) {
    this._handlers.push({ type: 'message', fn: handler });
  }

  onPresence(handler) {
    this._handlers.push({ type: 'presence', fn: handler });
  }

  onStatus(handler) {
    this._handlers.push({ type: 'status', fn: handler });
  }

  onEscalation(handler) {
    this._escalationHandler = handler;
  }

  _handleIncoming(msg) {
    // Check if this needs escalation
    const agentLoop = safeRequire('./agent-loop');
    if (agentLoop) {
      const escalation = agentLoop.detectEscalation(msg, null);
      if (escalation.shouldEscalate && this._escalationHandler) {
        this._escalationHandler(msg, escalation);
        return;
      }
    }
    this._emit('message', msg);
  }

  _emit(type, data) {
    for (const h of this._handlers) {
      if (h.type === type) {
        try { h.fn(data); } catch (_) {}
      }
    }
  }

  // --- State ---

  get connected() { return this._connected; }
  get agentId() { return this._agentId; }

  close() {
    this._autoReconnect = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._client.close();
    this._connected = false;
  }
}

function safeRequire(mod) {
  try { return require(mod); } catch (_) { return null; }
}

// --- Server factory ---

function createServer(opts) {
  return new SwarmRealtimeServer(opts || {});
}

module.exports = {
  RealtimeMessageBus,
  createServer,
};
