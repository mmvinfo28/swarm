'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('./yaml');
const agentRegistry = require('./agent-registry');

const HIERARCHY_FILE = 'hierarchy.yaml';

function hierarchyPath(swarmRoot) {
  return path.join(swarmRoot, '.swarm', HIERARCHY_FILE);
}

function initHierarchy(swarmRoot, leadId) {
  const roles = {};
  if (leadId) roles[leadId] = 'lead';
  const hierarchy = {
    lead: leadId || null,
    roles,
    sub_teams: [],
    updated_at: new Date().toISOString(),
  };

  fs.writeFileSync(hierarchyPath(swarmRoot), yaml.serialize(hierarchy) + '\n', 'utf-8');
  return hierarchy;
}

function getHierarchy(swarmRoot) {
  const filePath = hierarchyPath(swarmRoot);
  if (!fs.existsSync(filePath)) return null;
  return yaml.parse(fs.readFileSync(filePath, 'utf-8'));
}

function setLead(swarmRoot, agentId) {
  let h = getHierarchy(swarmRoot);
  if (!h) h = initHierarchy(swarmRoot, agentId);
  h.lead = agentId;
  h.updated_at = new Date().toISOString();
  if (!h.roles) h.roles = {};
  h.roles[agentId] = 'lead';
  fs.writeFileSync(hierarchyPath(swarmRoot), yaml.serialize(h) + '\n', 'utf-8');
  return h;
}

function assignRole(swarmRoot, agentId, role) {
  const validRoles = ['lead', 'developer', 'reviewer', 'tester', 'architect'];
  if (!validRoles.includes(role)) return null;

  let h = getHierarchy(swarmRoot);
  if (!h) h = initHierarchy(swarmRoot);
  if (!h.roles) h.roles = {};
  h.roles[agentId] = role;
  h.updated_at = new Date().toISOString();

  if (role === 'lead') h.lead = agentId;

  fs.writeFileSync(hierarchyPath(swarmRoot), yaml.serialize(h) + '\n', 'utf-8');
  return h;
}

function getRole(swarmRoot, agentId) {
  const h = getHierarchy(swarmRoot);
  if (!h || !h.roles) return null;
  return h.roles[agentId] || null;
}

function autoElectLead(swarmRoot) {
  const agents = agentRegistry.listAgents(swarmRoot)
    .filter(a => a.status !== 'offline');

  if (agents.length === 0) return null;

  agents.sort((a, b) => {
    const aCaps = (a.capabilities || []).length;
    const bCaps = (b.capabilities || []).length;
    if (bCaps !== aCaps) return bCaps - aCaps;
    return new Date(a.joined_at) - new Date(b.joined_at);
  });

  const elected = agents[0];
  setLead(swarmRoot, elected.id);
  return elected;
}

function createSubTeam(swarmRoot, name, members) {
  let h = getHierarchy(swarmRoot);
  if (!h) h = initHierarchy(swarmRoot);
  if (!h.sub_teams) h.sub_teams = [];

  const team = { name, members: members || [], created_at: new Date().toISOString() };
  h.sub_teams.push(team);
  h.updated_at = new Date().toISOString();

  fs.writeFileSync(hierarchyPath(swarmRoot), yaml.serialize(h) + '\n', 'utf-8');
  return team;
}

function getTeamMembers(swarmRoot) {
  const h = getHierarchy(swarmRoot);
  const agents = agentRegistry.listAgents(swarmRoot);
  if (!h || !h.roles) {
    return agents.map(a => ({ ...a, role: 'developer' }));
  }

  return agents.map(a => ({
    ...a,
    role: h.roles[a.id] || 'developer',
  }));
}

function syncAgentToHierarchy(swarmRoot, agentId, role) {
  let h = getHierarchy(swarmRoot);
  if (!h) h = initHierarchy(swarmRoot);
  if (!h.roles) h.roles = {};
  h.roles[agentId] = role || 'developer';
  if (role === 'lead') h.lead = agentId;

  // Clean stale entries: remove agent IDs from roles that no longer exist on disk.
  const agents = agentRegistry.listAgents(swarmRoot);
  const agentIds = new Set(agents.map(a => a.id));
  for (const id of Object.keys(h.roles)) {
    if (!agentIds.has(id)) delete h.roles[id];
  }

  h.updated_at = new Date().toISOString();
  fs.writeFileSync(hierarchyPath(swarmRoot), yaml.serialize(h) + '\n', 'utf-8');
  return h;
}

function isLead(swarmRoot, agentId) {
  const h = getHierarchy(swarmRoot);
  return h && h.lead === agentId;
}

module.exports = {
  initHierarchy,
  getHierarchy,
  setLead,
  assignRole,
  getRole,
  autoElectLead,
  createSubTeam,
  getTeamMembers,
  isLead,
  syncAgentToHierarchy,
};
