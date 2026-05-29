'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { BaseTransport } = require('./base');

/**
 * HTTP Transport
 *
 * Simple REST server + client for real-time-ish communication.
 * One machine runs the server, others connect as clients.
 *
 * Server stores files on disk in .swarm/ directory.
 * Clients communicate via HTTP API.
 *
 * Pros: ~50ms latency, simple, no external deps
 * Cons: Needs one always-on process, not offline-capable
 *
 * API:
 *   GET    /read?path=agents/foo.yaml     → file content
 *   POST   /write  {path, content}        → ok
 *   DELETE /remove?path=agents/foo.yaml   → ok
 *   GET    /list?dir=agents               → [filenames]
 *   GET    /exists?path=agents/foo.yaml   → {exists: bool}
 *   GET    /events (SSE)                  → real-time change stream
 */

// --- Server ---

class HttpServer {
  constructor(opts) {
    this._dataDir = path.join(opts.dataDir || opts.swarmRoot, '.swarm');
    this._port = opts.port || 9377;
    this._server = null;
    this._sseClients = [];

    if (!fs.existsSync(this._dataDir)) {
      fs.mkdirSync(this._dataDir, { recursive: true });
    }
  }

  _fullPath(relativePath) {
    const resolved = path.resolve(this._dataDir, relativePath);
    if (!resolved.startsWith(this._dataDir)) {
      throw new Error('Path traversal blocked');
    }
    return resolved;
  }

  _ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    this._sseClients = this._sseClients.filter(res => {
      try { res.write(data); return true; }
      catch (_) { return false; }
    });
  }

  _parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error('Invalid JSON')); }
      });
    });
  }

  _parseQuery(url) {
    const idx = url.indexOf('?');
    if (idx === -1) return {};
    const params = {};
    url.slice(idx + 1).split('&').forEach(p => {
      const [k, v] = p.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    return params;
  }

  start() {
    this._server = http.createServer(async (req, res) => {
      const urlPath = req.url.split('?')[0];
      const query = this._parseQuery(req.url);

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      try {
        if (urlPath === '/read' && req.method === 'GET') {
          const fp = this._fullPath(query.path);
          if (!fs.existsSync(fp)) {
            res.writeHead(404);
            return res.end(JSON.stringify({ error: 'not found' }));
          }
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(fs.readFileSync(fp, 'utf-8'));

        } else if (urlPath === '/write' && req.method === 'POST') {
          const body = await this._parseBody(req);
          const fp = this._fullPath(body.path);
          this._ensureDir(fp);
          fs.writeFileSync(fp, body.content, 'utf-8');
          this._broadcast({ type: 'update', path: body.path });
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true }));

        } else if (urlPath === '/remove' && req.method === 'DELETE') {
          const fp = this._fullPath(query.path);
          if (fs.existsSync(fp)) {
            fs.unlinkSync(fp);
            this._broadcast({ type: 'delete', path: query.path });
            res.writeHead(200);
            return res.end(JSON.stringify({ ok: true }));
          }
          res.writeHead(404);
          return res.end(JSON.stringify({ ok: false }));

        } else if (urlPath === '/list' && req.method === 'GET') {
          const dir = this._fullPath(query.dir || '');
          if (!fs.existsSync(dir)) {
            res.writeHead(200);
            return res.end(JSON.stringify([]));
          }
          const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(files));

        } else if (urlPath === '/exists' && req.method === 'GET') {
          const exists = fs.existsSync(this._fullPath(query.path));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ exists }));

        } else if (urlPath === '/events' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          this._sseClients.push(res);
          req.on('close', () => {
            this._sseClients = this._sseClients.filter(c => c !== res);
          });
          return;

        } else if (urlPath === '/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            ok: true,
            transport: 'http',
            clients: this._sseClients.length,
          }));

        } else {
          res.writeHead(404);
          return res.end(JSON.stringify({ error: 'unknown endpoint' }));
        }
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    });

    return new Promise((resolve) => {
      this._server.listen(this._port, () => {
        resolve({ ok: true, port: this._port });
      });
    });
  }

  stop() {
    if (this._server) {
      this._server.close();
      this._sseClients.forEach(res => { try { res.end(); } catch(_) {} });
      this._sseClients = [];
    }
  }
}

// --- Client Transport ---

class HttpTransport extends BaseTransport {
  constructor(opts) {
    super(opts);
    this._baseUrl = opts.serverUrl || `http://localhost:${opts.port || 9377}`;
    this._eventSource = null;
  }

  _request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, this._baseUrl);
      const opts = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/json' },
      };

      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async read(relativePath) {
    try {
      return await this._request('GET', `/read?path=${encodeURIComponent(relativePath)}`);
    } catch (err) {
      if (err.message.includes('404')) return null;
      throw err;
    }
  }

  async write(relativePath, content) {
    await this._request('POST', '/write', { path: relativePath, content });
  }

  async remove(relativePath) {
    try {
      await this._request('DELETE', `/remove?path=${encodeURIComponent(relativePath)}`);
      return true;
    } catch (_) {
      return false;
    }
  }

  async list(relativeDir) {
    const data = await this._request('GET', `/list?dir=${encodeURIComponent(relativeDir)}`);
    return JSON.parse(data);
  }

  async exists(relativePath) {
    const data = await this._request('GET', `/exists?path=${encodeURIComponent(relativePath)}`);
    return JSON.parse(data).exists;
  }

  // HTTP transport doesn't need push/pull — changes are instant
  async pull() { return { ok: true }; }
  async push() { return { ok: true }; }
  async sync() { return { ok: true }; }

  // --- SSE Watch ---

  watch(relativePath, callback) {
    const unwatch = super.watch(relativePath, callback);

    if (!this._eventSource) {
      this._connectSSE();
    }

    return unwatch;
  }

  _connectSSE() {
    // Use raw http for SSE (no EventSource in Node.js stdlib)
    const url = new URL('/events', this._baseUrl);
    const req = http.get({
      hostname: url.hostname,
      port: url.port,
      path: '/events',
      headers: { 'Accept': 'text/event-stream' },
    }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              this._notify(event.path, event);
            } catch (_) {}
          }
        }
      });
    });

    req.on('error', () => {
      // Reconnect after delay
      setTimeout(() => this._connectSSE(), 3000);
    });

    this._eventSource = req;
  }

  async init() {
    try {
      const data = await this._request('GET', '/health');
      const health = JSON.parse(data);
      return { ok: health.ok };
    } catch (err) {
      return { ok: false, error: 'Cannot connect to server: ' + err.message };
    }
  }

  async destroy() {
    if (this._eventSource) {
      this._eventSource.destroy();
      this._eventSource = null;
    }
    return super.destroy();
  }

  get name() {
    return 'http';
  }

  get capabilities() {
    return {
      realtime: true,
      offline: false,
      distributed: true,
      conflictFree: true,
    };
  }
}

module.exports = { HttpServer, HttpTransport };
