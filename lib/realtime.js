'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_PORT = 9377;
const DEFAULT_MAX_PAYLOAD = 64 * 1024;
const DEFAULT_RATE_LIMIT = 120;

function jsonLine(value) {
  return JSON.stringify(value) + '\n';
}

function safeJsonParse(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function normalizeServerUrl(url, port) {
  if (!url) return `ws://localhost:${port || DEFAULT_PORT}/ws`;
  if (url.startsWith('http://')) return 'ws://' + url.slice('http://'.length).replace(/\/$/, '') + '/ws';
  if (url.startsWith('https://')) return 'wss://' + url.slice('https://'.length).replace(/\/$/, '') + '/ws';
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    const parsed = new URL(url);
    if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/ws';
    return parsed.toString();
  }
  return `ws://${url.replace(/\/$/, '')}/ws`;
}

function acceptKey(secWebSocketKey) {
  return crypto
    .createHash('sha1')
    .update(secWebSocketKey + WS_GUID)
    .digest('base64');
}

function encodeFrame(data, opts) {
  opts = opts || {};
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const mask = Boolean(opts.mask);
  const opcode = opts.opcode || 0x1;
  let headerLength = 2;

  if (payload.length >= 126 && payload.length <= 65535) headerLength += 2;
  else if (payload.length > 65535) headerLength += 8;
  if (mask) headerLength += 4;

  const frame = Buffer.alloc(headerLength + payload.length);
  frame[0] = 0x80 | opcode;

  let offset = 2;
  if (payload.length < 126) {
    frame[1] = (mask ? 0x80 : 0) | payload.length;
  } else if (payload.length <= 65535) {
    frame[1] = (mask ? 0x80 : 0) | 126;
    frame.writeUInt16BE(payload.length, offset);
    offset += 2;
  } else {
    frame[1] = (mask ? 0x80 : 0) | 127;
    frame.writeBigUInt64BE(BigInt(payload.length), offset);
    offset += 8;
  }

  if (!mask) {
    payload.copy(frame, offset);
    return frame;
  }

  const maskKey = crypto.randomBytes(4);
  maskKey.copy(frame, offset);
  offset += 4;
  for (let i = 0; i < payload.length; i++) {
    frame[offset + i] = payload[i] ^ maskKey[i % 4];
  }
  return frame;
}

function decodeFrames(buffer, opts) {
  opts = opts || {};
  const maxPayload = opts.maxPayload || DEFAULT_MAX_PAYLOAD;
  const frames = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      const bigLength = buffer.readBigUInt64BE(cursor);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('WebSocket payload too large');
      }
      length = Number(bigLength);
      cursor += 8;
    }

    if (length > maxPayload) throw new Error('WebSocket payload exceeds limit');

    let maskKey = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      maskKey = buffer.slice(cursor, cursor + 4);
      cursor += 4;
    }

    if (buffer.length - cursor < length) break;

    const payload = Buffer.from(buffer.slice(cursor, cursor + length));
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }

    frames.push({ opcode, payload });
    offset = cursor + length;
  }

  return { frames, rest: buffer.slice(offset) };
}

function makeMessage(input) {
  const now = new Date().toISOString();
  return {
    id: input.id || crypto.randomUUID(),
    type: input.type || 'agent.message',
    from: input.from || input.agent_id || null,
    to: input.to || 'broadcast',
    room: input.room || 'general',
    content: input.content || '',
    refs: input.refs || null,
    timestamp: input.timestamp || now,
  };
}

class SwarmRealtimeServer {
  constructor(opts) {
    opts = opts || {};
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port === undefined ? DEFAULT_PORT : opts.port;
    this.maxPayload = opts.maxPayload || DEFAULT_MAX_PAYLOAD;
    this.rateLimitPerMinute = opts.rateLimitPerMinute || DEFAULT_RATE_LIMIT;
    this.apiKey = opts.apiKey || process.env.SWARM_SERVER_TOKEN || null;
    this.swarmRoot = opts.swarmRoot || null;
    this.stateDir = path.resolve(opts.stateDir || path.join(opts.swarmRoot || process.cwd(), '.swarm-server'));
    this.messagesFile = path.join(this.stateDir, 'messages.jsonl');
    this.server = null;
    this.clients = new Map();
    this._nextClientId = 1;

    // Bug #4 fix: load io-bus to persist WS messages to agent inbox files.
    this._ioBus = null;
    if (this.swarmRoot) {
      try { this._ioBus = require('./io-bus'); } catch (_) {}
    }
  }

