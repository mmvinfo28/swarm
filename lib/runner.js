#!/usr/bin/env node
'use strict';

// runner — a background agent daemon. Loops: read inbox → (only if there's work)
// reason via a driver (claude headless / gemini / codex / fake) → apply ##SWARM:..##
// actions → write outbox → mark processed. Never exits (unless --once).
//
// Usage:
//   node lib/runner.js --root <path> --name "Name" --provider claude --caps backend,api
//                      [--interval 30] [--once]
//
// Cost control: when the inbox is empty AND no task is assigned, it heartbeats and
// sleeps WITHOUT calling the LLM (idle backoff). Set SWARM_DRIVER=fake for free tests.

const path = require('path');
const fs = require('fs');

const reg   = require('./agent-registry');
const tm    = require('./task-manager');
const orch  = require('./orchestrator');
const hi    = require('./hierarchy');
const ioBus = require('./io-bus');
const actions = require('./actions');
const drivers = require('./drivers');
let gitSync = null; try { gitSync = require('./git-sync'); } catch (_) {}

// ─── args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { caps: '', interval: 5, provider: 'claude' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--provider') o.provider = argv[++i];
    else if (a === '--caps' || a === '--capabilities') o.caps = argv[++i];
    else if (a === '--interval') o.interval = parseInt(argv[++i], 10);
    else if (a === '--once') o.once = true;
  }
  return o;
}

function findSwarmRoot(dir) {
  const root = path.parse(dir).root;
  while (dir !== root) { if (fs.existsSync(path.join(dir, '.swarm'))) return dir; dir = path.dirname(dir); }
  return null;
}

// Compact, strict system prompt. Driver-agnostic (claude/codex/gemini). Kept small
// for token efficiency — the live state goes in the user message.
const STRICT_SYSTEM = [
  'Autonomous agent in a multi-agent swarm. You act ONLY by emitting ##SWARM:..## markers —',
  'they cause REAL effects. No marker = it did not happen. Never narrate or fake an action.',
  '',
  'RULES (breaking any = failure):',
  '1. Output: one short status line, then markers. No prose, no fabricated/placeholder results.',
  '2. DONE only a task under "ASSIGNED TO YOU". A board task → CLAIM it first (same turn ok).',
  '   Never DONE or CLAIM another agent\'s task. Copy ids exactly; never invent them.',
  '3. A DONE result = your REAL deliverable (code/analysis/answer), never "done"/"completed".',
  '4. Human messaged you (from "human") → you MUST answer ##SWARM:MSG:human:<answer>##.',
  '   No human msg and no valid action → reply with exactly: IDLE',
  '5. Need human approval/permission or a decision before you can proceed? Use',
  '   ##SWARM:ESCALATE:<question>## — NOT a room post. That reaches the user as an actionable',
  '   prompt. Do not stall waiting on a plain room message.',
  '6. NO open/assigned task = NOT a reason to escalate. An empty board is normal —',
  '   reply exactly IDLE and wait. Only ESCALATE for a real decision/approval/conflict.',
  '7. Before you write/edit any file for a task, FIRST claim/own the task, then declare',
  '   the files: ##SWARM:FILES:id:path1,path2##. If a file is already owned by another',
  '   active task you will be told — do NOT edit it; pick a different file or task. This',
  '   is what stops two agents editing the same file.',
  '8. LEAD only: if you are unsure whether a teammate has the right capability for a task',
  '   (e.g. a frontend task but only a backend worker is free), do NOT just guess/assign —',
  '   ##SWARM:ESCALATE:<should X take this <type> task, or wait for a <cap> worker?>##.',
  '',
  'MARKERS:',
  '##SWARM:CLAIM:id##                 claim an open task',
  '##SWARM:FILES:id:a.html,b.js##      declare files a task owns (lock — do before editing)',
  '##SWARM:DONE:id:real result##      finish a task assigned to you',
  '##SWARM:ROOM:msg##                 post to common room (all read it)',
  '##SWARM:MSG:name:msg##             DM one agent (name "human" = answer the operator)',
  '##SWARM:CREATE:title:priority:tags##  add a task to the board',
  '##SWARM:SPLIT:id:Part A|Part B##    split a big task into subtasks',
  '##SWARM:ESCALATE:question##        ask the human a decision/approval (actionable)',
  '##SWARM:STATUS:working|idle##       set your status',
].join('\n');

