#!/usr/bin/env node
// swarm — shared config utilities for hooks
// Pattern: caveman-config.js (symlink-safe flag files, safe reads)

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const FLAG_MAX_SIZE = 1024;

/**
 * Find .swarm/ directory by walking up from cwd.
 * Returns repo root (parent of .swarm/) or null.
 */
function findSwarmRoot(startDir) {
  let dir = startDir || process.cwd();
  const root = path.parse(dir).root;

  while (dir !== root) {
    const swarmDir = path.join(dir, '.swarm');
    const configFile = path.join(swarmDir, 'config.yaml');
    if (fs.existsSync(swarmDir) && fs.statSync(swarmDir).isDirectory()) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Get or create agent ID from flag file.
 * Persists across sessions so agent keeps its identity.
 */
function getAgentId() {
  const flagPath = path.join(claudeDir, '.swarm-agent-id');
  const existing = readFlag(flagPath);
  if (existing && /^[0-9a-f-]{36}$/.test(existing)) {
    return existing;
  }
  const id = crypto.randomUUID();
  safeWriteFlag(flagPath, id);
  return id;
}

/**
 * Symlink-safe flag file write.
 * Write to temp file + atomic rename. Prevents symlink attacks.
 */
function safeWriteFlag(flagPath, content) {
  try {
    // Refuse to write through symlinks
    try {
      const stat = fs.lstatSync(flagPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(flagPath);
      }
    } catch (_) {}

    const tmpPath = flagPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, String(content), { mode: 0o600 });
    fs.renameSync(tmpPath, flagPath);
  } catch (_) {}
}

/**
 * Safe flag file read with size cap and content validation.
 * Returns null if missing, symlink, oversized, or invalid.
 */
function readFlag(flagPath) {
  try {
    const stat = fs.lstatSync(flagPath);
    if (stat.isSymbolicLink()) return null;
    if (stat.size > FLAG_MAX_SIZE) return null;
    return fs.readFileSync(flagPath, 'utf-8').trim();
  } catch (_) {
    return null;
  }
}

/**
 * Get swarm config from .swarm/config.yaml if it exists.
 */
function getSwarmConfig(swarmRoot) {
  try {
    const configPath = path.join(swarmRoot, '.swarm', 'config.yaml');
    if (!fs.existsSync(configPath)) return {};
    const yaml = require(path.join(__dirname, '..', 'lib', 'yaml'));
    return yaml.parse(fs.readFileSync(configPath, 'utf-8')) || {};
  } catch (_) {
    return {};
  }
}

/**
 * Build a compact team status summary for injection into model context.
 */
function buildStatusSummary(swarmRoot) {
  try {
    const libDir = path.join(__dirname, '..', 'lib');
    const yaml = require(path.join(libDir, 'yaml'));
    const agentsDir = path.join(swarmRoot, '.swarm', 'agents');
    const tasksDir = path.join(swarmRoot, '.swarm', 'tasks');

    const agents = [];
    if (fs.existsSync(agentsDir)) {
      for (const f of fs.readdirSync(agentsDir)) {
        if (!f.startsWith('agent-') || !f.endsWith('.yaml')) continue;
        const a = yaml.parse(fs.readFileSync(path.join(agentsDir, f), 'utf-8'));
        if (a && a.id) agents.push(a);
      }
    }

    let taskStats = { open: 0, in_progress: 0, done: 0, total: 0 };
    if (fs.existsSync(tasksDir)) {
      for (const f of fs.readdirSync(tasksDir)) {
        if (!f.startsWith('task-') || !f.endsWith('.yaml')) continue;
        const t = yaml.parse(fs.readFileSync(path.join(tasksDir, f), 'utf-8'));
        if (!t) continue;
        taskStats.total++;
        if (t.status === 'open') taskStats.open++;
        else if (t.status === 'in_progress' || t.status === 'assigned') taskStats.in_progress++;
        else if (t.status === 'done') taskStats.done++;
      }
    }

    const agentList = agents.map(a =>
      `${a.name} (${a.provider}) [${a.status}]`
    ).join(', ');

    const lines = [
      `SWARM ACTIVE — ${agents.length} agents, ${taskStats.total} tasks`,
      `Agents: ${agentList || 'none'}`,
      `Tasks: ${taskStats.open} open, ${taskStats.in_progress} active, ${taskStats.done} done`,
    ];

    // Check for pending escalations
    const escDir = path.join(swarmRoot, '.swarm', 'escalations');
    if (fs.existsSync(escDir)) {
      const pending = fs.readdirSync(escDir)
        .filter(f => f.startsWith('esc-') && f.endsWith('.yaml'))
        .map(f => yaml.parse(fs.readFileSync(path.join(escDir, f), 'utf-8')))
        .filter(e => e && e.status === 'pending');
      if (pending.length > 0) {
        lines.push(`⚠ ${pending.length} escalation(s) awaiting human decision`);
      }
    }

    return lines.join('\n');
  } catch (_) {
    return null;
  }
}

module.exports = {
  claudeDir,
  findSwarmRoot,
  getAgentId,
  safeWriteFlag,
  readFlag,
  getSwarmConfig,
  buildStatusSummary,
};