  start() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    if (!fs.existsSync(this.messagesFile)) fs.writeFileSync(this.messagesFile, '', 'utf-8');

    this.server = http.createServer((req, res) => this._handleHttp(req, res));
    this.server.on('upgrade', (req, socket) => this._handleUpgrade(req, socket));

    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve({ ok: true, host: this.host, port: this.port, url: `ws://${this.host}:${this.port}/ws` });
      });
    });
  }

  stop() {
    for (const client of this.clients.values()) {
      try { client.socket.end(); } catch (_) {}
    }
    this.clients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  _authorize(req) {
    if (!this.apiKey) return true;
    const header = req.headers.authorization || '';
    const query = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
    return header === `Bearer ${this.apiKey}` || query.get('token') === this.apiKey;
  }

  _handleHttp(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!this._authorize(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health' && req.method === 'GET') {
      this._json(res, 200, {
        ok: true,
        transport: 'websocket',
        clients: this.clients.size,
        messages: this._countMessages(),
      });
      return;
    }

    if (url.pathname === '/agents' && req.method === 'GET') {
      this._json(res, 200, {
        agents: Array.from(this.clients.values()).map(client => ({
          client_id: client.id,
          agent_id: client.agentId,
          name: client.name,
          provider: client.provider,
          rooms: Array.from(client.rooms),
          last_seen: client.lastSeen,
        })),
      });
      return;
    }

    if (url.pathname === '/messages' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      const room = url.searchParams.get('room');
      const agent = url.searchParams.get('agent');
      this._json(res, 200, {
        messages: this._readMessages({ limit, room, agent }),
      });
      return;
    }

    if (url.pathname === '/message' && req.method === 'POST') {
      this._readBody(req).then(body => {
        const msg = this.publish(makeMessage(body));
        this._json(res, 200, { ok: true, message: msg });
      }).catch(err => {
        this._json(res, 400, { ok: false, error: err.message });
      });
      return;
    }

    this._json(res, 404, { ok: false, error: 'unknown endpoint' });
  }

  _handleUpgrade(req, socket) {
    if (new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    if (!this._authorize(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n',
    ].join('\r\n'));

    const client = {
      id: `client-${this._nextClientId++}`,
      socket,
      agentId: null,
      name: null,
      provider: null,
      rooms: new Set(['general']),
      buffer: Buffer.alloc(0),
      sentThisWindow: 0,
      windowStarted: Date.now(),
      lastSeen: new Date().toISOString(),
    };

    this.clients.set(client.id, client);
    this._send(client, { type: 'server.welcome', client_id: client.id, timestamp: new Date().toISOString() });

    socket.on('data', chunk => this._handleSocketData(client, chunk));
    socket.on('close', () => this._removeClient(client));
    socket.on('error', () => this._removeClient(client));
  }

  _handleSocketData(client, chunk) {
    client.buffer = Buffer.concat([client.buffer, chunk]);

    let decoded;
    try {
      decoded = decodeFrames(client.buffer, { maxPayload: this.maxPayload });
    } catch (err) {
      this._send(client, { type: 'server.error', error: err.message });
      client.socket.end();
      return;
    }

    client.buffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        client.socket.end();
      } else if (frame.opcode === 0x9) {
        this._sendRaw(client, encodeFrame(frame.payload, { opcode: 0xA }));
      } else if (frame.opcode === 0x1) {
        const data = safeJsonParse(frame.payload.toString('utf-8'));
        if (!data) {
          this._send(client, { type: 'server.error', error: 'invalid json' });
          continue;
        }
        this._handleClientEvent(client, data);
      }
    }
  }

  _handleClientEvent(client, data) {
    if (!this._rateLimit(client)) {
      this._send(client, { type: 'server.error', error: 'rate limit exceeded' });
      return;
    }

    client.lastSeen = new Date().toISOString();

    if (data.type === 'hello' || data.type === 'agent.join') {
      client.agentId = data.agent_id || data.id || client.agentId;
      client.name = data.name || client.name || client.agentId;
      client.provider = data.provider || client.provider || 'unknown';
      client.rooms = new Set(['general', ...((data.rooms || []).filter(Boolean))]);
      const event = {
        type: 'agent.presence',
        event: 'joined',
        agent_id: client.agentId,
        name: client.name,
        provider: client.provider,
        rooms: Array.from(client.rooms),
        timestamp: client.lastSeen,
      };
      this._broadcast(event, { includeSender: true });
      return;
    }

    if (data.type === 'room.join') {
      client.rooms.add(data.room || 'general');
      this._send(client, { type: 'room.joined', room: data.room || 'general' });
      return;
    }

    if (data.type === 'room.leave') {
      client.rooms.delete(data.room || 'general');
      this._send(client, { type: 'room.left', room: data.room || 'general' });
      return;
    }

    if (data.type === 'agent.status') {
      this._broadcast({
        type: 'agent.status',
        from: data.from || client.agentId,
        status: data.status || 'unknown',
        token_status: data.token_status || null,
        current_task: data.current_task || null,
        timestamp: new Date().toISOString(),
      }, { includeSender: true });
      return;
    }

    if (data.type === 'agent.message' || data.type === 'message' || data.type === 'command') {
      const msg = makeMessage({
        ...data,
        type: data.type === 'message' ? 'agent.message' : data.type,
        from: data.from || client.agentId,
      });
      this.publish(msg);
      return;
    }

    this._send(client, { type: 'server.error', error: `unknown event type: ${data.type}` });
  }

  publish(message) {
    const msg = makeMessage(message);
    fs.appendFileSync(this.messagesFile, jsonLine(msg), 'utf-8');
    this._broadcast(msg, { room: msg.room, target: msg.to });

    // Bug #4 fix: persist to agent's inbox so file-based runners see the message on next tick.
    if (this._ioBus && this.swarmRoot && msg.to && msg.to !== 'broadcast' && msg.to !== 'all') {
      try { this._ioBus.deliver(this.swarmRoot, msg.to, { from: msg.from, type: msg.type, content: msg.content, refs: msg.refs }); }
      catch (_) {}
    }
    // Broadcast messages go to the common room file so all runners see them.
    if (this._ioBus && this.swarmRoot && (!msg.to || msg.to === 'broadcast' || msg.to === 'all')) {
      try { this._ioBus.postRoom(this.swarmRoot, msg.from, msg.content, msg.type); }
      catch (_) {}
    }

    return msg;
  }

  _broadcast(event, opts) {
    opts = opts || {};
    for (const client of this.clients.values()) {
      if (!opts.includeSender && event.from && client.agentId === event.from) continue;
      const directTarget = opts.target && opts.target !== 'broadcast' && opts.target !== 'all';
      if (directTarget && client.agentId !== opts.target) continue;
      if (!directTarget && opts.room && !client.rooms.has(opts.room)) continue;
      this._send(client, event);
    }
  }

  _removeClient(client) {
    if (!this.clients.has(client.id)) return;
    this.clients.delete(client.id);
    if (client.agentId) {
      this._broadcast({
        type: 'agent.presence',
        event: 'left',
        agent_id: client.agentId,
        name: client.name,
        provider: client.provider,
        timestamp: new Date().toISOString(),
      }, { includeSender: true });
    }
  }

  _rateLimit(client) {
    const now = Date.now();
    if (now - client.windowStarted > 60000) {
      client.windowStarted = now;
      client.sentThisWindow = 0;
    }
    client.sentThisWindow++;
    return client.sentThisWindow <= this.rateLimitPerMinute;
  }

  _send(client, event) {
    this._sendRaw(client, encodeFrame(JSON.stringify(event)));
  }

  _sendRaw(client, frame) {
    try { client.socket.write(frame); } catch (_) {}
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > this.maxPayload) {
          reject(new Error('request body exceeds limit'));
          req.destroy();
        }
      });
      req.on('end', () => {
        const parsed = safeJsonParse(body);
        if (!parsed) reject(new Error('invalid json'));
        else resolve(parsed);
      });
      req.on('error', reject);
    });
  }

  _json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  _readMessages(opts) {
    opts = opts || {};
    if (!fs.existsSync(this.messagesFile)) return [];
    const limit = opts.limit || 100;
    return fs.readFileSync(this.messagesFile, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(safeJsonParse)
      .filter(Boolean)
      .filter(msg => !opts.room || msg.room === opts.room)
      .filter(msg => !opts.agent || msg.from === opts.agent || msg.to === opts.agent)
      .slice(-limit);
  }

  _countMessages() {
    if (!fs.existsSync(this.messagesFile)) return 0;
    return fs.readFileSync(this.messagesFile, 'utf-8').split('\n').filter(Boolean).length;
  }
}

