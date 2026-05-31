#!/usr/bin/env node
'use strict';

// swarm-cli — the command-line interface a CLI coding agent (Codex CLI, Gemini CLI,
// Claude Code, etc.) uses to operate the swarm WITHOUT any API key. The agent is the
// brain; this CLI is its hands. Every swarm action is one short command.
//
// Identity is resolved per repo clone: `join` writes .swarm/.run/agent.id; later
// commands default to it. Override with --as "<name>" or SWARM_AGENT_NAME.
//
// Usage:
//   node lib/swarm-cli.js <command> [args] [--as "Name"] [--root <path>] [--json]
//
// Run with no command (or `help`) for the full command list.

const path = require('path');
const fs = require('fs');

const reg  = require('./agent-registry');
const tm   = require('./task-manager');
const hi   = require('./hierarchy');
const mb    = require('./message-bus');
const orch  = require('./orchestrator');
let gitSync = null;
try { gitSync = require('./git-sync'); } catch (_) {}

// ─── arg parsing ────────────────────────────────────────────────────────────

function parse(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.flags.json = true;
    else if (a === '--as' && argv[i + 1]) out.flags.as = argv[++i];
    else if (a === '--root' && argv[i + 1]) out.flags.root = argv[++i];
    else if (a === '--provider' && argv[i + 1]) out.flags.provider = argv[++i];
    else if (a === '--priority' && argv[i + 1]) out.flags.priority = argv[++i];
    else if (a === '--tags' && argv[i + 1]) out.flags.tags = argv[++i];
    else if (a === '--no-sync') out.flags.noSync = true;
    else out._.push(a);
  }
  return out;
}

