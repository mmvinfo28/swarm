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
  const o = { caps: '', interval: 30, provider: 'claude' };
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

function loadSystemGuide() {
  // The marker-oriented operating guide (same one the Python adapters use).
  const p = path.join(__dirname, '..', 'adapters', 'CODEX.md');
  try { return fs.readFileSync(p, 'utf-8'); } catch (_) {
    return 'You are a swarm agent. Reply ONLY with action markers: ' +
      '##SWARM:CLAIM:id##, ##SWARM:DONE:id:result##, ##SWARM:MSG:agent:text##, ' +
      '##SWARM:BROADCAST:text##, ##SWARM:STATUS:idle|working##.';
  }
}

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

async function tick(ctx) {
  const { root, agentId, provider, log } = ctx;

  if (gitSync) { try { if (gitSync.isGitRepo(root)) gitSync.pull(root, 1); } catch (_) {} }
  reg.heartbeat(root, agentId);

  // Lead hands out open tasks.
  try { if (hi.isLead(root, agentId)) {
    const d = orch.distribute(root, agentId);
    if (d.ok && d.assignments.length) log(`distributed ${d.assignments.length} task(s)`);
  } } catch (_) {}

  const agent = reg.getAgent(root, agentId);
  const inbox = ioBus.readInbox(root, agentId);
  const assigned = orch.assignmentsFor(root, agentId);
  const newRoom = ioBus.newRoomFor(root, agentId);
  const bestOpen = assigned.length ? null : tm.findBestTask(root, agentId); // claimable open task that fits me
  const roster = reg.listAgents(root);

  // Work-gate: act if I have a message, an assigned task, a claimable open task,
  // or new chatter in the common room. Otherwise cheap idle, NO LLM call.
  if (!inbox.length && !assigned.length && !bestOpen && !newRoom.length) {
    reg.updateStatus(root, agentId, 'idle', null);
    log('idle — nothing to do; skipped LLM');
    return { idle: true };
  }

  // Reason via the driver.
  let driver;
  try { driver = drivers.pick(provider); }
  catch (e) { log('DRIVER ERROR: ' + e.message); return { error: e.message }; }

  const system = loadSystemGuide();
  const user = buildUserPrompt(root, agent, { inbox, assigned, room: ioBus.readRoom(root, 15), bestOpen, roster });

  let resp;
  try {
    resp = await driver.run(system, user, { agentId, assignedTasks: assigned, inbox, bestOpen, room: newRoom, root });
  } catch (e) {
    if (/CREDITS_EXHAUSTED/.test(e.message)) {
      reg.reportCreditExhaustion(root, agentId);
      ioBus.deliverBroadcast(root, agentId, { type: 'credit_alert', content: `${agent.name} out of credits.` });
      log('credits exhausted');
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

  if (gitSync) { try { if (gitSync.isGitRepo(root) && gitSync.hasChanges(root)) gitSync.syncAndCommit(`swarm: ${agentId.slice(0,8)} tick`, root); } catch (_) {} }

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
  let idleStreak = 0;

  do {
    let res;
    try { res = await tick(ctx); } catch (e) { log('tick error: ' + e.message); res = {}; }
    idleStreak = res && res.idle ? idleStreak + 1 : 0;
    if (a.once) break;
    // Idle backoff: base interval, up to 4x when repeatedly idle.
    const mult = Math.min(1 + idleStreak, 4);
    await new Promise(r => setTimeout(r, a.interval * 1000 * mult));
  } while (true);
}

main().catch(e => { console.error('[runner] fatal: ' + e.message); process.exit(1); });
