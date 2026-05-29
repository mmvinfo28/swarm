#!/usr/bin/env node
// swarm — SessionStart hook
//
// Runs on every Claude Code session start:
//   1. Detect if cwd is inside a swarm repo (.swarm/ exists)
//   2. If yes: register/heartbeat agent, emit team status as system context
//   3. If no: silent, no output
//
// Pattern follows caveman-activate.js: try/catch everything, never throw.

'use strict';

try {
  const { findSwarmRoot, getAgentId, buildStatusSummary } = require('./swarm-config');
  const path = require('path');

  const swarmRoot = findSwarmRoot();

  if (!swarmRoot) {
    // Not a swarm repo — silent exit
    process.exit(0);
  }

  const agentId = getAgentId();

  // Register or heartbeat
  try {
    const agentRegistry = require(path.join(__dirname, '..', 'lib', 'agent-registry'));
    const existing = agentRegistry.getAgent(swarmRoot, agentId);

    if (existing) {
      agentRegistry.heartbeat(swarmRoot, agentId);
      agentRegistry.updateStatus(swarmRoot, agentId, 'idle', null);
    } else {
      // First time — register with default name
      const os = require('os');
      const name = process.env.SWARM_AGENT_NAME || `Claude-${os.hostname().slice(0, 8)}`;
      const caps = (process.env.SWARM_CAPABILITIES || '').split(',').filter(Boolean);
      agentRegistry.register(swarmRoot, name, 'claude-code', caps, process.env.USER || os.userInfo().username);
    }
  } catch (_) {
    // Can't register — that's OK, still show status
  }

  // Prune offline agents
  try {
    const agentRegistry = require(path.join(__dirname, '..', 'lib', 'agent-registry'));
    agentRegistry.pruneOffline(swarmRoot);
  } catch (_) {}

  // Emit team status as system context
  const summary = buildStatusSummary(swarmRoot);
  if (summary) {
    process.stdout.write(summary);
  }
} catch (e) {
  // Silent fail — never block session start
}
