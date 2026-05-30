#!/usr/bin/env node
'use strict';

// Standalone WebSocket relay server for swarm real-time messaging.
//
// Usage:
//   node lib/server.js [port] [swarm-root]
//
// Environment:
//   SWARM_SERVER_PORT  — port (default 9377)
//   SWARM_SERVER_TOKEN — auth token (optional, no auth if unset)
//   SWARM_ROOT         — swarm repo root (default: cwd or auto-detected)

const path = require('path');
const fs = require('fs');
const { SwarmRealtimeServer } = require('./realtime');

function findSwarmRoot(dir) {
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.swarm'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

const port = parseInt(process.argv[2] || process.env.SWARM_SERVER_PORT || '9377', 10);
const swarmRoot = (
  process.argv[3] ||
  process.env.SWARM_ROOT ||
  findSwarmRoot(process.cwd()) ||
  process.cwd()
);

if (!fs.existsSync(path.join(swarmRoot, '.swarm'))) {
  console.error(`[swarm-server] No .swarm/ found in: ${swarmRoot}`);
  console.error('[swarm-server] Run /swarm init first, or pass path as second argument.');
  process.exit(1);
}

const server = new SwarmRealtimeServer({
  host: '0.0.0.0',
  port,
  swarmRoot,
  apiKey: process.env.SWARM_SERVER_TOKEN || null,
});

server.start().then(({ url, port: actualPort }) => {
  const localUrl = `ws://localhost:${actualPort}/ws`;

  console.log(`[swarm-server] WebSocket relay running`);
  console.log(`[swarm-server] URL:      ${localUrl}`);
  console.log(`[swarm-server] Root:     ${swarmRoot}`);
  console.log(`[swarm-server] Auth:     ${process.env.SWARM_SERVER_TOKEN ? 'token required' : 'open (no token)'}`);
  console.log(`[swarm-server] Health:   ${localUrl.replace('/ws', '/health')}`);
  console.log('');
  console.log('[swarm-server] Set in agent environments:');
  console.log(`  SWARM_SERVER_URL=${localUrl}`);
  if (process.env.SWARM_SERVER_TOKEN) {
    console.log(`  SWARM_SERVER_TOKEN=${process.env.SWARM_SERVER_TOKEN}`);
  }
  console.log('');
  console.log('[swarm-server] Press Ctrl+C to stop.');

  // Write URL to .swarm/.server-url so agents can auto-discover it
  const urlFile = path.join(swarmRoot, '.swarm', '.server-url');
  try {
    fs.writeFileSync(urlFile, localUrl, 'utf-8');
    console.log(`[swarm-server] URL saved to ${urlFile}`);
  } catch (_) {}

}).catch(err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[swarm-server] Port ${port} already in use.`);
    console.error(`[swarm-server] Try: node lib/server.js ${port + 1}`);
  } else {
    console.error(`[swarm-server] Failed to start: ${err.message}`);
  }
  process.exit(1);
});

function shutdown() {
  console.log('\n[swarm-server] Shutting down...');

  // Remove URL file on clean shutdown
  const urlFile = path.join(swarmRoot, '.swarm', '.server-url');
  try { fs.unlinkSync(urlFile); } catch (_) {}

  server.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
