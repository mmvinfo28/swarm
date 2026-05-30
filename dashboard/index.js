#!/usr/bin/env node
'use strict';

const blessed = require('blessed');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

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
const gitSync = require(path.join(libDir, 'git-sync'));

function findSwarmRoot(dir) {
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.swarm'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

const HELP = ' q:quit  r:refresh  Tab:panel  arrows:scroll  g:git-pull';

// --- Screen ---

const screen = blessed.screen({
  smartCSR: true,
  title: 'Swarm Dashboard',
  fullUnicode: true,
  dockBorders: true,
});

// --- Widgets (created with placeholder dimensions; applyLayout() fixes them) ---

const header = blessed.box({
  parent: screen,
  top: 0, left: 0,
  width: '100%', height: 3,
  tags: true,
  style: { fg: 'white', bg: 'blue', bold: true },
  content: ' SWARM',
});

const teamPanel = blessed.box({
  parent: screen,
  label: ' Team ',
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'cyan' }, label: { fg: 'cyan' } },
  scrollable: true, mouse: true, keys: true, vi: true,
  padding: { left: 1, right: 1 },
  alwaysScroll: true,
});

const taskPanel = blessed.box({
  parent: screen,
  label: ' Tasks ',
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'yellow' }, label: { fg: 'yellow' } },
  scrollable: true, mouse: true, keys: true, vi: true,
  padding: { left: 1, right: 1 },
  alwaysScroll: true,
});

const agentPanel = blessed.box({
  parent: screen,
  label: ' Agents ',
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'green' }, label: { fg: 'green' } },
  scrollable: true, mouse: true, keys: true, vi: true,
  padding: { left: 1, right: 1 },
  alwaysScroll: true,
});

const msgPanel = blessed.box({
  parent: screen,
  label: ' Messages ',
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'magenta' }, label: { fg: 'magenta' } },
  scrollable: true, mouse: true, keys: true, vi: true,
  padding: { left: 1, right: 1 },
  alwaysScroll: true,
});

const statusBar = blessed.box({
  parent: screen,
  bottom: 0, left: 0,
  width: '100%', height: 1,
  tags: true,
  style: { fg: 'black', bg: 'white' },
  content: HELP,
});

// --- Layout engine ---
// Compute absolute positions instead of using blessed string-arithmetic
// which is unreliable across versions.

function applyLayout() {
  const h = screen.height;
  const w = screen.width;

  const contentTop = 3;              // rows below header
  const contentBottom = h - 1;      // row above status bar
  const contentHeight = contentBottom - contentTop;  // usable rows

  const topH = Math.floor(contentHeight / 2);
  const botH = contentHeight - topH;
  const botTop = contentTop + topH;

  const leftW = Math.floor(w * 0.4);
  const rightW = w - leftW;

  header.width = w;

  teamPanel.top    = contentTop; teamPanel.left   = 0;
  teamPanel.width  = leftW;      teamPanel.height = topH;

  taskPanel.top    = contentTop; taskPanel.left   = leftW;
  taskPanel.width  = rightW;     taskPanel.height = topH;

  agentPanel.top   = botTop;     agentPanel.left  = 0;
  agentPanel.width = leftW;      agentPanel.height = botH;

  msgPanel.top     = botTop;     msgPanel.left    = leftW;
  msgPanel.width   = rightW;     msgPanel.height  = botH;

  statusBar.width = w;
}

screen.on('resize', () => {
  applyLayout();
  refresh();
});

// --- Data helpers ---

function loadConfig() {
  try {
    const p = path.join(swarmRoot, '.swarm', 'config.yaml');
    return fs.existsSync(p) ? yaml.parse(fs.readFileSync(p, 'utf-8')) || {} : {};
  } catch (_) { return {}; }
}

// --- Render functions ---

function renderHeader() {
  const config = loadConfig();
  const agents = agentRegistry.listAgents(swarmRoot);
  const stats = taskManager.getStats(swarmRoot);
  const online = agents.filter(a => a.status !== 'offline' && a.status !== 'credits_exhausted').length;

  header.setContent(
    `  SWARM  |  ${config.project || path.basename(swarmRoot)}` +
    `  |  Agents: ${online}/${agents.length}` +
    `  |  Tasks: ${stats.open} open  ${stats.in_progress} active  ${stats.done} done` +
    `  |  ${new Date().toLocaleTimeString()}`
  );
}

