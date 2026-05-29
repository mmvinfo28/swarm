'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('./yaml');

const AGENTS_DIR = 'agents';
const DEFAULT_OFFLINE_THRESHOLD = 5 * 60 * 1000;

function agentsPath(swarmRoot) {
  return path.join(swarmRoot, '.swarm', AGENTS_DIR);
}

function agentFile(swarmRoot, agentId) {
  return path.join(agentsPath(swarmRoot), `agent-${agentId}.yaml`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function register(swarmRoot, name, provider, capabilities, owner) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const agent = {
    id,
    name: name || `agent-${id.slice(0, 8)}`,
    provider: provider || 'claude-code',
    owner: owner || null,
    capabilities: capabilities || [],
    status: 'idle',
    current_task: null,
    last_seen: now,
    joined_at: now,
  };

  const dir = agentsPath(swarmRoot);
  ensureDir(dir);
  fs.writeFileSync(agentFile(swarmRoot, id), yaml.serialize(agent) + '\n', 'utf-8');
  return agent;
}

function updateStatus(swarmRoot, agentId, status, currentTask) {
  const filePath = agentFile(swarmRoot, agentId);
  if (!fs.existsSync(filePath)) return null;

  const agent = yaml.parse(fs.readFileSync(filePath, 'utf-8'));
  agent.status = status;
  if (currentTask !== undefined) agent.current_task = currentTask;
  agent.last_seen = new Date().toISOString();
  fs.writeFileSync(filePath, yaml.serialize(agent) + '\n', 'utf-8');
  return agent;
}

function heartbeat(swarmRoot, agentId) {
  const filePath = agentFile(swarmRoot, agentId);
  if (!fs.existsSync(filePath)) return null;

  const agent = yaml.parse(fs.readFileSync(filePath, 'utf-8'));
  agent.last_seen = new Date().toISOString();
  fs.writeFileSync(filePath, yaml.serialize(agent) + '\n', 'utf-8');
  return agent;
}

function getAgent(swarmRoot, agentId) {
  const filePath = agentFile(swarmRoot, agentId);
  if (!fs.existsSync(filePath)) return null;
  return yaml.parse(fs.readFileSync(filePath, 'utf-8'));
}

function listAgents(swarmRoot) {
  const dir = agentsPath(swarmRoot);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.startsWith('agent-') && f.endsWith('.yaml'))
    .map(f => yaml.parse(fs.readFileSync(path.join(dir, f), 'utf-8')))
    .filter(a => a && a.id);
}

function pruneOffline(swarmRoot, threshold) {
  threshold = threshold || DEFAULT_OFFLINE_THRESHOLD;
  const now = Date.now();
  const agents = listAgents(swarmRoot);
  const pruned = [];

  for (const agent of agents) {
    if (agent.status === 'offline') continue;
    const lastSeen = new Date(agent.last_seen).getTime();
    if (now - lastSeen > threshold) {
      updateStatus(swarmRoot, agent.id, 'offline', null);
      pruned.push(agent.id);
    }
  }
  return pruned;
}