// ─── prompt building ─────────────────────────────────────────────────────────

function buildUserPrompt(root, agent, ctx) {
  const { inbox = [], assigned = [], room = [], bestOpen = null, roster = [] } = ctx;
  const nameOf = (id) => { const a = roster.find(x => x.id === id); return a ? a.name : String(id || '?').slice(0, 8); };
  const lines = [];

  lines.push('=== LIVE SWARM STATE ===');
  lines.push(`You are "${agent.name}" — caps: ${(agent.capabilities||[]).join(',') || 'none'}. ${hi.isLead(root, agent.id) ? 'LEAD (hand out work, keep the team moving).' : 'Worker.'}`);

  // Roster — address teammates by name (MSG resolves by name; no need for ids here).
  if (roster.length) {
    lines.push('TEAMMATES: ' + roster.map(a => `${a.name}[${a.status}:${(a.capabilities||[]).join(',') || '-'}]`).join('  '));
  }

  // Common room — shared channel everyone reads.
  if (room.length) {
    lines.push('ROOM (recent):');
    for (const m of room.slice(-8)) lines.push(`- ${nameOf(m.from)}: ${(m.content||'').slice(0, 160)}`);
  }

  if (assigned.length) {
    lines.push('ASSIGNED TO YOU — do now:');
    for (const t of assigned) lines.push(`- id=${t.id} [${t.priority}] "${t.title}"${t.description ? ' — ' + t.description : ''}`);
    lines.push('If it builds code/files: WRITE the real files in the repo (this is your working dir), run them if you can, then ##SWARM:DONE:id:<files you wrote + what works>##.');
    lines.push('If it is analysis/an answer: put the actual result text in the DONE marker. Never leave code only in the marker for a build task.');
  }

  if (bestOpen) {
    lines.push('OPEN TASK that fits you — CLAIM then work it:');
    lines.push(`- id=${bestOpen.id} [${bestOpen.priority}] "${bestOpen.title}"${bestOpen.description ? ' — ' + bestOpen.description : ''}`);
  }

  if (inbox.length) {
    lines.push('INBOX:');
    let fromHuman = false;
    for (const m of inbox.slice(0, 10)) {
      const tag = m.type === 'task_assignment' ? '[assignment] ' : '';
      const human = m.from === 'human';
      if (human) fromHuman = true;
      lines.push(`- from ${human ? 'human' : nameOf(m.from)}: ${tag}${(m.content||'').slice(0, 240)}`);
    }
    if (fromHuman) lines.push('Human messaged you — you MUST answer with ##SWARM:MSG:human:<reply>##.');
  }

  lines.push('Act now: one short note + your ##SWARM:..## markers.');
  return lines.join('\n');
}

// ─── one tick ────────────────────────────────────────────────────────────────