function renderTeam() {
  const members = hierarchy.getTeamMembers(swarmRoot);
  if (!members.length) {
    teamPanel.setContent('{grey-fg}No agents registered{/}');
    return;
  }

  const statusIcon = {
    idle:              '{green-fg}[idle]{/}',
    working:           '{blue-fg}[work]{/}',
    reviewing:         '{yellow-fg}[rev]{/}',
    offline:           '{grey-fg}[off]{/}',
    credits_exhausted: '{red-fg}[$$!]{/}',
    error:             '{red-fg}[err]{/}',
  };

  const groups = [
    { label: '== Lead ==',       filter: m => m.role === 'lead'      },
    { label: '== Developers ==', filter: m => m.role === 'developer' },
    { label: '== Reviewers ==',  filter: m => m.role === 'reviewer'  },
    { label: '== Testers ==',    filter: m => m.role === 'tester'    },
    { label: '== Other ==',      filter: m => !['lead','developer','reviewer','tester'].includes(m.role) },
  ];

  const lines = [];
  for (const g of groups) {
    const members2 = members.filter(g.filter);
    if (!members2.length) continue;
    lines.push(`{bold}${g.label}{/}`);
    for (const a of members2) {
      const icon = statusIcon[a.status] || '{grey-fg}[?]{/}';
      const task = a.current_task ? `  -> ${a.current_task.slice(0, 8)}` : '';
      const caps = (a.capabilities || []).slice(0, 3).join(',');
      lines.push(`  ${icon} {bold}${a.name}{/} {grey-fg}[${a.provider}]${caps ? ' ' + caps : ''}${task}{/}`);
    }
  }

  teamPanel.setContent(lines.join('\n'));
}

function renderTasks() {
  const all = taskManager.listTasks(swarmRoot);
  const agents = agentRegistry.listAgents(swarmRoot);
  const agentMap = {};
  agents.forEach(a => { agentMap[a.id] = a.name; });

  const open   = all.filter(t => t.status === 'open');
  const active = all.filter(t => t.status === 'in_progress' || t.status === 'assigned');
  const done   = all.filter(t => t.status === 'done');
  const split  = all.filter(t => t.status === 'split');

  const priColor = { critical: '{red-fg}', high: '{yellow-fg}', medium: '{white-fg}', low: '{grey-fg}' };
  const lines = [];

  function fmt(t) {
    const pc = priColor[t.priority] || '';
    const prio = `${pc}[${(t.priority || 'med').slice(0, 4)}]{/}`;
    const who  = t.assigned_to ? ` {cyan-fg}<${agentMap[t.assigned_to] || t.assigned_to.slice(0, 8)}>{/}` : '';
    const tags = (t.tags || []).length ? ` {grey-fg}(${t.tags.slice(0, 3).join(',')}){/}` : '';
    return `  ${prio} ${t.title}${who}${tags}`;
  }

  if (open.length) {
    lines.push(`{bold}{white-fg}Open (${open.length}){/}`);
    open.forEach(t => lines.push(fmt(t)));
  }
  if (active.length) {
    lines.push(`{bold}{blue-fg}Active (${active.length}){/}`);
    active.forEach(t => lines.push(fmt(t)));
  }
  if (split.length) {
    lines.push(`{bold}{yellow-fg}Split (${split.length}){/}`);
    split.forEach(t => lines.push(fmt(t)));
  }
  if (done.length) {
    lines.push(`{bold}{green-fg}Done (${done.length}){/}`);
    done.slice(-8).forEach(t => lines.push(fmt(t)));
    if (done.length > 8) lines.push(`  {grey-fg}...and ${done.length - 8} more{/}`);
  }
  if (!all.length) lines.push('{grey-fg}No tasks{/}');

  taskPanel.setContent(lines.join('\n'));
}

function renderAgents() {
  const health = agentRegistry.healthCheck(swarmRoot);
  const lines = [];

  for (const a of health.agents) {
    const hc = { healthy: '{green-fg}OK {/}', degraded: '{yellow-fg}DEG{/}', down: '{red-fg}DWN{/}' };
    const icon = hc[a.health] || '{grey-fg}??{/}';
    lines.push(`${icon} {bold}${a.name}{/} {grey-fg}(${a.provider}){/}`);
    lines.push(`      ${a.status}  |  seen: ${a.last_seen_ago} ago`);
    if (a.orphaned_tasks > 0) lines.push(`      {red-fg}! ${a.orphaned_tasks} orphaned task(s){/}`);
    lines.push('');
  }

  if (!health.agents.length) lines.push('{grey-fg}No agents{/}');
  agentPanel.setContent(lines.join('\n'));
}