function removeAgent(swarmRoot, agentId) {
  const filePath = agentFile(swarmRoot, agentId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

function findByName(swarmRoot, name) {
  const agents = listAgents(swarmRoot);
  return agents.find(a =>
    a.name === name || a.name.toLowerCase() === name.toLowerCase()
  ) || null;
}

function findByProvider(swarmRoot, provider) {
  return listAgents(swarmRoot).filter(a => a.provider === provider);
}

// --- Credit failover & health ---

const AGENT_STATUSES = {
  IDLE: 'idle',
  WORKING: 'working',
  REVIEWING: 'reviewing',
  OFFLINE: 'offline',
  CREDITS_EXHAUSTED: 'credits_exhausted',
  ERROR: 'error',
};

function reportCreditExhaustion(swarmRoot, agentId) {
  const agent = updateStatus(swarmRoot, agentId, AGENT_STATUSES.CREDITS_EXHAUSTED, null);
  if (!agent) return { ok: false, error: 'agent not found' };

  const orphaned = getOrphanedTasks(swarmRoot, agentId);
  return { ok: true, agent, orphanedTasks: orphaned };
}

function reportError(swarmRoot, agentId, errorMsg) {
  const filePath = agentFile(swarmRoot, agentId);
  if (!fs.existsSync(filePath)) return null;

  const agent = yaml.parse(fs.readFileSync(filePath, 'utf-8'));
  agent.status = AGENT_STATUSES.ERROR;
  agent.last_error = errorMsg;
  agent.last_seen = new Date().toISOString();
  fs.writeFileSync(filePath, yaml.serialize(agent) + '\n', 'utf-8');
  return agent;
}

function getOrphanedTasks(swarmRoot, agentId) {
  const tasksDir = path.join(swarmRoot, '.swarm', 'tasks');
  if (!fs.existsSync(tasksDir)) return [];

  const taskYaml = require('./yaml');
  return fs.readdirSync(tasksDir)
    .filter(f => f.endsWith('.yaml'))
    .map(f => taskYaml.parse(fs.readFileSync(path.join(tasksDir, f), 'utf-8')))
    .filter(t => t && t.assigned_to === agentId && t.status !== 'done')
    .map(t => t.id);
}

function getFailoverCandidates(swarmRoot, requiredCapabilities) {
  const agents = listAgents(swarmRoot);
  const active = agents.filter(a =>
    a.status === AGENT_STATUSES.IDLE || a.status === AGENT_STATUSES.WORKING
  );

  if (!requiredCapabilities || requiredCapabilities.length === 0) {
    return active.sort((a, b) => {
      const aLoad = getOrphanedTasks(swarmRoot, a.id).length;
      const bLoad = getOrphanedTasks(swarmRoot, b.id).length;
      return aLoad - bLoad;
    });
  }

  const reqSet = new Set(requiredCapabilities);
  return active
    .map(a => {
      const caps = new Set(a.capabilities || []);
      const match = requiredCapabilities.filter(c => caps.has(c)).length / reqSet.size;
      return { agent: a, match };
    })
    .filter(x => x.match > 0)
    .sort((a, b) => b.match - a.match)
    .map(x => x.agent);
}

function reassignOrphanedTasks(swarmRoot, downAgentId) {
  const taskMgr = require('./task-manager');
  const orphaned = getOrphanedTasks(swarmRoot, downAgentId);
  const reassigned = [];

  for (const taskId of orphaned) {
    const task = taskMgr.getTask(swarmRoot, taskId);
    if (!task) continue;

    const candidates = getFailoverCandidates(swarmRoot, task.tags || []);
    if (candidates.length > 0) {
      taskMgr.assignTask(swarmRoot, taskId, candidates[0].id);
      reassigned.push({ taskId, from: downAgentId, to: candidates[0].id });
    } else {
      taskMgr.updateTask(swarmRoot, taskId, { assigned_to: null, status: 'open' });
      reassigned.push({ taskId, from: downAgentId, to: null });
    }
  }

  return reassigned;
}

function healthCheck(swarmRoot) {
  const agents = listAgents(swarmRoot);
  const now = Date.now();
  const report = {
    total: agents.length,
    healthy: 0,
    degraded: 0,
    down: 0,
    agents: [],
  };

  for (const agent of agents) {
    const lastSeen = new Date(agent.last_seen).getTime();
    const age = now - lastSeen;
    let health = 'healthy';

    if (agent.status === AGENT_STATUSES.CREDITS_EXHAUSTED || agent.status === AGENT_STATUSES.ERROR) {
      health = 'down';
      report.down++;
    } else if (agent.status === AGENT_STATUSES.OFFLINE || age > DEFAULT_OFFLINE_THRESHOLD) {
      health = 'down';
      report.down++;
    } else if (age > DEFAULT_OFFLINE_THRESHOLD / 2) {
      health = 'degraded';
      report.degraded++;
    } else {
      report.healthy++;
    }

    report.agents.push({
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      status: agent.status,
      health,
      last_seen_ago: Math.round(age / 1000) + 's',
      orphaned_tasks: getOrphanedTasks(swarmRoot, agent.id).length,
    });
  }

  return report;
}

module.exports = {
  register,
  updateStatus,
  heartbeat,
  getAgent,
  listAgents,
  pruneOffline,
  removeAgent,
  findByName,
  findByProvider,
  // Credit failover & health
  AGENT_STATUSES,
  reportCreditExhaustion,
  reportError,
  getOrphanedTasks,
  getFailoverCandidates,
  reassignOrphanedTasks,
  healthCheck,
};