class RealtimeClient {
  constructor(opts) {
    opts = opts || {};
    this.url = normalizeServerUrl(opts.serverUrl || opts.url, opts.port);
    this.agentId = opts.agentId || opts.agent_id || null;
    this.name = opts.name || this.agentId;
    this.provider = opts.provider || 'unknown';
    this.rooms = opts.rooms || ['general'];
    this.token = opts.token || process.env.SWARM_SERVER_TOKEN || null;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handlers = new Map();
  }

  connect() {
    const parsed = new URL(this.url);
    if (parsed.protocol === 'wss:') {
      return Promise.reject(new Error('wss is not supported by the stdlib realtime client yet'));
    }

    const key = crypto.randomBytes(16).toString('base64');
    const port = parsed.port ? Number(parsed.port) : 80;
    const host = parsed.hostname;
    const pathWithQuery = parsed.pathname + parsed.search;

    return new Promise((resolve, reject) => {
      const socket = net.connect(port, host);
      let handshake = '';

      socket.on('connect', () => {
        const headers = [
          `GET ${pathWithQuery || '/ws'} HTTP/1.1`,
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
        ];
        if (this.token) headers.push(`Authorization: Bearer ${this.token}`);
        socket.write(headers.concat('\r\n').join('\r\n'));
      });

      const onHandshakeData = (chunk) => {
        handshake += chunk.toString('binary');
        const idx = handshake.indexOf('\r\n\r\n');
        if (idx === -1) return;

        const head = handshake.slice(0, idx);
        const rest = Buffer.from(handshake.slice(idx + 4), 'binary');
        if (!head.startsWith('HTTP/1.1 101')) {
          socket.destroy();
          reject(new Error('WebSocket handshake failed: ' + head.split('\r\n')[0]));
          return;
        }

        socket.off('data', onHandshakeData);
        this.socket = socket;
        socket.on('data', data => this._handleData(data));
        socket.on('close', () => this._emit('close', {}));
        socket.on('error', err => this._emit('error', err));

        if (rest.length > 0) this._handleData(rest);
        if (this.agentId) {
          this.send('hello', {
            agent_id: this.agentId,
            name: this.name,
            provider: this.provider,
            rooms: this.rooms,
          });
        }
        resolve({ ok: true });
      };

      socket.on('data', onHandshakeData);
      socket.on('error', reject);
    });
  }