async function tick(ctx, opts) {
  opts = opts || {};
  const { root, agentId, provider, log } = ctx;
  const isGit = gitSync && (() => { try { return gitSync.isGitRepo(root); } catch (_) { return false; } })();
  const pushIf = (cond) => { if (cond && isGit) { try { if (gitSync.hasChanges(root)) gitSync.syncAndCommit(`swarm: ${agentId.slice(0,8)} tick`, root); } catch (_) {} } };

  // Git pull only on the slow cadence (opts.pull), so fast local polling stays cheap.
  if (opts.pull && isGit) { try { gitSync.pull(root, 1); } catch (_) {} }
  reg.heartbeat(root, agentId);

  // After a sync, converge claimed tasks to their ticket winners. This is what makes
  // claims conflict-free cross-machine: claimTask is optimistic pre-sync, so if I lost
  // a race to an earlier claim I release my hold here and go idle (Phase 1.1).
  if (opts.pull) {
    try {
      const released = tm.reconcileClaims(root, agentId);
      if (released.length) {
        reg.updateStatus(root, agentId, 'idle', null);
        for (const r of released) {
          ioBus.deliver(root, agentId, { from: 'system', type: 'chat',
            content: `Claim lost: "${r.title}" went to ${String(r.winner).slice(0, 8)} (earlier claim). Pick another task.` });
        }
        log(`released ${released.length} lost claim(s) after sync`);
      }
    } catch (_) {}
  }

  // Lead hands out open tasks (file-based, runs every tick — instant routing).
  try { if (hi.isLead(root, agentId)) {
    const d = orch.distribute(root, agentId);
    if (d.ok && d.assignments.length) log(`distributed ${d.assignments.length} task(s)`);
  } } catch (_) {}

  const agent = reg.getAgent(root, agentId);

  // If this agent was marked out of tokens / errored, do NOT call the LLM — back off
  // until it's restarted (or stopped from the dashboard). Prevents hammering when broke.
  if (agent && (agent.status === 'credits_exhausted' || agent.status === 'error')) {
    if (opts.pull) log(`down (${agent.status}) — not calling the LLM. Restart the worker to resume.`);
    return { idle: true, down: true };
  }

  // Manually paused (from the dashboard) — skip the LLM until resumed.
  if (agent && agent.paused) {
    if (opts.pull) log('paused — not calling the LLM (resume from the dashboard).');
    return { idle: true, paused: true };
  }

  // Global stop flag (set by /swarm-stop or the dashboard "Stop all") — honor it.
  if (ioBus.isStopped(root)) {
    if (opts.pull) log('swarm stopped — not calling the LLM (run /swarm to resume).');
    return { idle: true, stopped: true };
  }

  const inbox = ioBus.readInbox(root, agentId);
  // Only mark-processed the messages we actually surface to the LLM this tick. Marking the
  // whole inbox while showing just a slice silently dropped messages 11+ (Bug #2: "DMs
  // disappeared before being read"). The rest stay in the inbox for the next tick.
  const inboxBatch = inbox.slice(0, 15);
  // Bug #3 fix: re-query assignments AFTER distribute so freshly-assigned tasks are seen.
  const assigned = orch.assignmentsFor(root, agentId);
  const newRoom = ioBus.newRoomFor(root, agentId);
  const bestOpen = assigned.length ? null : tm.findBestTask(root, agentId); // claimable open task that fits me
  const roster = reg.listAgents(root);

  // Also check for tasks in 'assigned' status (may have been set between ticks).
  const pendingAssigned = assigned.length ? assigned :
    tm.listTasks(root, { assignedTo: agentId }).filter(t => t.status === 'assigned' || t.status === 'in_progress');

  // Work-gate: act if I have a message, an assigned task, a claimable open task,
  // or new chatter in the common room. Otherwise cheap idle, NO LLM call.
  if (!inbox.length && !pendingAssigned.length && !bestOpen && !newRoom.length) {
    reg.updateStatus(root, agentId, 'idle', null);
    pushIf(opts.pull);                 // propagate heartbeat on the slow cadence only
    if (opts.pull) log('idle — nothing to do; skipped LLM');
    return { idle: true };
  }

  // LLM call budget — when a worker hits its cap, auto-pause so it stops spending.
  // Set the cap from the dashboard (per-agent "budget"). 0/undefined = unlimited.
  if (agent.max_calls && (agent.calls || 0) >= agent.max_calls) {
    reg.patch(root, agentId, { paused: true });
    ioBus.deliverBroadcast(root, agentId, { type: 'status_update', content: `${agent.name} hit its LLM budget (${agent.max_calls} calls) — paused.` });
    log(`budget reached (${agent.calls}/${agent.max_calls}) — pausing`);
    return { idle: true, budget: true };
  }

  // Reason via the driver.
  let driver;
  try { driver = drivers.pick(provider); }
  catch (e) { log('DRIVER ERROR: ' + e.message); return { error: e.message }; }

  const system = STRICT_SYSTEM;
  const user = buildUserPrompt(root, agent, { inbox: inboxBatch, assigned, room: ioBus.readRoom(root, 15), bestOpen, roster });

  let resp;
  try {
    resp = await driver.run(system, user, { agentId, assignedTasks: assigned, inbox, bestOpen, room: newRoom, root });
  } catch (e) {
    // Detect out-of-tokens / quota / auth-limit and stop calling the LLM.
    if (/CREDITS_EXHAUSTED|usage limit|rate.?limit|quota|insufficient|balance.*too low|too low.*balance|\b429\b|overloaded|exceeded|out of (credit|token)/i.test(e.message)) {
      reg.reportCreditExhaustion(root, agentId);
      ioBus.deliverBroadcast(root, agentId, { type: 'credit_alert', content: `${agent.name} is out of tokens — paused. Restart the worker or use the dashboard Stop.` });
      log('OUT OF TOKENS — pausing this worker (status=credits_exhausted). ' + e.message.slice(0, 120));
    } else {
      log('driver run error: ' + e.message);
    }
    return { error: e.message };
  }

  reg.patch(root, agentId, { calls: (agent.calls || 0) + 1 }); // count the LLM call (for budget)

  // Re-check pause/stop flags after the (potentially long) LLM call — honor mid-tick pause.
  const agentAfter = reg.getAgent(root, agentId);
  if (agentAfter && agentAfter.paused) {
    log('paused during LLM call — discarding actions.');
    for (const m of inboxBatch) ioBus.markProcessed(root, agentId, m._file);
    return { idle: true, paused: true };
  }
  if (ioBus.isStopped(root)) {
    log('swarm stopped during LLM call — discarding actions.');
    for (const m of inboxBatch) ioBus.markProcessed(root, agentId, m._file);
    return { idle: true, stopped: true };
  }

  const acts = actions.parseActions(resp.text || '');
  const applied = actions.applyActions(root, agentId, acts);
  ioBus.writeOutbox(root, agentId, { from: agentId, to: 'panel', type: 'agent_output', content: (resp.text || '').slice(0, 4000) });

  // Mark all inbox messages processed; advance the room cursor so we don't re-wake on the same chatter.
  for (const m of inbox) ioBus.markProcessed(root, agentId, m._file);
  ioBus.setRoomCursor(root, agentId, new Date().toISOString());

  pushIf(true); // real actions happened → push now so the team sees them

  log(`acted: ${applied.map(x => x.type + (x.ok ? '' : '!')).join(', ') || 'none'}`);
  return { applied, actionsCount: acts.length };
}

