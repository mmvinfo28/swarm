#!/usr/bin/env node
'use strict';

const blessed = require('blessed');
const path = require('path');
const fs = require('fs');

// Resolve swarm root from argv or cwd
const swarmRoot = process.argv[2] || findSwarmRoot(process.cwd());
if (!swarmRoot) {
  console.error('Error: not inside a swarm repo. Run from a directory with .swarm/ or pass path as argument.');
  process.exit(1);
}

const libDir = path.join(__dirname, '..', 'lib');
const yaml = require(path.join(libDir, 'yaml'));
const agentRegistry = require(path.join(libDir, 'agent-registry'));
const taskManager = require(path.join(libDir, 'task-manager'));
const messageBus = require(path.join(libDir, 'message-bus'));
const hierarchy = require(path.join(libDir, 'hierarchy'));
const agentLoop = require(path.join(libDir, 'agent-loop'));

function findSwarmRoot(dir) {
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.swarm'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

// --- Screen setup ---

const screen = blessed.screen({
  smartCSR: true,
  title: 'Swarm Dashboard',
  fullUnicode: true,
});

// --- Header ---

const header = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: '100%',
  height: 3,
  tags: true,
  style: { fg: 'white', bg: 'blue' },
  content: '',
});

// --- Team Tree (top-left) ---

const teamPanel = blessed.box({
  parent: screen,
  top: 3,
  left: 0,
  width: '40%',
  height: '45%-1',
  label: ' {bold}Team{/bold} ',
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } },
  scrollable: true,
  alwaysScroll: true,
  keys: true,
  vi: true,
});

// --- Task Board (top-right) ---

const taskPanel = blessed.box({
  parent: screen,
  top: 3,
  left: '40%',
  width: '60%',
  height: '45%-1',
  label: ' {bold}Tasks{/bold} ',
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'yellow' }, label: { fg: 'yellow', bold: true } },
  scrollable: true,
  alwaysScroll: true,
  keys: true,
  vi: true,
});

// --- Agent Status (bottom-left) ---

const agentPanel = blessed.box({
  parent: screen,
  top: '45%+2',
  left: 0,
  width: '40%',
  height: '55%-4',
  label: ' {bold}Agent Status{/bold} ',
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'green' }, label: { fg: 'green', bold: true } },
  scrollable: true,
  alwaysScroll: true,
  keys: true,
  vi: true,
});

// --- Message Log (bottom-right) ---

const msgPanel = blessed.box({
  parent: screen,
  top: '45%+2',
  left: '40%',
  width: '60%',
  height: '55%-4',
  label: ' {bold}Messages{/bold} ',
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'magenta' }, label: { fg: 'magenta', bold: true } },
  scrollable: true,
  alwaysScroll: true,
  keys: true,
  vi: true,
});

// --- Status bar ---

const statusBar = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: '100%',
  height: 1,
  tags: true,
  style: { fg: 'black', bg: 'white' },
  content: ' {bold}q{/bold}:quit  {bold}r{/bold}:refresh  {bold}Tab{/bold}:switch panel  {bold}↑↓{/bold}:scroll',
});

// --- Data rendering ---

function renderHeader() {
  const config = loadConfig();
  const agents = agentRegistry.listAgents(swarmRoot);
  const stats = taskManager.getStats(swarmRoot);
  const online = agents.filter(a => a.status !== 'offline' && a.status !== 'credits_exhausted').length;

  header.setContent(
    `  {bold}SWARM{/bold} — ${config.project || path.basename(swarmRoot)}` +
    `  │  Agents: {green-fg}${online}{/} / ${agents.length}` +
    `  │  Tasks: {yellow-fg}${stats.open}{/} open  {blue-fg}${stats.in_progress}{/} active  {green-fg}${stats.done}{/} done` +
    `  │  Last sync: ${new Date().toLocaleTimeString()}`
  );
}