function renderMessages() {
  const msgs = messageBus.getMessages(swarmRoot, { limit: 30 });
  const agents = agentRegistry.listAgents(swarmRoot);
  const agentMap = {};
  agents.forEach(a => { agentMap[a.id] = a.name; });

  const lines = [];

  const escs = agentLoop.getPendingEscalations(swarmRoot);
  if (escs.length > 0) {
    lines.push(`{bold}{red-fg}! ${escs.length} ESCALATION(S) PENDING{/}`);
    for (const e of escs.slice(0, 3)) {
      const sc = { high: '{red-fg}', medium: '{yellow-fg}', low: '{green-fg}' };
      lines.push(`  ${sc[e.severity] || ''}[${e.severity}]{/} ${(e.message_content || '').slice(0, 55)}`);
    }
    lines.push('');
  }

  if (!msgs.length) {
    lines.push('{grey-fg}No messages{/}');
  } else {
    const typeIcon = {
      chat: '>',  help_request: '?',  knowledge_share: '*',
      task_handoff: '~',  credit_alert: '!',  status_update: 'i',
      auto_reply: '<',  priority_change: '^',
    };
    for (const m of msgs) {
      const from = agentMap[m.from] || (m.from || '?').slice(0, 8);
      const to   = m.to === 'broadcast' ? 'ALL' : (agentMap[m.to] || (m.to || '?').slice(0, 8));
      const t    = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
      const icon = typeIcon[m.type] || '?';
      const body = (m.content || '').slice(0, 60);
      lines.push(`{grey-fg}${t}{/} ${icon} {cyan-fg}${from}{/}->{magenta-fg}${to}{/}: ${body}`);
    }
  }

  msgPanel.setContent(lines.join('\n'));
  msgPanel.setScrollPerc(100);
}

// --- Refresh ---

function refresh() {
  try {
    renderHeader();
    renderTeam();
    renderTasks();
    renderAgents();
    renderMessages();
    screen.render();
  } catch (err) {
    statusBar.setContent(` {red-fg}Render error: ${err.message}{/}`);
    screen.render();
  }
}

let pullInProgress = false;

function gitPullThenRefresh(onDone) {
  if (pullInProgress) {
    refresh();
    if (onDone) onDone();
    return;
  }

  if (!gitSync.isGitRepo(swarmRoot)) {
    refresh();
    if (onDone) onDone();
    return;
  }

  pullInProgress = true;
  execFile('git', ['pull', '--rebase', '--autostash'], {
    cwd: swarmRoot,
    timeout: 12000,
  }, (err) => {
    pullInProgress = false;
    refresh();
    if (onDone) onDone();
  });
}

// --- Panel focus cycling ---

const panels = [teamPanel, taskPanel, agentPanel, msgPanel];
const panelColors = ['cyan', 'yellow', 'green', 'magenta'];
let focusIdx = 0;

function focusPanel(idx) {
  panels[focusIdx].style.border.fg = panelColors[focusIdx];
  focusIdx = (idx + panels.length) % panels.length;
  panels[focusIdx].style.border.fg = 'white';
  panels[focusIdx].focus();
  screen.render();
}

// --- Keybindings ---

screen.key(['q', 'C-c'], () => process.exit(0));

screen.key(['r'], () => {
  statusBar.setContent(' {yellow-fg}Pulling and refreshing...{/}');
  screen.render();
  gitPullThenRefresh(() => {
    statusBar.setContent(HELP);
    screen.render();
  });
});

screen.key(['g'], () => {
  statusBar.setContent(' {yellow-fg}Git pull...{/}');
  screen.render();
  gitPullThenRefresh(() => {
    statusBar.setContent(HELP);
    screen.render();
  });
});

screen.key(['tab'], () => focusPanel(focusIdx + 1));
screen.key(['S-tab'], () => focusPanel(focusIdx - 1));

// Scrolling the focused panel
screen.key(['up', 'k'],    () => { panels[focusIdx].scroll(-1); screen.render(); });
screen.key(['down', 'j'],  () => { panels[focusIdx].scroll(1);  screen.render(); });
screen.key(['pageup'],     () => { panels[focusIdx].scroll(-10); screen.render(); });
screen.key(['pagedown'],   () => { panels[focusIdx].scroll(10);  screen.render(); });

// --- Start ---

applyLayout();
focusPanel(0);
refresh();

// Auto-refresh every 5s (pull every 30s to avoid hammering git)
let pollCount = 0;
const pollTimer = setInterval(() => {
  pollCount++;
  if (pollCount % 6 === 0) {
    // Every 30s: pull + refresh
    gitPullThenRefresh(null);
  } else {
    // Every 5s: local refresh only
    refresh();
  }
}, 5000);

process.on('exit', () => clearInterval(pollTimer));
process.on('SIGTERM', () => process.exit(0));
