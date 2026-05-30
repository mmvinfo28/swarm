#!/usr/bin/env node
'use strict';

// One-command launcher for the full swarm stack:
//   node start.js [swarm-root] [--ws-port N] [--dash-port N] [--no-dash]
//
// Starts:
//   1. WebSocket relay server  (lib/server.js)
//   2. HTML dashboard server   (dashboard/web.js)
//
// After start, agents can discover the WS URL from .swarm/.server-url

const { spawn } = require('child_process');
const path  = require('path');
const fs    = require('fs');

function findSwarmRoot(dir) {
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.swarm'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

// ─── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let swarmRoot = null;
let wsPort  = parseInt(process.env.SWARM_SERVER_PORT || '9377', 10);
let dashPort = parseInt(process.env.SWARM_DASH_PORT  || '7379', 10);
let noDash  = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ws-port'   && args[i+1]) { wsPort   = parseInt(args[++i], 10); }
  else if (args[i] === '--dash-port' && args[i+1]) { dashPort = parseInt(args[++i], 10); }
  else if (args[i] === '--no-dash') { noDash = true; }
  else if (!swarmRoot && !args[i].startsWith('--')) { swarmRoot = args[i]; }
}

swarmRoot = swarmRoot || findSwarmRoot(process.cwd());

if (!swarmRoot || !fs.existsSync(path.join(swarmRoot, '.swarm'))) {
  console.error('[start] No .swarm/ directory found.');
  console.error('[start] Run from a swarm repo, or pass path: node start.js /path/to/repo');
  console.error('[start] Initialize with: /swarm init');
  process.exit(1);
}

const libDir  = path.join(__dirname, 'lib');
const dashDir = path.join(__dirname, 'dashboard');

// ─── Spawn helper ─────────────────────────────────────────────────────────────

const children = [];

function launch(label, scriptPath, args, color) {
  const colorCode = { cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', reset: '\x1b[0m' };
  const prefix = `${colorCode[color] || ''}[${label}]${colorCode.reset} `;

  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: swarmRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SWARM_ROOT: swarmRoot },
  });

  child.stdout.on('data', d => process.stdout.write(prefix + d.toString().replace(/\n/g, '\n' + prefix)));
  child.stderr.on('data', d => process.stderr.write(prefix + d.toString().replace(/\n/g, '\n' + prefix)));

  child.on('exit', (code, sig) => {
    if (code !== 0 && code !== null) {
      console.error(`${prefix}exited with code ${code}`);
    }
  });

  children.push(child);
  return child;
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('\x1b[36m');
console.log('  ╔══════════════════════════════════════╗');
console.log('  ║         SWARM STACK STARTING         ║');
console.log('  ╚══════════════════════════════════════╝');
console.log('\x1b[0m');
console.log(`  Root:    ${swarmRoot}`);
console.log(`  WS:      ws://localhost:${wsPort}/ws`);
if (!noDash) console.log(`  Dash:    http://localhost:${dashPort}`);
console.log('');

// 1. WebSocket relay
launch('ws-server', path.join(libDir, 'server.js'), [String(wsPort), swarmRoot], 'cyan');

// 2. HTML dashboard
if (!noDash) {
  // Small delay so server writes .server-url before dashboard starts
  setTimeout(() => {
    launch('dashboard', path.join(dashDir, 'web.js'), [String(dashPort), swarmRoot], 'green');
  }, 800);
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

function shutdown() {
  console.log('\n[start] Shutting down all processes...');
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// Watchdog: if all children die, exit
setInterval(() => {
  const alive = children.filter(c => c.exitCode === null && !c.killed);
  if (children.length > 0 && alive.length === 0) {
    console.error('[start] All processes exited.');
    process.exit(1);
  }
}, 3000);
