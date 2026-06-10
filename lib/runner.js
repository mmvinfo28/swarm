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
  'You are an autonomous agent in a multi-agent swarm. You act ONLY by emitting action',
  'markers. Markers cause REAL effects in shared state. NEVER narrate or fake an action —',
  'if you did not emit the marker, it did not happen.',
  '',
  'HARD RULES (breaking any = failure):',
  '1. Output format: ONE short status line, then your markers. Nothing else. No prose, no',
  '   fabricated results, no pretending.',
  '2. You may ONLY use ##SWARM:DONE## on a task id listed under "ASSIGNED TO YOU". If a task',
  '   is only on the board, you MUST ##SWARM:CLAIM:id## it first (same turn is fine). Never',
  '   complete a task you were not assigned and did not just claim.',
  '3. Never claim a task assigned to someone else. Never invent ids — copy them exactly.',
  '4. A DONE result must be your REAL deliverable (code/analysis/answer), never "done"/"completed".',
  '5. To talk to everyone use ##SWARM:ROOM:msg##; to one agent ##SWARM:MSG:name:msg##. Actually',
  '   emit the marker — do not say you posted without the marker.',
  '6. If there is no valid action for you, reply with exactly: IDLE',
  '',
  'MARKERS:',
  '##SWARM:CLAIM:task-id##                     claim an open task',
  '##SWARM:DONE:task-id:real result##          finish a task assigned to you',
  '##SWARM:ROOM:message##                      post to the common room (all read it)',
  '##SWARM:MSG:agent-name:message##            direct message one agent',
  '##SWARM:CREATE:title:priority:tag1,tag2##   add a task to the board',
  '##SWARM:SPLIT:task-id:Part A|Part B##        break a big task into subtasks',
  '##SWARM:STATUS:working|idle##                set your status',
].join('\n');

// ─── prompt building ─────────────────────────────────────────────────────────

function buildUserPrompt(root, agent, ctx) {
  const { inbox = [], assigned = [], room = [], bestOpen = null, roster = [] } = ctx;
  const nameOf = (id) => { const a = roster.find(x => x.id === id); return a ? a.name : String(id || '?').slice(0, 8); };
  const lines = [];

  lines.push('=== LIVE SWARM STATE ===');
  lines.push(`You are "${agent.name}" (id=${agent.id}). Capabilities: ${(agent.capabilities||[]).join(', ') || 'none'}.`);
  lines.push(hi.isLead(root, agent.id) ? 'You are the LEAD — hand out work and keep the team moving.' : 'You are a worker.');
  lines.push('');

  // Team roster — so the agent can address teammates by name.
  if (roster.length) {
    lines.push('TEAMMATES:');
    for (const a of roster) lines.push(`- ${a.name} (id=${a.id}) [${a.status}] caps: ${(a.capabilities||[]).join(',') || 'none'}`);
    lines.push('');
  }

  // Common room — the shared channel everyone reads.
  if (room.length) {
    lines.push('COMMON ROOM (shared chat — recent):');
    for (const m of room.slice(-12)) lines.push(`- ${nameOf(m.from)}: ${(m.content||'').slice(0, 200)}`);
    lines.push('Post to the room with ##SWARM:ROOM:<message>## to coordinate with everyone.');
    lines.push('');
  }

  if (assigned.length) {
    lines.push('TASKS ASSIGNED TO YOU — do these now:');
    for (const t of assigned) lines.push(`- id=${t.id} [${t.priority}] "${t.title}"${t.description ? ' — ' + t.description : ''}`);
    lines.push('For each: produce the real result, then emit ##SWARM:DONE:<id>:<your actual result>##.');
    lines.push('Do NOT edit repo files — put the deliverable text in the DONE marker.');
    lines.push('');
  }

  if (bestOpen) {
    lines.push('OPEN TASK ON THE BOARD that fits you — claim it if you can take it:');
    lines.push(`- id=${bestOpen.id} [${bestOpen.priority}] "${bestOpen.title}"${bestOpen.description ? ' — ' + bestOpen.description : ''}`);
    lines.push('Claim with ##SWARM:CLAIM:' + bestOpen.id + '## then work it. Tell the room with ##SWARM:ROOM:taking <title>##.');
    lines.push('');
  }

  if (inbox.length) {
    lines.push('YOUR INBOX (direct messages):');
    for (const m of inbox.slice(0, 10)) {
      const tag = m.type === 'task_assignment' ? '[assignment] ' : '';
      lines.push(`- from ${nameOf(m.from)}: ${tag}${(m.content||'').slice(0, 300)}`);
    }
    lines.push('Reply with ##SWARM:MSG:<their-name-or-id>:<reply>##.');
    lines.push('');
  }

  lines.push('Act now. Respond with a short note plus the ##SWARM:..## action markers.');
  lines.push('To create work for the team, use ##SWARM:CREATE:<title>:<priority>:<tags>## and ##SWARM:ROOM:<announce it>##.');
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

  const inbox = ioBus.readInbox(root, agentId);
  const assigned = orch.assignmentsFor(root, agentId);
  const newRoom = ioBus.newRoomFor(root, agentId);
  const bestOpen = assigned.length ? null : tm.findBestTask(root, agentId); // claimable open task that fits me
  const roster = reg.listAgents(root);

  // Work-gate: act if I have a message, an assigned task, a claimable open task,
  // or new chatter in the common room. Otherwise cheap idle, NO LLM call.
  if (!inbox.length && !assigned.length && !bestOpen && !newRoom.length) {
    reg.updateStatus(root, agentId, 'idle', null);
    pushIf(opts.pull);                 // propagate heartbeat on the slow cadence only
    if (opts.pull) log('idle — nothing to do; skipped LLM');
    return { idle: true };
  }

  // Reason via the driver.
  let driver;
  try { driver = drivers.pick(provider); }
  catch (e) { log('DRIVER ERROR: ' + e.message); return { error: e.message }; }

  const system = STRICT_SYSTEM;
  const user = buildUserPrompt(root, agent, { inbox, assigned, room: ioBus.readRoom(root, 15), bestOpen, roster });

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

  // Register / reuse by name.
  let agent = reg.findByName(root, name);
  if (!agent) agent = reg.register(root, name, a.provider, caps, process.env.USER || 'runner');
  else reg.heartbeat(root, agent.id);
  // First agent becomes lead.
  const h = hi.getHierarchy(root);
  if (!h || !h.lead) hi.setLead(root, agent.id);

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
  } while (true);
}

main().catch(e => { console.error('[runner] fatal: ' + e.message); process.exit(1); });
