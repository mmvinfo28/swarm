'use strict';

const { BaseTransport, SyncTransportMixin } = require('./base');
const { GitTransport } = require('./git');
const { HttpServer, HttpTransport } = require('./http');
const { SwarmRealtimeServer, RealtimeClient } = require('../realtime');

const TRANSPORTS = {
  git: GitTransport,
  http: HttpTransport,
};

/**
 * Create a transport instance by name.
 *
 * @param {string} name - Transport name: 'git', 'http', 'supabase'
 * @param {object} opts - Transport-specific options
 * @returns {BaseTransport}
 *
 * Usage:
 *   const transport = createTransport('git', { swarmRoot: '/path/to/repo' });
 *   const transport = createTransport('http', { serverUrl: 'http://10.0.0.5:9377' });
 */
function createTransport(name, opts) {
  const TransportClass = TRANSPORTS[name];
  if (!TransportClass) {
    const available = Object.keys(TRANSPORTS).join(', ');
    throw new Error(`Unknown transport "${name}". Available: ${available}`);
  }
  return new TransportClass(opts);
}

/**
 * Register a custom transport.
 *
 * @param {string} name - Transport name
 * @param {typeof BaseTransport} TransportClass - Transport class extending BaseTransport
 *
 * Usage:
 *   registerTransport('redis', RedisTransport);
 *   const transport = createTransport('redis', { url: 'redis://...' });
 */
function registerTransport(name, TransportClass) {
  if (typeof TransportClass !== 'function') {
    throw new Error('TransportClass must be a constructor');
  }
  TRANSPORTS[name] = TransportClass;
}

/**
 * List available transports with their capabilities.
 */
function listTransports() {
  const result = {};
  for (const [name, Cls] of Object.entries(TRANSPORTS)) {
    try {
      const instance = new Cls({ swarmRoot: '' });
      result[name] = {
        name: instance.name,
        capabilities: instance.capabilities,
      };
    } catch (_) {
      result[name] = { name, capabilities: {} };
    }
  }
  return result;
}

/**
 * Auto-detect best transport for current environment.
 *
 * Priority:
 * 1. If SWARM_TRANSPORT env var set → use that
 * 2. If .swarm/config.yaml has transport field → use that
 * 3. If server URL env var set → http
 * 4. If in git repo → git
 * 5. Fallback: git
 */
function autoDetect(opts) {
  // 1. Env var
  const envTransport = process.env.SWARM_TRANSPORT;
  if (envTransport && TRANSPORTS[envTransport]) {
    return createTransport(envTransport, opts);
  }

  // 2. Config file
  if (opts.swarmRoot) {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(opts.swarmRoot, '.swarm', 'config.yaml');
    if (fs.existsSync(configPath)) {
      const yaml = require('../yaml');
      const config = yaml.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config && config.transport && TRANSPORTS[config.transport]) {
        return createTransport(config.transport, { ...opts, ...config });
      }
    }
  }

  // 3. Server URL env var
  if (process.env.SWARM_SERVER_URL) {
    return createTransport('http', {
      ...opts,
      serverUrl: process.env.SWARM_SERVER_URL,
    });
  }

  // 4. Default: git
  return createTransport('git', opts);
}

module.exports = {
  BaseTransport,
  SyncTransportMixin,
  GitTransport,
  HttpServer,
  HttpTransport,
  SwarmRealtimeServer,
  RealtimeClient,
  createTransport,
  registerTransport,
  listTransports,
  autoDetect,
};
