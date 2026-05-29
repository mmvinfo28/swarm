#!/usr/bin/env node
'use strict';

const path = require('path');
const { SwarmRealtimeServer } = require('../lib/realtime');

function parseArgs(argv) {
  const opts = {
    host: process.env.SWARM_HOST || '127.0.0.1',
    port: process.env.SWARM_PORT ? Number(process.env.SWARM_PORT) : 9377,
    swarmRoot: process.cwd(),
    stateDir: process.env.SWARM_STATE_DIR || null,
    apiKey: process.env.SWARM_SERVER_TOKEN || null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--host') opts.host = next, i++;
    else if (arg === '--port') opts.port = Number(next), i++;
    else if (arg === '--root') opts.swarmRoot = path.resolve(next), i++;
    else if (arg === '--state-dir') opts.stateDir = path.resolve(next), i++;
    else if (arg === '--token') opts.apiKey = next, i++;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function printHelp() {
  process.stdout.write([
    'Swarm realtime server',
    '',
    'Usage:',
    '  node server/index.js [--host 127.0.0.1] [--port 9377] [--root <repo>] [--state-dir <dir>] [--token <token>]',
    '',
    'Environment:',
    '  SWARM_HOST          Bind host. Defaults to 127.0.0.1',
    '  SWARM_PORT          Bind port. Defaults to 9377',
    '  SWARM_STATE_DIR     Message history directory. Defaults to <root>/.swarm-server',
    '  SWARM_SERVER_TOKEN  Optional bearer token for HTTP/WebSocket clients',
    '',
  ].join('\n'));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const server = new SwarmRealtimeServer(opts);
  const started = await server.start();

  process.stdout.write([
    `Swarm realtime server listening on ${started.url}`,
    `HTTP health: http://${started.host}:${started.port}/health`,
    `State dir: ${server.stateDir}`,
    opts.apiKey ? 'Auth: bearer token required' : 'Auth: disabled',
    '',
  ].join('\n'));

  function shutdown() {
    server.stop();
    process.stdout.write('Swarm realtime server stopped\n');
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`Failed to start Swarm realtime server: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, printHelp, main };