  send(type, payload) {
    if (!this.socket) throw new Error('RealtimeClient is not connected');
    const event = { ...(payload || {}), type };
    this.socket.write(encodeFrame(JSON.stringify(event), { mask: true }));
  }

  message(to, content, opts) {
    opts = opts || {};
    this.send('agent.message', {
      from: this.agentId,
      to: to || 'broadcast',
      room: opts.room || 'general',
      content,
      refs: opts.refs || null,
    });
  }

  broadcast(content, opts) {
    this.message('broadcast', content, opts);
  }

  command(content, opts) {
    opts = opts || {};
    this.send('command', {
      from: this.agentId,
      to: opts.to || 'broadcast',
      room: opts.room || 'general',
      content,
      refs: opts.refs || null,
    });
  }

  status(status, opts) {
    opts = opts || {};
    this.send('agent.status', {
      from: this.agentId,
      status,
      token_status: opts.tokenStatus || opts.token_status || null,
      current_task: opts.currentTask || opts.current_task || null,
    });
  }

  joinRoom(room) {
    this.send('room.join', { room });
  }

  leaveRoom(room) {
    this.send('room.leave', { room });
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
    return () => {
      const handlers = this.handlers.get(type) || [];
      this.handlers.set(type, handlers.filter(h => h !== handler));
    };
  }

  close() {
    if (this.socket) {
      this.socket.write(encodeFrame('', { opcode: 0x8, mask: true }));
      this.socket.end();
      this.socket = null;
    }
  }

  _handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const decoded = decodeFrames(this.buffer);
    this.buffer = decoded.rest;

    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        this.close();
      } else if (frame.opcode === 0x1) {
        const event = safeJsonParse(frame.payload.toString('utf-8'));
        if (event) {
          this._emit(event.type, event);
          this._emit('*', event);
        }
      }
    }
  }

  _emit(type, event) {
    for (const handler of this.handlers.get(type) || []) {
      try { handler(event); } catch (_) {}
    }
  }
}

module.exports = {
  SwarmRealtimeServer,
  RealtimeClient,
  encodeFrame,
  decodeFrames,
  normalizeServerUrl,
};