function findSwarmRoot(dir) {
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.swarm'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

// ─── identity ───────────────────────────────────────────────────────────────

function runDir(root) {
  const d = path.join(root, '.swarm', '.run');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const idPtr = (root) => path.join(runDir(root), 'agent.id');

function rememberAgent(root, id) {
  try { fs.writeFileSync(idPtr(root), id, 'utf-8'); } catch (_) {}
}

function resolveAgent(root, flags) {
  // 1. --as "Name"  2. SWARM_AGENT_NAME env  3. remembered id pointer
  const byName = flags.as || process.env.SWARM_AGENT_NAME;
  if (byName) {
    const a = reg.findByName(root, byName);
    if (a) return a;
  }
  try {
    const id = fs.readFileSync(idPtr(root), 'utf-8').trim();
    const a = reg.getAgent(root, id);
    if (a) return a;
  } catch (_) {}
  return null;
}

function requireAgent(root, flags) {
  const a = resolveAgent(root, flags);
  if (!a) {
    die('No identity. Run first:  node lib/swarm-cli.js join "Your-Name" caps,here');
  }
  return a;
}

// ─── git sync (best effort) ──────────────────────────────────────────────────

function pull(root) {
  if (!gitSync) return;
  try { if (gitSync.isGitRepo(root)) gitSync.pull(root, 1); } catch (_) {}
}
function pushSync(root, msg) {
  if (!gitSync) return;
  try { if (gitSync.isGitRepo(root) && gitSync.hasChanges(root)) gitSync.syncAndCommit(msg, root); } catch (_) {}
}

// ─── output ──────────────────────────────────────────────────────────────────

let JSON_OUT = false;
function out(human, obj) {
  if (JSON_OUT) process.stdout.write(JSON.stringify(obj !== undefined ? obj : { ok: true, message: human }) + '\n');
  else process.stdout.write(human + '\n');
}
function die(msg) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  else process.stderr.write('ERROR: ' + msg + '\n');
  process.exit(1);
}
const shortId = (id) => (id ? String(id).slice(0, 8) : '?');

function nameOf(root, id, cache) {
  if (!id) return 'none';
  if (cache && cache[id]) return cache[id];
  const a = reg.getAgent(root, id);
  return a ? a.name : shortId(id);
}

// ─── commands ─────────────────────────────────────────────────────────────────

const COMMANDS = {

  help() {
    out([
      'swarm-cli — operate the swarm (no API key needed).',
      '',
      'Bootstrap (once per repo, if .swarm/ does not exist yet):',
      '  init                        Create .swarm/ here',
      '',
      'First, join once (in each agent terminal):',
      '  join "<Name>" <caps>        Register/reuse this agent. e.g. join "Codex-Bob" backend,api',
      '',
      'See what to do:',
      '  status                      Team + tasks overview',
      '  inbox                       Your assigned tasks + unread messages (CHECK THIS)',
      '  next                        Best task for you to claim right now',
      '  tasks [status]              List tasks (open|assigned|in_progress|done)',
      '',
      'Do work:',
      '  claim <taskId>              Claim an open task',
      '  done <taskId> "<result>"    Finish a task — result MUST be your real output',
      '  create "<title>" [--priority high] [--tags a,b]',
      '  split <taskId> "<a>" "<b>"  Break a big task into subtasks',
      '',
      'Coordinate:',
      '  msg <name|id> "<text>"      Direct message another agent',
      '  broadcast "<text>"          Message the whole team',
      '  delegate                    (lead) hand out open tasks to best agents',
      '  assign <taskId> <name|id>   (lead) assign a task',
      '  lead [name]                 Make yourself (or name) the lead',
      '',
      'Sync:',
      '  sync                        git pull + push the .swarm state',
      '  whoami                      Show your identity',
      '',
      'Flags: --as "<Name>" (act as) · --root <path> · --json · --no-sync',
    ].join('\n'));
  },

  join(root, a, flags) {
    pull(root);
    const name = a._[0];
    if (!name) die('join needs a name:  join "Codex-Bob" backend,api');
    const caps = (a._[1] || flags.tags || '').split(',').map(s => s.trim()).filter(Boolean);
    const provider = flags.provider || process.env.SWARM_PROVIDER || 'cli';

    let agent = reg.findByName(root, name);
    if (agent) {
      if (caps.length) reg.updateStatus(root, agent.id, 'idle');
      reg.heartbeat(root, agent.id);
    } else {
      agent = reg.register(root, name, provider, caps, process.env.USER || 'cli');
    }
    rememberAgent(root, agent.id);

    // First agent becomes lead automatically.
    const h = hi.getHierarchy(root);
    if (!h || !h.lead) hi.setLead(root, agent.id);

    pushSync(root, `swarm: ${shortId(agent.id)} joined as ${name}`);
    out(`Joined as ${agent.name} (${shortId(agent.id)}) caps=[${(agent.capabilities||[]).join(',')}]${hi.isLead(root, agent.id) ? ' — you are LEAD' : ''}\nNext: run  node lib/swarm-cli.js inbox`,
        { ok: true, agent });
  },

  whoami(root, a, flags) {
    const me = requireAgent(root, flags);
    out(`${me.name} (${shortId(me.id)}) — ${me.status}, caps=[${(me.capabilities||[]).join(',')}]${hi.isLead(root, me.id) ? ', LEAD' : ''}`,
        { ok: true, agent: me });
  },

  status(root, a, flags) {
    pull(root);
    const agents = reg.listAgents(root);
    const stats = tm.getStats(root);
    const cache = {}; agents.forEach(x => cache[x.id] = x.name);
    const lines = [];
    lines.push(`Team (${agents.length}):`);
    for (const x of agents) {
      lines.push(`  ${hi.isLead(root, x.id) ? '★' : '·'} ${x.name} [${x.provider}] ${x.status}${x.current_task ? ' → ' + shortId(x.current_task) : ''}`);
    }
    lines.push(`Tasks: ${stats.open} open, ${stats.assigned} assigned, ${stats.in_progress} active, ${stats.done} done`);
    out(lines.join('\n'), { ok: true, agents, stats });
  },

  inbox(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const mine = orch.assignmentsFor(root, me.id);
    const msgs = mb.getUnread(root, me.id, null).slice(-10);
    const cache = {}; reg.listAgents(root).forEach(x => cache[x.id] = x.name);
    const lines = [`Inbox for ${me.name}:`];
    if (mine.length) {
      lines.push('  ASSIGNED TO YOU (work these):');
      for (const t of mine) lines.push(`    • [${t.priority}] "${t.title}" (${t.status}) id=${t.id}`);
    } else {
      lines.push('  No tasks assigned to you.');
    }
    if (msgs.length) {
      lines.push('  MESSAGES:');
      for (const m of msgs) {
        const tag = m.type === 'task_assignment' ? '[assignment] ' : '';
        lines.push(`    • ${nameOf(root, m.from, cache)}: ${tag}${(m.content||'').slice(0,140)}`);
      }
    }
    if (!mine.length && !msgs.length) lines.push('  (nothing — run `next` to find a task to claim)');
    out(lines.join('\n'), { ok: true, assigned: mine, messages: msgs });
  },

  next(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const mine = orch.assignmentsFor(root, me.id);
    if (mine.length) {
      const t = mine[0];
      out(`Work your assigned task:\n  [${t.priority}] "${t.title}" id=${t.id}\n  ${t.description||''}\n  When done:  node lib/swarm-cli.js done ${t.id} "<your result>"`,
          { ok: true, task: t, source: 'assigned' });
      return;
    }
    const best = tm.findBestTask(root, me.id);
    if (!best) { out('No matching open task. Stand by or `create` one.', { ok: true, task: null }); return; }
    out(`Best open task for you:\n  [${best.priority}] "${best.title}" id=${best.id}\n  Claim it:  node lib/swarm-cli.js claim ${best.id}`,
        { ok: true, task: best, source: 'open' });
  },

  tasks(root, a, flags) {
    pull(root);
    const filter = a._[0] ? { status: a._[0] } : undefined;
    const list = tm.listTasks(root, filter);
    const cache = {}; reg.listAgents(root).forEach(x => cache[x.id] = x.name);
    const lines = list.map(t => `  [${t.priority}] "${t.title}" ${t.status}${t.assigned_to ? ' <'+nameOf(root,t.assigned_to,cache)+'>' : ''} id=${t.id}`);
    out(lines.length ? lines.join('\n') : '  (no tasks)', { ok: true, tasks: list });
  },

  claim(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const taskId = a._[0]; if (!taskId) die('claim needs a task id');
    const res = tm.claimTask(root, taskId, me.id);
    if (!res.ok) die(res.error);
    reg.updateStatus(root, me.id, 'working', taskId);
    pushSync(root, `swarm: ${shortId(me.id)} claimed ${shortId(taskId)}`);
    out(`Claimed "${res.task.title}". Now do the work, then:\n  node lib/swarm-cli.js done ${taskId} "<your result>"`,
        { ok: true, task: res.task });
  },

  done(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const taskId = a._[0]; if (!taskId) die('done needs a task id');
    const result = a._[1];
    if (!result || result.length < 3) die('done needs a real result string: done <id> "what you actually produced"');
    const t = tm.getTask(root, taskId);
    if (!t) die('task not found: ' + taskId);
    tm.completeTask(root, taskId, result, []);
    reg.updateStatus(root, me.id, 'idle', null);
    mb.broadcast(root, me.id, mb.MSG_TYPES.STATUS_UPDATE, `Completed "${t.title}".`);
    pushSync(root, `swarm: ${shortId(me.id)} completed ${shortId(taskId)}`);
    out(`Done "${t.title}". Run \`next\` for more work.`, { ok: true, taskId });
  },

  create(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const title = a._[0]; if (!title) die('create needs a title');
    const tags = (flags.tags || '').split(',').map(s => s.trim()).filter(Boolean);
    const t = tm.createTask(root, title, a._[1] || '', {
      createdBy: me.id, priority: flags.priority || 'medium', tags,
    });
    pushSync(root, `swarm: ${shortId(me.id)} created task ${shortId(t.id)}`);
    out(`Created "${t.title}" id=${t.id} (${t.priority})`, { ok: true, task: t });
  },

  split(root, a, flags) {
    pull(root);
    requireAgent(root, flags);
    const taskId = a._[0]; if (!taskId) die('split needs a parent task id');
    const titles = a._.slice(1);
    if (!titles.length) die('split needs subtask titles: split <id> "A" "B" "C"');
    const subs = tm.splitTask(root, taskId, titles.map(t => ({ title: t })));
    if (!subs) die('parent task not found');
    pushSync(root, `swarm: split ${shortId(taskId)} into ${subs.length}`);
    out(`Split into ${subs.length} subtasks:\n` + subs.map(s => `  • "${s.title}" id=${s.id}`).join('\n'), { ok: true, subtasks: subs });
  },

  assign(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const taskId = a._[0], who = a._[1];
    if (!taskId || !who) die('assign needs: assign <taskId> <name|id>');
    const target = reg.findByName(root, who) || reg.getAgent(root, who);
    if (!target) die('agent not found: ' + who);
    tm.assignTask(root, taskId, target.id);
    const t = tm.getTask(root, taskId);
    mb.assignWork(root, me.id, target.id, taskId, orch.buildAssignmentPrompt(t));
    pushSync(root, `swarm: assigned ${shortId(taskId)} → ${target.name}`);
    out(`Assigned "${t.title}" → ${target.name}`, { ok: true });
  },

  delegate(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const res = orch.distribute(root, me.id);
    if (!res.ok) die(res.reason === 'not_lead' ? 'only the lead can delegate (run `lead` first)' : res.reason);
    pushSync(root, `swarm: ${shortId(me.id)} delegated ${res.assignments.length}`);
    out(res.assignments.length
      ? 'Delegated:\n' + res.assignments.map(x => `  • "${x.title}" → ${x.agentName}`).join('\n')
      : 'No open tasks to delegate (or no free agents).', { ok: true, assignments: res.assignments });
  },

  msg(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const who = a._[0], text = a._[1];
    if (!who || !text) die('msg needs: msg <name|id> "text"');
    const target = reg.findByName(root, who) || reg.getAgent(root, who);
    if (!target) die('agent not found: ' + who);
    mb.send(root, me.id, target.id, 'chat', text);
    pushSync(root, `swarm: msg → ${target.name}`);
    out(`Sent to ${target.name}.`, { ok: true });
  },

  broadcast(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const text = a._[0];
    if (!text) die('broadcast needs: broadcast "text"');
    mb.broadcast(root, me.id, 'chat', text);
    pushSync(root, `swarm: broadcast`);
    out('Broadcast sent.', { ok: true });
  },

  lead(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const who = a._[0];
    const target = who ? (reg.findByName(root, who) || reg.getAgent(root, who)) : me;
    if (!target) die('agent not found: ' + who);
    hi.setLead(root, target.id);
    pushSync(root, `swarm: lead = ${target.name}`);
    out(`${target.name} is now the lead.`, { ok: true });
  },

  sync(root) {
    if (!gitSync || !gitSync.isGitRepo(root)) { out('Not a git repo — git sync skipped (local-only mode).', { ok: true }); return; }
    gitSync.pull(root, 2);
    const r = gitSync.syncAndCommit('swarm: cli sync', root);
    out(r.ok ? 'Synced.' : 'Sync issue: ' + (r.error || 'unknown'), { ok: !!r.ok });
  },

  init(root) {
    const yaml = require('./yaml');
    const base = path.join(root, '.swarm');
    for (const d of ['agents', 'tasks', 'claims', 'messages', 'escalations']) {
      fs.mkdirSync(path.join(base, d), { recursive: true });
    }
    const cfgPath = path.join(base, 'config.yaml');
    if (!fs.existsSync(cfgPath)) {
      fs.writeFileSync(cfgPath, yaml.serialize({
        project: path.basename(root),
        created_at: new Date().toISOString(),
        transport: 'git',
        sync_interval: 15,
        max_tasks_per_agent: 3,
      }) + '\n', 'utf-8');
    }
    if (!fs.existsSync(path.join(base, 'hierarchy.yaml'))) hi.initHierarchy(root, null);
    out(`Initialized swarm at ${root}\nNext:  node lib/swarm-cli.js join "Your-Name" your,caps`,
        { ok: true, root });
  },
};

// ─── main ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const a = parse(argv);
  JSON_OUT = !!a.flags.json;
  const cmd = a._.shift() || 'help';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { COMMANDS.help(); return; }

  // `init` creates .swarm/ — handle before the existence guard.
  if (cmd === 'init') {
    const root = a.flags.root || process.cwd();
    try { COMMANDS.init(root, a, a.flags); } catch (err) { die(err.message); }
    return;
  }

  const root = a.flags.root || findSwarmRoot(process.cwd());
  if (!root || !fs.existsSync(path.join(root, '.swarm'))) {
    die('No .swarm/ found. Run:  node lib/swarm-cli.js init   (or `/swarm init` in Claude)');
  }

  const fn = COMMANDS[cmd];
  if (!fn) die(`unknown command: ${cmd}. Run \`help\`.`);

  try {
    fn(root, a, a.flags);
  } catch (err) {
    die(err.message);
  }
}

main();