function renderTeam() {
  const members = hierarchy.getTeamMembers(swarmRoot);
  const h = hierarchy.getHierarchy(swarmRoot);
  const lines = [];

  if (!members.length) {
    teamPanel.setContent('{grey-fg}No agents registered{/}');
    return;
  }

  // Group by role
  const lead = members.filter(m => m.role === 'lead');
  const devs = members.filter(m => m.role === 'developer');
  const reviewers = members.filter(m => m.role === 'reviewer');
  const testers = members.filter(m => m.role === 'tester');

  function formatAgent(a) {
    const statusIcon = {
      idle: '{green-fg}●{/}',
      working: '{blue-fg}▶{/}',
      reviewing: '{yellow-fg}◆{/}',
      offline: '{grey-fg}○{/}',
      credits_exhausted: '{red-fg}✕{/}',
      error: '{red-fg}!{/}',
    };
    const icon = statusIcon[a.status] || '{grey-fg}?{/}';
    const task = a.current_task ? ` → ${a.current_task.slice(0, 8)}` : '';
    return `${icon} ${a.name} {grey-fg}(${a.provider})${task}{/}`;
  }

  if (lead.length) {
    lines.push('{bold}{yellow-fg}👑 Lead{/}');
    lead.forEach(a => lines.push('  ' + formatAgent(a)));
  }
  if (devs.length) {
    lines.push('{bold}💻 Developers{/}');
    devs.forEach(a => lines.push('  ' + formatAgent(a)));
  }
  if (reviewers.length) {
    lines.push('{bold}🔍 Reviewers{/}');
    reviewers.forEach(a => lines.push('  ' + formatAgent(a)));
  }
  if (testers.length) {
    lines.push('{bold}🧪 Testers{/}');
    testers.forEach(a => lines.push('  ' + formatAgent(a)));
  }

  teamPanel.setContent(lines.join('\n'));
}

function renderTasks() {
  const all = taskManager.listTasks(swarmRoot);
  const agents = agentRegistry.listAgents(swarmRoot);
  const agentMap = {};
  agents.forEach(a => { agentMap[a.id] = a.name; });

  const open = all.filter(t => t.status === 'open');
  const active = all.filter(t => t.status === 'in_progress' || t.status === 'assigned');
  const done = all.filter(t => t.status === 'done');
  const lines = [];

  const priIcon = { critical: '{red-fg}‼{/}', high: '{yellow-fg}!{/}', medium: '{white-fg}·{/}', low: '{grey-fg}·{/}' };

  function formatTask(t) {
    const pi = priIcon[t.priority] || ' ';
    const assignee = t.assigned_to ? ` {cyan-fg}[${agentMap[t.assigned_to] || t.assigned_to.slice(0, 8)}]{/}` : '';
    return `  ${pi} ${t.title}${assignee}`;
  }

  if (open.length) {
    lines.push(`{bold}{white-fg}⚪ Open (${open.length}){/}`);
    open.forEach(t => lines.push(formatTask(t)));
  }
  if (active.length) {
    lines.push(`{bold}{blue-fg}🔵 In Progress (${active.length}){/}`);
    active.forEach(t => lines.push(formatTask(t)));
  }
  if (done.length) {
    lines.push(`{bold}{green-fg}✅ Done (${done.length}){/}`);
    done.slice(-10).forEach(t => lines.push(formatTask(t)));
    if (done.length > 10) lines.push(`  {grey-fg}... and ${done.length - 10} more{/}`);
  }

  if (all.length === 0) {
    lines.push('{grey-fg}No tasks yet{/}');
  }

  taskPanel.setContent(lines.join('\n'));
}

function renderAgents() {
  const health = agentRegistry.healthCheck(swarmRoot);
  const lines = [];

  for (const a of health.agents) {
    const healthIcon = { healthy: '{green-fg}●{/}', degraded: '{yellow-fg}◐{/}', down: '{red-fg}●{/}' };
    const icon = healthIcon[a.health] || '{grey-fg}?{/}';
    lines.push(`${icon} {bold}${a.name}{/} {grey-fg}(${a.provider}){/}`);
    lines.push(`    Status: ${a.status}  │  Last seen: ${a.last_seen_ago} ago`);
    if (a.orphaned_tasks > 0) {
      lines.push(`    {red-fg}⚠ ${a.orphaned_tasks} orphaned task(s){/}`);
    }
    lines.push('');
  }

  if (health.agents.length === 0) {
    lines.push('{grey-fg}No agents{/}');
  }

  agentPanel.setContent(lines.join('\n'));
}

