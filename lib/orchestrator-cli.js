#!/usr/bin/env node
'use strict';

// Thin CLI over lib/orchestrator.js so non-Node agents (Python adapters) and the
// SKILL `/swarm delegate` command can trigger distribution through one code path.
//
// Usage:
//   node lib/orchestrator-cli.js distribute <swarm-root> <lead-agent-id> [--force]
//   node lib/orchestrator-cli.js assignments <swarm-root> <agent-id>
//
// Prints a JSON result to stdout. Exit 0 on success, 1 on error.

const path = require('path');
const fs = require('fs');
const orchestrator = require('./orchestrator');

function findSwarmRoot(dir) {
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.swarm'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function fail(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  process.exit(1);
}

const [, , cmd, rootArg, idArg, ...rest] = process.argv;
const swarmRoot = rootArg || findSwarmRoot(process.cwd());

if (!cmd) fail('usage: orchestrator-cli.js <distribute|assignments> <root> <id>');
if (!swarmRoot || !fs.existsSync(path.join(swarmRoot, '.swarm'))) {
  fail(`no .swarm/ at: ${swarmRoot || '(none)'}`);
}

try {
  if (cmd === 'distribute') {
    if (!idArg) fail('distribute requires <lead-agent-id>');
    const force = rest.includes('--force');
    const result = orchestrator.distribute(swarmRoot, idArg, { force });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  }

  if (cmd === 'assignments') {
    if (!idArg) fail('assignments requires <agent-id>');
    const tasks = orchestrator.assignmentsFor(swarmRoot, idArg);
    process.stdout.write(JSON.stringify({ ok: true, tasks }) + '\n');
    process.exit(0);
  }

  fail(`unknown command: ${cmd}`);
} catch (err) {
  fail(err.message);
}
