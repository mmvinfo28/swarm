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
const ioBus = require('./io-bus');
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
    else if ((a === '--deps' || a === '--after') && argv[i + 1]) out.flags.deps = argv[++i];
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

// Bug #2: volatile runtime state that must never be committed (noisy diffs + pid/log
// merge conflicts across machines). Adds missing entries to the repo's .gitignore and
// best-effort untracks anything already committed.
const SWARM_GITIGNORE = [
  '# swarm runtime state (do not commit)',
  '.swarm/.run/',
  '.swarm/.server-url',
  '.swarm/.stopped',
  '*.pid',
  '*.log',
];

function ensureGitignore(root) {
  try {
    const gi = path.join(root, '.gitignore');
    let cur = '';
    try { cur = fs.readFileSync(gi, 'utf-8'); } catch (_) {}
    const have = new Set(cur.split(/\r?\n/).map(s => s.trim()));
    const add = SWARM_GITIGNORE.filter(l => l.startsWith('#') ? false : !have.has(l));
    if (add.length) {
      const block = (cur && !cur.endsWith('\n') ? '\n' : '') +
        (cur.includes('# swarm runtime') ? '' : '\n' + SWARM_GITIGNORE[0] + '\n') +
        add.join('\n') + '\n';
      fs.appendFileSync(gi, block, 'utf-8');
    }
    // Untrack runtime files that slipped in before the ignore existed.
    try {
      require('child_process').execSync(
        'git rm -r --cached --ignore-unmatch .swarm/.run .swarm/.server-url .swarm/.stopped',
        { cwd: root, stdio: 'ignore', windowsHide: true });
    } catch (_) {}
  } catch (_) {}
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

// Refuse work-taking commands when the swarm is stopped or this agent is paused.
// This is what makes pause/stop actually stop a Codex/CLI agent's loop.
function gate(root, me, what, flags) {
  if (flags && flags.force) return;
  if (ioBus.isStopped(root)) die(`SWARM STOPPED — cannot ${what}. Stop working and wait. Resume: run /swarm (or delete .swarm/.stopped).`);
  if (me && me.paused) die(`PAUSED — cannot ${what}. Stop working and wait until resumed from the dashboard.`);
}

// ─── git sync (best effort) ──────────────────────────────────────────────────

function pull(root) {
  if (!gitSync) return;
  // Bug #2: bound the pre-action pull to ~6s so a slow/unreachable remote can't make a
  // command (done/room/claim) hang for 30s+. State write is local anyway; push is detached.
  try { if (gitSync.isGitRepo(root)) gitSync.pull(root, 1, 6000); } catch (_) {}
}
// Bug #2 (messaging/CLI timeouts): the local state change (claim/done/msg/room) is already
// written to disk before this runs — the only slow part is the network git push, which used
// to block the command for up to ~90s and made `done`/`room` "time out" (false-negative even
// though the task file was written). Push in a DETACHED background process so the command
// returns instantly; the sync still happens.
function pushSync(root, msg) {
  if (!gitSync) return;
  try {
    if (!gitSync.isGitRepo(root) || !gitSync.hasChanges(root)) return;
    const gsPath = path.join(__dirname, 'git-sync');
    const code = `try{const g=require(${JSON.stringify(gsPath)});` +
      `if(g.isGitRepo(${JSON.stringify(root)})&&g.hasChanges(${JSON.stringify(root)}))` +
      `g.syncAndCommit(${JSON.stringify(msg)},${JSON.stringify(root)});}catch(e){}`;
    const child = require('child_process').spawn(process.execPath, ['-e', code], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch (_) {}
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
      '  create "<title>" [--priority high] [--tags a,b] [--after id1,id2]',
      '                              (--after/--deps: stays blocked until those tasks are done)',
      '  split <taskId> "<a>" "<b>"  Break a big task into subtasks',
      '',
      'Coordinate:',
      '  msg <name|id> "<text>"      Direct message another agent (into their inbox)',
      '  say <name|id> "<text>"      Inject a message into any agent inbox (human → agent)',
      '  broadcast "<text>"          Post to the common room (everyone sees)',
      '  room ["<text>"]             View the common room, or post to it',
      '  outbox [name]               Recent agent outputs / message flow',
      '  delegate                    (lead) hand out open tasks to best agents',
      '  assign <taskId> <name|id>   (lead) assign a task',
      '  lead [name]                 Make yourself (or name) the lead',
      '  review <taskId> accept|reject  Accept or reject a completed task',
      '  escalate "<question>"       Ask the human a decision/approval (actionable, not just a room post)',
      '  resolve <escId> "<answer>"  Answer a pending escalation (notifies the asking agent)',
      '  plan "<intent>"             Propose a plan and block for human approval',
      '  request-shutdown ["why"]    Ask to stop (keeps working until approved)',
      '  shutdown <name|id>          Approve/stop a worker gracefully (lead/human)',
      '',
      'Continuous:',
      '  loop [interval]             Poll inbox/next continuously (default 5s) — never exits',
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
    // Bug #8: sync hierarchy to match actual agent ID.
    hi.syncAgentToHierarchy(root, agent.id, hi.isLead(root, agent.id) ? 'lead' : 'developer');

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
    // Show active tasks with creator so an unexpected "assigned" count is never a mystery (Bug #8).
    const active = tm.listTasks(root).filter(t => t.status === 'assigned' || t.status === 'in_progress');
    if (active.length) {
      lines.push('Active tasks:');
      for (const t of active) {
        lines.push(`  • "${t.title}" [${t.status}] → ${nameOf(root, t.assigned_to, cache)} (by ${nameOf(root, t.created_by, cache)})`);
      }
    }
    out(lines.join('\n'), { ok: true, agents, stats, active });
  },

  inbox(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const mine = orch.assignmentsFor(root, me.id);
    const msgs = ioBus.readInbox(root, me.id).slice(-10);
    const cache = {}; reg.listAgents(root).forEach(x => cache[x.id] = x.name);
    const lines = [`Inbox for ${me.name}:`];
    if (mine.length) {
      lines.push('  ASSIGNED TO YOU (work these):');
      for (const t of mine) lines.push(`    • [${t.priority}] "${t.title}" (${t.status}) id=${t.id}`);
    } else {
      lines.push('  No tasks assigned to you.');
    }
    if (msgs.length) {
      lines.push('  MESSAGES (full text — read carefully, requirements may be here):');
      for (const m of msgs) {
        const tag = m.type === 'task_assignment' ? '[assignment] ' : '';
        // Full content, not a preview — hidden requirements in long messages caused wrong deliverables.
        lines.push(`    • ${nameOf(root, m.from, cache)}: ${tag}${m.content || ''}`);
      }
    }
    if (!mine.length && !msgs.length) lines.push('  (nothing — run `next` to find a task to claim)');
    out(lines.join('\n'), { ok: true, assigned: mine, messages: msgs });
  },

  next(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    gate(root, me, 'take new work', flags);
    // Converge claims to ticket winners after the pull above — release any task I
    // optimistically claimed but lost to an earlier claim (Phase 1.1).
    try {
      const lost = tm.reconcileClaims(root, me.id);
      if (lost.length) reg.updateStatus(root, me.id, 'idle', null);
    } catch (_) {}
    // If I'm the lead, split big tasks + hand out parts BEFORE looking for my own
    // work — stops one agent grabbing a whole multi-deliverable task.
    try { if (hi.isLead(root, me.id)) orch.distribute(root, me.id); } catch (_) {}
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
    gate(root, me, 'claim a task', flags);
    const taskId = a._[0]; if (!taskId) die('claim needs a task id');

    // HARD ENFORCEMENT (the real "codex grabbed the whole task" fix): you cannot claim a
    // splittable task whole while there's more than one agent. Split it on the spot and
    // send the claimer to a part. This catches direct `claim <id>` (which bypasses `next`).
    const task = tm.getTask(root, taskId);
    if (task) {
      const agentCount = reg.listAgents(root).filter(x => x.status !== 'offline').length;
      if (task.status === 'split') {
        die(`"${task.title}" is split into parts — run \`next\` to claim a part, not the parent.`);
      }
      if (task.status === 'open' && agentCount > 1 && tm.shouldAutoSplit(task.title, task.description)) {
        const subs = tm.autoSplitTask(root, taskId, agentCount);
        if (subs && subs.length) {
          pushSync(root, `swarm: auto-split ${shortId(taskId)} into ${subs.length}`);
          die(`Too big to take whole — split into ${subs.length} parts:\n` +
            subs.map(s => `  • "${s.title}" id=${s.id}`).join('\n') +
            `\nClaim ONE part (run \`next\`), don't take the whole job.`);
        }
        // couldn't actually split → fall through and allow the claim
      }
    }

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
    gate(root, me, 'mark done', flags);
    const taskId = a._[0]; if (!taskId) die('done needs a task id');
    const result = a._[1];
    if (!result || result.length < 3) die('done needs a real result string: done <id> "what you actually produced"');
    const t = tm.getTask(root, taskId);
    if (!t) die('task not found: ' + taskId);
    // RULE: only complete a task assigned to you (or one you won via a deferred claim
    // ticket whose assignment hasn't been materialized by reconcile yet).
    if (t.assigned_to && t.assigned_to !== me.id) die(`not yours — that task belongs to someone else. Claim an open one first.`);
    if (!t.assigned_to && !tm.getMyActiveClaim(root, taskId, me.id)) die(`not yours yet — run:  claim ${taskId}   then do the work, then done.`);
    tm.completeTask(root, taskId, result, []);
    reg.updateStatus(root, me.id, 'idle', null);
    ioBus.deliverBroadcast(root, me.id, { type: mb.MSG_TYPES.STATUS_UPDATE, content: `Completed "${t.title}".` });
    // Phase 3.1: wake + route any pipeline stage this completion unblocked.
    let unblocked = [];
    try {
      unblocked = tm.getNewlyUnblocked(root, taskId);
      if (unblocked.length) { ioBus.postRoom(root, me.id, `Unblocked: ${unblocked.map(u => `"${u.title}"`).join(', ')} (dependency done).`, 'chat'); orch.distributeNow(root); }
    } catch (_) {}
    pushSync(root, `swarm: ${shortId(me.id)} completed ${shortId(taskId)}`);
    const unote = unblocked.length ? `\n  unblocked: ${unblocked.map(u => `"${u.title}"`).join(', ')}` : '';
    out(`Done "${t.title}" — pending review by lead. Run \`next\` for more work.${unote}`, { ok: true, taskId, unblocked });
  },

  create(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const title = a._[0]; if (!title) die('create needs a title');
    const tags = (flags.tags || '').split(',').map(s => s.trim()).filter(Boolean);
    // --deps / --after id1,id2 → this task stays blocked until those complete (Phase 3.1).
    const dependencies = (flags.deps || '').split(',').map(s => s.trim()).filter(Boolean);
    const t = tm.createTask(root, title, a._[1] || '', {
      createdBy: me.id, priority: flags.priority || 'medium', tags, dependencies,
    });
    // Bug #4/#5: split + cap-route the new task immediately (don't wait for a lead tick).
    let routed = [];
    try { routed = (orch.distributeNow(root).assignments) || []; } catch (_) {}
    pushSync(root, `swarm: ${shortId(me.id)} created task ${shortId(t.id)}`);
    const note = routed.length ? '\n  routed: ' + routed.map(x => `"${x.title}" → ${x.agentName}`).join(', ') : '';
    out(`Created "${t.title}" id=${t.id} (${t.priority})${note}`, { ok: true, task: t, routed });
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
    ioBus.deliver(root, target.id, { from: me.id, type: mb.MSG_TYPES.TASK_ASSIGNMENT, content: orch.buildAssignmentPrompt(t), refs: { tasks: [taskId] } });
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
    ioBus.deliver(root, target.id, { from: me.id, type: 'chat', content: text });
    pushSync(root, `swarm: msg → ${target.name}`);
    out(`Sent to ${target.name} (inbox).`, { ok: true });
  },

  broadcast(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const text = a._[0];
    if (!text) die('broadcast needs: broadcast "text"');
    ioBus.deliverBroadcast(root, me.id, { type: 'chat', content: text });
    pushSync(root, `swarm: broadcast`);
    out('Broadcast sent to all inboxes.', { ok: true });
  },

  // Common room — shared channel everyone reads. No arg = view, with text = post.
  room(root, a, flags) {
    pull(root);
    const text = a._[0];
    if (text) {
      const me = requireAgent(root, flags);
      ioBus.postRoom(root, me.id, text, 'chat');
      pushSync(root, 'swarm: room post');
      out('Posted to common room.', { ok: true });
    } else {
      const cache = {}; reg.listAgents(root).forEach(x => cache[x.id] = x.name);
      const msgs = ioBus.readRoom(root, 30);
      const lines = msgs.map(m => {
        const t = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
        return `  ${t} ${nameOf(root, m.from, cache)}: ${m.content||''}`;
      });
      out(lines.length ? lines.join('\n') : '  (room empty — post with: room "message")', { ok: true, room: msgs });
    }
  },

  // Inject a message into ANY agent's inbox (human → agent). Drives background workers.
  say(root, a, flags) {
    pull(root);
    const who = a._[0], text = a._[1];
    if (!who || !text) die('say needs: say <name|id> "message"');
    const target = reg.findByName(root, who) || reg.getAgent(root, who);
    if (!target) die('agent not found: ' + who);
    // Human injection: from defaults to 'human' (only act as an agent with explicit --as).
    const from = flags.as ? ((resolveAgent(root, flags) || {}).id || 'human') : 'human';
    ioBus.deliver(root, target.id, { from, type: 'chat', content: text });
    pushSync(root, `swarm: say → ${target.name}`);
    out(`Injected into ${target.name}'s inbox. Their next tick will process it.`, { ok: true });
  },

  outbox(root, a, flags) {
    pull(root);
    const who = a._[0];
    const cache = {}; reg.listAgents(root).forEach(x => cache[x.id] = x.name);
    let rows;
    if (who) {
      const t = reg.findByName(root, who) || reg.getAgent(root, who);
      if (!t) die('agent not found: ' + who);
      rows = ioBus.readOutbox(root, t.id, 15).map(m => Object.assign({ agent: t.id }, m));
    } else {
      rows = ioBus.recentFlow(root, 30);
    }
    const party = (id) => id === 'human' ? 'human' : id === 'room' ? 'room' : id === 'broadcast' ? 'all'
      : id === 'panel' ? 'panel' : nameOf(root, id, cache);
    const lines = rows.map(m => {
      const t = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
      const room = m.box === 'room' || m.to === 'room';
      const kind = room ? 'room' : (m.to === 'broadcast' ? 'all' : 'dm');
      const to = room ? 'room' : party(m.to || m.agent);
      return `  ${t} [${kind}] ${party(m.from)} → ${to}: ${m.content || ''}`;
    });
    out(lines.length ? lines.join('\n') : '  (no io yet)', { ok: true, flow: rows });
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

  review(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const taskId = a._[0]; if (!taskId) die('review needs: review <taskId> accept|reject ["reason"]');
    const verdict = a._[1]; if (!verdict || !['accept', 'reject'].includes(verdict)) die('review needs: review <taskId> accept|reject ["reason"]');
    const t = tm.getTask(root, taskId);
    if (!t) die('task not found: ' + taskId);
    if (t.status !== 'done' || t.review_status !== 'pending_review') die('task is not pending review');
    if (verdict === 'accept') {
      tm.acceptTask(root, taskId);
      pushSync(root, `swarm: ${shortId(me.id)} accepted ${shortId(taskId)}`);
      out(`Accepted "${t.title}".`, { ok: true, taskId });
    } else {
      const reason = a._[2] || 'rejected by reviewer';
      tm.rejectTask(root, taskId, reason);
      pushSync(root, `swarm: ${shortId(me.id)} rejected ${shortId(taskId)}`);
      out(`Rejected "${t.title}" — reopened. Reason: ${reason}`, { ok: true, taskId, reason });
    }
  },

  // Raise an actionable decision/approval request to the human (Bug #5).
  escalate(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const text = a._[0];
    if (!text) die('escalate needs: escalate "your question for the human"');
    const al = require('./agent-loop');
    const esc = al.createEscalation(root, me.id,
      { id: require('crypto').randomUUID(), from: me.id, content: text },
      { reasons: [{ trigger: 'agent_request' }], severity: 'medium' }, null);
    try { ioBus.postRoom(root, me.id, '[needs your decision] ' + text, 'chat'); } catch (_) {}
    pushSync(root, `swarm: ${shortId(me.id)} escalated`);
    out(`Escalated to the human (id=${esc.id}). They resolve it from the dashboard or with \`resolve ${esc.id} "..."\`.`,
        { ok: true, escalation: esc });
  },

  // Human (or lead) answers a pending escalation; the asking agent is notified so it unblocks.
  resolve(root, a, flags) {
    pull(root);
    const escId = a._[0], decision = a._[1];
    if (!escId || !decision) die('resolve needs: resolve <escalationId> "your decision"');
    const al = require('./agent-loop');
    const by = flags.as ? ((resolveAgent(root, flags) || {}).name || 'human') : 'human';
    const esc = al.resolveEscalation(root, escId, decision, by);
    if (!esc) die('escalation not found: ' + escId);
    try { ioBus.deliver(root, esc.agent_id, { from: 'human', type: 'chat', content: `Decision on your escalation: ${decision}` }); } catch (_) {}
    pushSync(root, `swarm: resolved escalation ${shortId(escId)}`);
    out(`Resolved. Told ${nameOf(root, esc.agent_id)}: "${decision}".`, { ok: true, escalation: esc });
  },

  // Worker asks to stop (Phase 3.2). Keeps running until a human/lead approves with
  // `shutdown <name>`; then its loop exits cleanly on the next tick.
  'request-shutdown'(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const reason = a._[0] || 'no reason given';
    reg.patch(root, me.id, { shutdown_requested: true });
    const al = require('./agent-loop');
    const esc = al.createEscalation(root, me.id,
      { id: require('crypto').randomUUID(), from: me.id, content: `Requests shutdown: ${reason}` },
      { reasons: [{ trigger: 'shutdown_request' }], severity: 'low' }, null);
    try { ioBus.postRoom(root, me.id, `[shutdown requested] ${reason} — approve with: shutdown ${me.name}`, 'chat'); } catch (_) {}
    pushSync(root, `swarm: ${shortId(me.id)} requested shutdown`);
    out(`Shutdown requested (id=${esc.id}). You keep working until a human/lead approves.`, { ok: true, escalation: esc });
  },

  // Approve a shutdown / gracefully stop a worker (human or lead). Sets the worker's
  // stop flag; its loop finishes the current tick and exits — no kill mid-LLM-call.
  shutdown(root, a, flags) {
    pull(root);
    const who = a._[0];
    if (!who) die('shutdown needs: shutdown <name|id>');
    const target = reg.findByName(root, who) || reg.getAgent(root, who);
    if (!target) die('agent not found: ' + who);
    reg.patch(root, target.id, { stop: true, shutdown_requested: false });
    try { ioBus.deliver(root, target.id, { from: flags.as ? ((resolveAgent(root, flags) || {}).id || 'human') : 'human', type: 'chat', content: 'Shutdown approved — finish your current tick and exit.' }); } catch (_) {}
    pushSync(root, `swarm: shutdown ${target.name}`);
    out(`${target.name} will shut down cleanly on its next tick.`, { ok: true });
  },

  // Propose a plan and block for human approval (Phase 3.3). Raises a plan_approval
  // escalation; the human answers with `resolve <escId> "..."` (delivered to you).
  plan(root, a, flags) {
    pull(root);
    const me = requireAgent(root, flags);
    const text = a._[0];
    if (!text) die('plan needs: plan "what you intend to do"');
    const al = require('./agent-loop');
    const esc = al.createEscalation(root, me.id,
      { id: require('crypto').randomUUID(), from: me.id, content: text },
      { reasons: [{ trigger: 'plan_approval' }], severity: 'medium' }, text);
    try { ioBus.postRoom(root, me.id, '[plan needs approval] ' + text, 'chat'); } catch (_) {}
    pushSync(root, `swarm: ${shortId(me.id)} proposed a plan`);
    out(`Plan submitted for approval (id=${esc.id}). Wait for the human to resolve it before building.`, { ok: true, escalation: esc });
  },

  // Bug #1 fix: continuous loop command so CLI agents don't exit after done.
  loop(root, a, flags) {
    const me = requireAgent(root, flags);
    const interval = parseInt(a._[0] || '5', 10);
    out(`Starting continuous loop as ${me.name} (interval=${interval}s). Ctrl+C to stop.`);

    const tick = () => {
      try {
        if (ioBus.isStopped(root)) { out('Swarm stopped — exiting loop.'); process.exit(0); }
        if (me.paused) { out('Paused — waiting...'); return; }

        pull(root);
        reg.heartbeat(root, me.id);

        // Graceful shutdown approved (Phase 3.2) — exit cleanly.
        const meNow = reg.getAgent(root, me.id);
        if (meNow && meNow.stop) { reg.updateStatus(root, me.id, 'offline', null); out('[loop] Shutdown approved — exiting.'); process.exit(0); }

        // Converge claims to ticket winners after the pull — release lost optimistic
        // claims so a loser doesn't keep "working" a task someone else won (Phase 1.1).
        try {
          const lost = tm.reconcileClaims(root, me.id);
          if (lost.length) { reg.updateStatus(root, me.id, 'idle', null); for (const r of lost) out(`[loop] Claim lost: "${r.title}" → ${String(r.winner).slice(0,8)}. Picking another.`); }
        } catch (_) {}

        // Lead splits big tasks + distributes each tick (before claiming own work).
        try { if (hi.isLead(root, me.id)) orch.distribute(root, me.id); } catch (_) {}

        const mine = orch.assignmentsFor(root, me.id);
        const msgs = ioBus.readInbox(root, me.id);
        const best = mine.length ? null : tm.findBestTask(root, me.id);

        if (mine.length) {
          const t = mine[0];
          out(`[loop] Assigned: "${t.title}" id=${t.id}`);
        } else if (msgs.length) {
          const cache = {}; reg.listAgents(root).forEach(x => cache[x.id] = x.name);
          for (const m of msgs) out(`[loop] Message from ${nameOf(root, m.from, cache)}: ${(m.content||'').slice(0, 120)}`);
        } else if (best) {
          out(`[loop] Open task available: "${best.title}" id=${best.id} — claim with: claim ${best.id}`);
        } else {
          out('[loop] Nothing to do. Polling...');
        }
      } catch (e) {
        out(`[loop] Error: ${e.message}`);
      }
    };

    tick();
    setInterval(tick, interval * 1000);
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

    // Bug #1: ensure a git repo exists FIRST, so cross-machine sync (transport: git)
    // and the documented gh/push flow actually work — otherwise the first `git add`
    // fails with "not a git repository".
    let gitReady = gitSync && gitSync.isGitRepo(root);
    if (!gitReady) {
      try {
        require('child_process').execSync('git init', { cwd: root, stdio: 'ignore', windowsHide: true });
        gitReady = true;
      } catch (_) {}
    }
    // Bug #2: keep volatile runtime state (pids, logs, server url, stop flag) out of git.
    ensureGitignore(root);

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
        default_max_calls: 30, // usage cap per worker (LLM calls; 0 = unlimited)
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