function renderMessages() {
  const msgs = messageBus.getMessages(swarmRoot, { limit: 20 });
  const agents = agentRegistry.listAgents(swarmRoot);
  const agentMap = {};
  agents.forEach(a => { agentMap[a.id] = a.name; });

  const lines = [];

  // Also check escalations
  const escs = agentLoop.getPendingEscalations(swarmRoot);
  if (escs.length > 0) {
    lines.push(`{bold}{red-fg}🔔 ${escs.length} PENDING ESCALATION(S){/}`);
    for (const e of escs.slice(0, 3)) {
      const severity = { high: '{red-fg}', medium: '{yellow-fg}', low: '{green-fg}' };
      lines.push(`  ${severity[e.severity] || ''}[${e.severity}]{/} ${(e.message_content || '').slice(0, 60)}`);
    }
    lines.push('');
  }

  if (msgs.length === 0) {
    lines.push('{grey-fg}No messages yet{/}');
  } else {
    for (const m of msgs) {
      const from = agentMap[m.from] || (m.from || '?').slice(0, 8);
      const to = m.to === 'broadcast' ? 'all' : (agentMap[m.to] || (m.to || '?').slice(0, 8));
      const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
      const typeIcon = {
        chat: '💬', help_request: '❓', knowledge_share: '📚',
        task_handoff: '🔄', credit_alert: '🔴', status_update: 'ℹ',
        auto_reply: '↩', priority_change: '⚡',
      };
      const icon = typeIcon[m.type] || '📩';
      lines.push(`{grey-fg}${time}{/} ${icon} {cyan-fg}${from}{/}→{magenta-fg}${to}{/}: ${(m.content || '').slice(0, 70)}`);
    }
  }

  msgPanel.setContent(lines.join('\n'));
}

function loadConfig() {
  try {
    const configPath = path.join(swarmRoot, '.swarm', 'config.yaml');
    if (!fs.existsSync(configPath)) return {};
    return yaml.parse(fs.readFileSync(configPath, 'utf-8')) || {};
  } catch (_) {
    return {};
  }
}

function refresh() {
  try {
    renderHeader();
    renderTeam();
    renderTasks();
    renderAgents();
    renderMessages();
    screen.render();
  } catch (err) {
    statusBar.setContent(` {red-fg}Error: ${err.message}{/}`);
    screen.render();
  }
}

// --- Git pull + refresh ---

let lastHash = null;
let pullInProgress = false;

function pullAndRefresh() {
  // Skip if a pull is already running (prevent queue-up)
  if (pullInProgress) {
    refresh(); // still refresh local state
    return;
  }

  const { execFile } = require('child_process');
  const gitSync = require(path.join(libDir, 'git-sync'));

  if (!gitSync.isGitRepo(swarmRoot)) {
    refresh();
    return;
  }

  // Async git pull — doesn't block blessed event loop
  pullInProgress = true;
  execFile('git', ['pull', '--rebase', '--autostash'], {
    cwd: swarmRoot,
    timeout: 10000,
  }, (err) => {
    pullInProgress = false;
    try {
      const newHash = gitSync.getLastCommitHash(swarmRoot);
      if (newHash !== lastHash || !lastHash) {
        lastHash = newHash;
        refresh();
      }
    } catch (_) {
      refresh();
    }
  });

  // Also refresh local state immediately (don't wait for pull)
  try {
    const newHash = gitSync.getLastCommitHash(swarmRoot);
    if (newHash !== lastHash || !lastHash) {
      lastHash = newHash;
      refresh();
    }
  } catch (_) {
    refresh();
  }
}

// --- Keybindings ---

const panels = [teamPanel, taskPanel, agentPanel, msgPanel];
let activePanel = 0;
panels[0].style.border.fg = 'white';

screen.key(['q', 'C-c'], () => process.exit(0));

screen.key(['r'], () => {
  statusBar.setContent(' {yellow-fg}Refreshing...{/}');
  screen.render();
  pullAndRefresh();
  statusBar.setContent(' {bold}q{/bold}:quit  {bold}r{/bold}:refresh  {bold}Tab{/bold}:switch panel  {bold}↑↓{/bold}:scroll');
});

screen.key(['tab'], () => {
  // Reset old panel border color
  const colors = ['cyan', 'yellow', 'green', 'magenta'];
  panels[activePanel].style.border.fg = colors[activePanel];
  // Move to next
  activePanel = (activePanel + 1) % panels.length;
  panels[activePanel].style.border.fg = 'white';
  panels[activePanel].focus();
  screen.render();
});

// --- Start ---

refresh();
const pollInterval = setInterval(pullAndRefresh, 5000);

process.on('exit', () => clearInterval(pollInterval));