// ─── main loop ───────────────────────────────────────────────────────────────

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const root = a.root || findSwarmRoot(process.cwd());
  if (!root || !fs.existsSync(path.join(root, '.swarm'))) {
    console.error('[runner] no .swarm/ at ' + (root || '(none)')); process.exit(1);
  }

  const name = a.name || `Worker-${process.pid}`;
  const caps = (a.caps || '').split(',').map(s => s.trim()).filter(Boolean);

  // Register / reuse by name (Bug #7: register() now reuses existing by name).
  let agent = reg.findByName(root, name);
  if (!agent) agent = reg.register(root, name, a.provider, caps, process.env.USER || 'runner');
  else reg.heartbeat(root, agent.id);
  // First agent becomes lead.
  const h = hi.getHierarchy(root);
  if (!h || !h.lead) hi.setLead(root, agent.id);
  // Bug #8: sync hierarchy to match actual agent ID.
  hi.syncAgentToHierarchy(root, agent.id, hi.isLead(root, agent.id) ? 'lead' : 'developer');

  const stamp = () => new Date().toISOString().slice(11, 19);
  const log = (m) => console.log(`[${stamp()}] ${name}: ${m}`);

  log(`runner started (provider=${a.provider}, driver=${(process.env.SWARM_DRIVER||a.provider)}, interval=${a.interval}s, id=${agent.id.slice(0,8)})`);

  const ctx = { root, agentId: agent.id, provider: a.provider, log };
  // Fast local poll (a.interval, default 5s) for instant task pickup; git pull/push on a
  // slower cadence (~SYNC_SECONDS) so idle polling stays cheap (no network, no LLM).
  const SYNC_SECONDS = parseInt(process.env.SWARM_SYNC_SECONDS || '30', 10);
  const pullEvery = Math.max(1, Math.round(SYNC_SECONDS / Math.max(1, a.interval)));
  let tickNum = 0;

  do {
    tickNum++;
    const doPull = (tickNum % pullEvery === 1) || pullEvery === 1; // first tick + every cadence
    try { await tick(ctx, { pull: doPull }); } catch (e) { log('tick error: ' + e.message); }
    if (a.once) break;
    await new Promise(r => setTimeout(r, a.interval * 1000));
    // Clean exit when the swarm is stopped — don't keep the process around.
    if (ioBus.isStopped(root)) { log('swarm stopped — exiting.'); break; }
  } while (true);
}

// Only run the daemon when launched directly (`node lib/runner.js …`). Requiring this
// module (tests, tooling) must NOT spawn a worker.
if (require.main === module) {
  main().catch(e => { console.error('[runner] fatal: ' + e.message); process.exit(1); });
}

module.exports = { STRICT_SYSTEM, buildUserPrompt, tick };
