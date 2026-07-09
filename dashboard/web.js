#!/usr/bin/env node
'use strict';

// HTML dashboard — no npm deps, stdlib only.
// Usage: node dashboard/web.js [port] [swarm-root]
// Then open http://localhost:7379 in any browser.

const http = require('http');
const fs   = require('fs');
const path = require('path');

function findSwarmRoot(dir) {
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.swarm'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

const PORT      = parseInt(process.argv[2] || process.env.SWARM_DASH_PORT || '7379', 10);
const swarmRoot = process.argv[3] || process.env.SWARM_ROOT || findSwarmRoot(process.cwd()) || process.cwd();
// Bind host. Default localhost-only (safe). Set SWARM_DASH_HOST=0.0.0.0 to expose on
// the LAN so a phone / another laptop on the same Wi-Fi can reach it. NO AUTH — only
// do this on a trusted network.
const HOST      = process.env.SWARM_DASH_HOST || '127.0.0.1';

if (!fs.existsSync(path.join(swarmRoot, '.swarm'))) {
  console.error(`[swarm-dash] No .swarm/ in: ${swarmRoot}`);
  console.error('[swarm-dash] Run /swarm init first or pass path as 2nd argument.');
  process.exit(1);
}

// ─── Read state ──────────────────────────────────────────────────────────────

function readDir(dir, prefix, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => (!prefix || f.startsWith(prefix)) && (!ext || f.endsWith(ext)));
}

function readYaml(file) {
  try {
    const libDir = path.join(__dirname, '..', 'lib');
    const yaml   = require(path.join(libDir, 'yaml'));
    return yaml.parse(fs.readFileSync(file, 'utf-8')) || {};
  } catch (_) { return {}; }
}

function readState() {
  const base  = path.join(swarmRoot, '.swarm');
  const state = { agents: [], tasks: [], messages: [], escalations: [], config: {}, hierarchy: {} };

  const configFile = path.join(base, 'config.yaml');
  if (fs.existsSync(configFile)) state.config = readYaml(configFile);

  const hierarchyFile = path.join(base, 'hierarchy.yaml');
  if (fs.existsSync(hierarchyFile)) state.hierarchy = readYaml(hierarchyFile);

  for (const f of readDir(path.join(base, 'agents'), 'agent-', '.yaml'))
    state.agents.push(readYaml(path.join(base, 'agents', f)));

  for (const f of readDir(path.join(base, 'tasks'), 'task-', '.yaml'))
    state.tasks.push(readYaml(path.join(base, 'tasks', f)));

  const msgFiles = readDir(path.join(base, 'messages'), null, '.yaml').sort().slice(-30);
  for (const f of msgFiles)
    state.messages.push(readYaml(path.join(base, 'messages', f)));

  for (const f of readDir(path.join(base, 'escalations'), 'esc-', '.yaml')) {
    const e = readYaml(path.join(base, 'escalations', f));
    if (e.status === 'pending') state.escalations.push(e);
  }

  // io flow (inbox/outbox) for the control panel.
  try {
    const ioBus = require(path.join(__dirname, '..', 'lib', 'io-bus'));
    state.flow = ioBus.recentFlow(swarmRoot, 40);
  } catch (_) { state.flow = []; }

  // Claude CLI auth health — drives the red banner (workers can't reason when this is down).
  try {
    state.auth = require(path.join(__dirname, '..', 'lib', 'auth-check')).status();
  } catch (_) { state.auth = { ok: true }; }

  return state;
}

function injectMessage(agentId, text) {
  const ioBus = require(path.join(__dirname, '..', 'lib', 'io-bus'));
  if (agentId === 'room') return ioBus.postRoom(swarmRoot, 'human', text, 'chat');
  return ioBus.deliver(swarmRoot, agentId, { from: 'human', type: 'chat', content: text });
}

function createTaskFromPanel(title, priority, tags) {
  const taskManager = require(path.join(__dirname, '..', 'lib', 'task-manager'));
  const ioBus = require(path.join(__dirname, '..', 'lib', 'io-bus'));
  const t = taskManager.createTask(swarmRoot, title, '', {
    createdBy: 'human',
    priority: ['critical', 'high', 'medium', 'low'].includes(priority) ? priority : 'medium',
    tags: Array.isArray(tags) ? tags : String(tags || '').split(',').map(s => s.trim()).filter(Boolean),
  });
  // Announce on the board so idle workers wake and the lead can distribute.
  try { ioBus.postRoom(swarmRoot, 'human', `New task on the board: "${t.title}" [${t.priority}] (tags: ${(t.tags||[]).join(',')||'none'})`, 'chat'); } catch (_) {}
  // Bug #4/#5: split + cap-route immediately instead of waiting for a lead tick.
  try { require(path.join(__dirname, '..', 'lib', 'orchestrator')).distributeNow(swarmRoot); } catch (_) {}
  return t;
}

function controlAgent(id, action, value) {
  const reg = require(path.join(__dirname, '..', 'lib', 'agent-registry'));
  const hi = require(path.join(__dirname, '..', 'lib', 'hierarchy'));
  const agent = reg.getAgent(swarmRoot, id);
  if (!agent) throw new Error('agent not found');
  if (action === 'lead') { hi.setLead(swarmRoot, id); return { ok: true }; }
  if (action === 'pause') { reg.patch(swarmRoot, id, { paused: true }); return { ok: true }; }
  if (action === 'resume') {
    const fix = { paused: false, calls: 0 };
    if (agent.status === 'credits_exhausted' || agent.status === 'error') fix.status = 'idle';
    reg.patch(swarmRoot, id, fix); return { ok: true };
  }
  if (action === 'caps') {
    const caps = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
    reg.patch(swarmRoot, id, { capabilities: caps }); return { ok: true, capabilities: caps };
  }
  if (action === 'role') { hi.assignRole(swarmRoot, id, String(value)); return { ok: true }; }
  if (action === 'budget') {
    const n = parseInt(value, 10) || 0; // 0 = unlimited
    reg.patch(swarmRoot, id, { max_calls: n }); return { ok: true, max_calls: n };
  }
  throw new Error('unknown agent action: ' + action);
}

function controlAction(action) {
  const launch = require(path.join(__dirname, '..', 'lib', 'launch'));
  const ioBusLib = require(path.join(__dirname, '..', 'lib', 'io-bus'));
  if (action === 'stop-workers') {
    ioBusLib.setStopped(swarmRoot);
    const stopped = launch.stopWorkers(swarmRoot);
    return { ok: true, stopped };
  }
  if (action === 'stop-all') {
    ioBusLib.setStopped(swarmRoot);
    const stopped = launch.stopWorkers(swarmRoot);
    // Keep dashboard alive briefly to flush response, then stop everything.
    setTimeout(() => { try { launch.stop(swarmRoot); } catch (_) {} process.exit(0); }, 600);
    return { ok: true, stopping: 'all', workers: stopped };
  }
  throw new Error('unknown action: ' + action);
}

// Resolve a worker's escalation from the panel and notify the asking agent (Bug #5).
function resolveEscalationFromPanel(escId, decision) {
  const al = require(path.join(__dirname, '..', 'lib', 'agent-loop'));
  const ioBus = require(path.join(__dirname, '..', 'lib', 'io-bus'));
  const esc = al.resolveEscalation(swarmRoot, escId, decision, 'human');
  if (!esc) throw new Error('escalation not found');
  try { ioBus.deliver(swarmRoot, esc.agent_id, { from: 'human', type: 'chat', content: `Decision on your escalation: ${decision}` }); } catch (_) {}
  return esc;
}

// ─── HTML ────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Swarm Dashboard</title>
<style>
:root{--bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff;--purple:#bc8cff;--orange:#e3b341}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:13px;line-height:1.5}
#app{display:flex;flex-direction:column;height:100vh;overflow:hidden}

/* ── Header ── */
#hdr{background:var(--bg2);border-bottom:1px solid var(--border);padding:7px 16px;display:flex;align-items:center;gap:14px;flex-shrink:0;white-space:nowrap;overflow:hidden}
.logo{font-weight:700;font-size:14px;color:var(--blue);letter-spacing:.08em}
.sep{color:var(--border)}
.stat{color:var(--muted);font-size:12px}.stat b{color:var(--text)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;vertical-align:middle;margin-right:4px;transition:background .3s}
.dot.ok{background:var(--green);box-shadow:0 0 5px var(--green)}.dot.err{background:var(--red)}.dot.spin{background:var(--yellow)}
#refresh-time{font-size:11px;color:var(--muted)}
.rbtn{margin-left:auto;background:var(--bg3);border:1px solid var(--border);color:var(--muted);padding:3px 10px;cursor:pointer;border-radius:4px;font-family:inherit;font-size:12px}
.rbtn:hover{border-color:var(--blue);color:var(--blue)}
.actrl{display:flex;gap:3px;margin-top:3px;flex-wrap:wrap}
.abtn{background:var(--bg3);border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:10px;padding:1px 6px;border-radius:3px;cursor:pointer}
.abtn:hover{border-color:var(--blue);color:var(--blue)}
.abtn.lead{border-color:var(--yellow);color:var(--yellow);cursor:default}
.abtn.on{border-color:var(--green);color:var(--green)}

/* ── Grid ── */
#grid{display:grid;grid-template-columns:2fr 3fr;grid-template-rows:1fr 1fr;flex:1;gap:1px;background:var(--border);overflow:hidden}
.panel{background:var(--bg2);display:flex;flex-direction:column;overflow:hidden;min-height:0}
.ph{padding:7px 12px;border-bottom:1px solid var(--border);font-size:11px;font-weight:700;letter-spacing:.07em;color:var(--muted);text-transform:uppercase;flex-shrink:0;display:flex;align-items:center;gap:6px;background:var(--bg3)}
.ph .cnt{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:0 6px;font-size:10px;color:var(--text)}
.pb{padding:8px 12px;overflow-y:auto;flex:1}
.pb::-webkit-scrollbar{width:5px}.pb::-webkit-scrollbar-track{background:var(--bg2)}.pb::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}

/* ── Agent ── */
.agent{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid rgba(48,54,61,.6)}
.agent:last-child{border-bottom:none}
.adot{width:9px;height:9px;border-radius:50%;flex-shrink:0;margin-top:4px}
.s-idle{background:var(--green)}.s-working{background:var(--blue);box-shadow:0 0 5px var(--blue)}.s-reviewing{background:var(--yellow)}.s-offline{background:#444}.s-credits_exhausted{background:var(--red)}.s-error{background:var(--red)}
.aname{font-weight:700}.ameta{color:var(--muted);font-size:11px;margin-top:1px}.atask{color:var(--blue);font-size:11px}

/* ── Task ── */
.task{padding:5px 0;border-bottom:1px solid rgba(48,54,61,.6)}.task:last-child{border-bottom:none}
.trow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pbadge{font-size:10px;padding:1px 6px;border-radius:3px;font-weight:700;flex-shrink:0}
.p-critical{background:rgba(248,81,73,.15);color:var(--red)}.p-high{background:rgba(210,153,34,.15);color:var(--yellow)}.p-medium{background:rgba(88,166,255,.1);color:var(--blue)}.p-low{background:rgba(139,148,158,.1);color:var(--muted)}
.tname{flex:1;min-width:0;white-space:normal;word-wrap:break-word;overflow-wrap:break-word}
.twho{color:var(--purple);font-size:11px;flex-shrink:0}
.ttags{color:var(--muted);font-size:11px;margin-top:2px;padding-left:2px}

/* ── Section header ── */
.sh{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:8px 0 3px;padding-bottom:3px;border-bottom:1px solid var(--border)}

/* ── Message ── */
.msg{padding:3px 0;border-bottom:1px solid rgba(48,54,61,.4);font-size:12px;line-height:1.4;word-wrap:break-word;overflow-wrap:break-word}.msg:last-child{border-bottom:none}
.mt{color:var(--muted);margin-right:5px;font-size:11px}.mf{color:var(--blue);font-weight:600}.mto{color:var(--purple);font-weight:600}.marr{color:var(--muted);margin:0 3px}.mbody{color:var(--text)}
.mkind{font-size:9px;font-weight:700;text-transform:uppercase;padding:0 5px;border-radius:3px;margin-right:5px;letter-spacing:.04em}
.mk-room{background:rgba(188,140,255,.15);color:var(--purple)}.mk-dm{background:rgba(63,185,80,.15);color:var(--green)}.mk-cast{background:rgba(227,179,65,.15);color:var(--orange)}

/* ── Escalation ── */
.esc{padding:7px 9px;border-radius:4px;margin-bottom:5px;border-left:3px solid}
.esc-high{background:rgba(248,81,73,.08);border-color:var(--red)}.esc-medium{background:rgba(210,153,34,.08);border-color:var(--yellow)}.esc-low{background:rgba(88,166,255,.06);border-color:var(--blue)}
.esev{font-size:10px;font-weight:700;text-transform:uppercase;margin-bottom:3px}.ebody{font-size:12px}
.eact{display:flex;gap:4px;margin-top:6px}
.eresp{flex:1;min-width:0;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:4px;font-family:inherit;font-size:11px;padding:3px 6px}
.eact button{background:var(--bg3);border:1px solid var(--border);color:var(--text);font-family:inherit;font-size:11px;padding:3px 8px;border-radius:4px;cursor:pointer}
.eact button:hover{border-color:var(--green);color:var(--green)}
.eact button.appr{border-color:var(--green);color:var(--green)}

/* ── Health bars ── */
.hrow{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.hlbl{color:var(--muted);width:65px;font-size:11px;flex-shrink:0}
.hbar{flex:1;height:5px;background:var(--bg3);border-radius:3px;overflow:hidden}
.hfill{height:100%;border-radius:3px;transition:width .4s}
.hval{font-size:11px;width:32px;text-align:right;color:var(--text)}

/* ── Misc ── */
.empty{color:var(--muted);padding:16px 0;text-align:center;font-style:italic;font-size:12px}
.tag-green{color:var(--green)}.tag-blue{color:var(--blue)}.tag-red{color:var(--red)}.tag-yellow{color:var(--yellow)}

/* ── Commands overlay ── */
#cmd-ov{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;z-index:50;align-items:flex-start;justify-content:center;overflow-y:auto;padding:40px 16px}
#cmd-ov.show{display:flex}
.cmd-box{background:var(--bg2);border:1px solid var(--border);border-radius:8px;max-width:760px;width:100%;padding:18px 22px}
.cmd-box h2{font-size:15px;color:var(--blue);margin-bottom:4px;letter-spacing:.04em}
.cmd-box h3{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:16px 0 6px;border-bottom:1px solid var(--border);padding-bottom:3px}
.cmd-sub{color:var(--muted);font-size:12px;margin-bottom:8px}
.cmd-close{float:right;background:var(--bg3);border:1px solid var(--border);color:var(--muted);border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;padding:2px 9px}
.cmd-close:hover{border-color:var(--red);color:var(--red)}
.cmd-onboard{background:var(--bg);border:1px solid var(--green);border-radius:6px;padding:10px 12px;margin-bottom:6px}
.cmd pre,.cmd-onboard pre{background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:8px 10px;overflow-x:auto;font-family:inherit;font-size:12px;color:var(--text);white-space:pre-wrap;word-break:break-word;margin:4px 0}
.cmd-tbl{width:100%;border-collapse:collapse;font-size:12px}
.cmd-tbl td{padding:3px 8px;border-bottom:1px solid rgba(48,54,61,.5);vertical-align:top}
.cmd-tbl td:first-child{color:var(--blue);white-space:nowrap;font-weight:600}
.cmd-tbl td:last-child{color:var(--muted)}
.k{color:var(--green)}
</style>
</head>
<body>
<div id="app">
  <div id="hdr">
    <span class="logo">&#9632; SWARM</span>
    <span class="sep">|</span>
    <span class="stat" id="h-project">project: <b>—</b></span>
    <span class="sep">|</span>
    <span class="stat" id="h-agents">agents: <b>—</b></span>
    <span class="sep">|</span>
    <span class="stat" id="h-tasks">tasks: <b>—</b></span>
    <span class="sep">|</span>
    <span><span class="dot spin" id="conn-dot"></span><span id="conn-txt" style="font-size:11px">connecting</span></span>
    <button class="rbtn" style="border-color:var(--green);color:var(--green)" onclick="toggleCommands(true)">&#9881; Commands</button>
    <button class="rbtn" onclick="fetchNow()">&#8635; Refresh</button>
    <button class="rbtn" style="border-color:var(--yellow);color:var(--yellow)" onclick="doControl('stop-workers','Stop all LLM workers? (server + dashboard stay up)')">&#9209; Stop workers</button>
    <button class="rbtn" style="border-color:var(--red);color:var(--red)" onclick="doControl('stop-all','Stop EVERYTHING (workers + server + dashboard)?')">&#9632; Stop all</button>
    <span class="refresh-time" id="rtime"></span>
  </div>
  <div id="grid">
    <div class="panel">
      <div class="ph">&#9632; Agents <span class="cnt" id="cnt-agents">0</span></div>
      <div class="pb" id="b-team"><div class="empty">Loading…</div></div>
    </div>
    <div class="panel">
      <div class="ph">&#9670; Tasks <span class="cnt" id="cnt-tasks">0</span></div>
      <div style="display:flex;gap:4px;padding:6px 10px;border-bottom:1px solid var(--border);background:var(--bg2)">
        <input id="nt-title" placeholder="new task → send to the board…" style="flex:1;min-width:0;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:4px;font-family:inherit;font-size:11px;padding:3px 6px" onkeydown="if(event.key==='Enter')doCreateTask()"/>
        <select id="nt-prio" style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:4px;font-family:inherit;font-size:11px;padding:2px"><option value="high">high</option><option value="critical">critical</option><option value="medium" selected>medium</option><option value="low">low</option></select>
        <input id="nt-tags" placeholder="tags" style="width:80px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:4px;font-family:inherit;font-size:11px;padding:3px 6px"/>
        <button onclick="doCreateTask()" style="background:var(--yellow);color:#000;border:none;border-radius:4px;cursor:pointer;font-size:11px;padding:3px 10px;font-weight:700">Add</button>
      </div>
      <div class="pb" id="b-tasks"><div class="empty">Loading…</div></div>
    </div>
    <div class="panel">
      <div class="ph">&#9675; Message Flow <span class="cnt" id="cnt-msgs">0</span></div>
      <div style="display:flex;gap:5px;padding:6px 10px;border-bottom:1px solid var(--border);background:var(--bg2)">
        <select id="inj-agent" style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:4px;font-family:inherit;font-size:11px;padding:2px"></select>
        <input id="inj-text" placeholder="inject a message…" style="flex:1;min-width:0;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:4px;font-family:inherit;font-size:11px;padding:3px 6px" onkeydown="if(event.key==='Enter')doInject()"/>
        <button onclick="doInject()" style="background:var(--blue);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;padding:3px 10px">Send</button>
      </div>
      <div style="display:flex;gap:4px;padding:4px 10px;border-bottom:1px solid var(--border);background:var(--bg2);font-size:11px;align-items:center">
        <span style="color:var(--muted)">Filter:</span>
        <select id="flt-agent" onchange="applyMsgFilter()" style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:4px;font-family:inherit;font-size:10px;padding:2px"><option value="">all agents</option></select>
        <select id="flt-type" onchange="applyMsgFilter()" style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:4px;font-family:inherit;font-size:10px;padding:2px"><option value="">all types</option><option value="room">room</option><option value="in">direct (in)</option><option value="out">output (out)</option></select>
        <input id="flt-text" placeholder="search…" oninput="applyMsgFilter()" style="flex:1;min-width:60px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:4px;font-family:inherit;font-size:10px;padding:2px 6px"/>
      </div>
      <div class="pb" id="b-msgs"><div class="empty">Loading…</div></div>
    </div>
    <div class="panel">
      <div class="ph">&#9711; Health &amp; Escalations <span class="cnt" id="cnt-escs">0</span></div>
      <div class="pb" id="b-health"><div class="empty">Loading…</div></div>
    </div>
  </div>
</div>

<!-- ── Commands / onboarding overlay ── -->
<div id="cmd-ov" onclick="if(event.target===this)toggleCommands(false)">
  <div class="cmd-box">
    <button class="cmd-close" onclick="toggleCommands(false)">&#10005; close</button>
    <h2>&#9881; Swarm commands</h2>
    <div class="cmd-sub">Run these from inside the repo. The swarm needs no API key — each CLI agent (Codex, Gemini, Claude) is the brain; <span class="k">swarm-cli.js</span> is its hands.</div>

    <h3>Add a non-Claude worker (onboard)</h3>
    <div class="cmd-onboard">
      <div class="cmd-sub" style="margin-bottom:4px">Paste into a Codex&nbsp;CLI / Gemini&nbsp;CLI session. Step&nbsp;1 registers it; step&nbsp;2 keeps it working.</div>
      <pre>cd "__SWARM_ROOT__"

# 1) join once (pick a name + capabilities)
node lib/swarm-cli.js join "Codex-Bob" backend,api

# 2) work continuously — never exit after a task
node lib/swarm-cli.js loop</pre>
      <div class="cmd-sub" style="margin:2px 0 0">A direct message you send below lands in that worker's inbox — it shows up on the next <span class="k">inbox</span> / <span class="k">loop</span> tick.</div>
    </div>

    <h3>Operate (any agent)</h3>
    <table class="cmd-tbl">
      <tr><td>inbox</td><td>your assigned tasks + unread messages — check this first</td></tr>
      <tr><td>next</td><td>best open task to claim right now</td></tr>
      <tr><td>claim &lt;id&gt;</td><td>claim an open task</td></tr>
      <tr><td>done &lt;id&gt; "&lt;result&gt;"</td><td>finish a task — result must be your real output</td></tr>
      <tr><td>room ["&lt;text&gt;"]</td><td>view or post to the shared common room</td></tr>
      <tr><td>msg &lt;name&gt; "&lt;text&gt;"</td><td>direct-message another agent</td></tr>
      <tr><td>status</td><td>team + task overview</td></tr>
    </table>

    <h3>Lead only</h3>
    <table class="cmd-tbl">
      <tr><td>delegate</td><td>split big tasks + hand parts out to the best agents</td></tr>
      <tr><td>assign &lt;id&gt; &lt;name&gt;</td><td>assign a task to a specific agent</td></tr>
      <tr><td>split &lt;id&gt; "A" "B"</td><td>break a task into subtasks by hand</td></tr>
      <tr><td>lead [name]</td><td>make yourself (or someone) the lead</td></tr>
    </table>
    <div class="cmd-sub" style="margin-top:10px">Full reference: <span class="k">node lib/swarm-cli.js help</span></div>
  </div>
</div>

<script>
function e(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function toggleCommands(show){document.getElementById('cmd-ov').classList.toggle('show',!!show)}
document.addEventListener('keydown',ev=>{if(ev.key==='Escape')toggleCommands(false)});
function shortId(id){return id?String(id).slice(0,8):'?'}
function agentName(id,agents){if(!id)return'none';const a=agents.find(a=>a.id===id);return a?a.name:shortId(id)}
function partyName(id,agents){if(!id)return'?';if(id==='human')return'human';if(id==='room')return'Common Room';if(id==='broadcast')return'everyone';if(id==='panel')return'dashboard';return agentName(id,agents)}

function renderTeam(state){
  const agents=state.agents||[];
  if(!agents.length)return'<div class="empty">No agents registered</div>';
  const roles=(state.hierarchy||{}).roles||{};
  const lead=(state.hierarchy||{}).lead;
  const sdot=s=>{const m={idle:'s-idle',working:'s-working',reviewing:'s-reviewing',offline:'s-offline',credits_exhausted:'s-credits_exhausted',error:'s-error'};return'<span class="adot '+(m[s]||'s-offline')+'"></span>'};
  const row=a=>{
    const caps=Array.isArray(a.capabilities)?a.capabilities.join(','):'';
    const task=a.current_task?'<div class="atask">&#8594; task:'+e(shortId(a.current_task))+'</div>':'';
    const budget=a.max_calls?((a.calls||0)+'/'+a.max_calls):(a.calls?((a.calls)+''):'');
    const meta=e(a.paused?'paused':a.status)+(caps?' &middot; '+e(caps):'')+(budget?' &middot; '+budget+' calls':'');
    const isLead=a.id===lead;
    const b=(act,label,extra)=>'<button class="abtn'+(extra||'')+'" onclick="doAgent(\\''+a.id+'\\',\\''+act+'\\')">'+label+'</button>';
    const bp=(act,label,cur)=>'<button class="abtn" onclick="doAgentPrompt(\\''+a.id+'\\',\\''+act+'\\',\\''+e(cur||'')+'\\')">'+label+'</button>';
    const ctrls='<div class="actrl">'
      +(isLead?'<span class="abtn lead">&#9733; lead</span>':b('lead','&#9733; lead'))
      +(a.paused?b('resume','&#9654; resume',' on'):b('pause','&#9208; pause'))
      +bp('caps','caps',caps)
      +bp('budget','budget',a.max_calls||'')
      +'</div>';
    return'<div class="agent">'+sdot(a.status)+'<div style="flex:1"><div class="aname">'+e(a.name)+'<span style="color:var(--muted);font-weight:400;font-size:11px"> ['+e(a.provider)+']</span></div><div class="ameta">'+meta+'</div>'+task+ctrls+'</div></div>'
  };
  const groups=[
    {lbl:'Lead',f:a=>a.id===lead||roles[a.id]==='lead'},
    {lbl:'Developers',f:a=>roles[a.id]==='developer'||(a.id!==lead&&!roles[a.id])},
    {lbl:'Reviewers',f:a=>roles[a.id]==='reviewer'},
    {lbl:'Testers',f:a=>roles[a.id]==='tester'},
  ];
  let html='';
  for(const g of groups){const m=agents.filter(g.f);if(!m.length)continue;html+='<div class="sh">'+e(g.lbl)+'</div>'+m.map(row).join('')}
  return html||'<div class="empty">No agents</div>'
}

function renderTasks(state){
  const tasks=state.tasks||[];
  const agents=state.agents||[];
  if(!tasks.length)return'<div class="empty">No tasks yet</div>';
  const prio=p=>'<span class="pbadge p-'+(p||'medium')+'">'+e((p||'med').slice(0,4))+'</span>';
  const row=t=>{
    const who=t.assigned_to?'<span class="twho">&#60;'+e(agentName(t.assigned_to,agents))+'&#62;</span>':'';
    const tags=Array.isArray(t.tags)&&t.tags.length?'<div class="ttags">'+t.tags.slice(0,4).map(e).join(' &middot; ')+'</div>':'';
    return'<div class="task"><div class="trow">'+prio(t.priority)+'<span class="tname">'+e(t.title)+'</span>'+who+'</div>'+tags+'</div>'
  };
  const sections=[
    {lbl:'Active',color:'var(--blue)',f:t=>t.status==='in_progress'||t.status==='assigned'},
    {lbl:'Open',color:'var(--text)',f:t=>t.status==='open'},
    {lbl:'Split',color:'var(--yellow)',f:t=>t.status==='split'},
    {lbl:'Done (recent)',color:'var(--green)',f:t=>t.status==='done',limit:6},
  ];
  let html='';
  for(const s of sections){let items=tasks.filter(s.f);if(!items.length)continue;if(s.limit)items=items.slice(-s.limit);html+='<div class="sh" style="color:'+s.color+'">'+s.lbl+' ('+items.length+')</div>'+items.map(row).join('')}
  return html
}

function renderHealth(state){
  const agents=state.agents||[];
  const tasks=state.tasks||[];
  const escs=state.escalations||[];
  let html='';

  if(state.auth&&state.auth.ok===false){
    html+='<div class="esc esc-critical" style="margin-bottom:8px">'
      +'<div class="esev">CLAUDE LOGIN NEEDED</div>'
      +'<div class="ebody">'+e(state.auth.reason||'Claude CLI not logged in.')+' Workers are paused and resume automatically after login.</div>'
      +'</div>';
  }

  if(agents.length){
    const total=agents.length;
    const healthy=agents.filter(a=>!['offline','credits_exhausted','error'].includes(a.status)).length;
    const working=agents.filter(a=>a.status==='working').length;
    html+='<div class="sh">Agent Health</div>';
    const p=v=>Math.round(v/total*100);
    html+='<div class="hrow"><span class="hlbl">Online</span><div class="hbar"><div class="hfill" style="width:'+p(healthy)+'%;background:var(--green)"></div></div><span class="hval">'+healthy+'/'+total+'</span></div>';
    html+='<div class="hrow"><span class="hlbl">Working</span><div class="hbar"><div class="hfill" style="width:'+p(working)+'%;background:var(--blue)"></div></div><span class="hval">'+working+'</span></div>';
  }

  if(tasks.length){
    const total=tasks.length;
    const done=tasks.filter(t=>t.status==='done').length;
    const active=tasks.filter(t=>t.status==='in_progress'||t.status==='assigned').length;
    const open=tasks.filter(t=>t.status==='open').length;
    const p=v=>Math.round(v/total*100);
    html+='<div class="sh" style="margin-top:10px">Task Progress</div>';
    html+='<div class="hrow"><span class="hlbl">Done</span><div class="hbar"><div class="hfill" style="width:'+p(done)+'%;background:var(--green)"></div></div><span class="hval">'+done+'/'+total+'</span></div>';
    html+='<div class="hrow"><span class="hlbl">Active</span><div class="hbar"><div class="hfill" style="width:'+p(active)+'%;background:var(--blue)"></div></div><span class="hval">'+active+'</span></div>';
    html+='<div class="hrow"><span class="hlbl">Open</span><div class="hbar"><div class="hfill" style="width:'+p(open)+'%;background:var(--yellow)"></div></div><span class="hval">'+open+'</span></div>';
  }

  const down=agents.filter(a=>['offline','credits_exhausted','error'].includes(a.status));
  if(down.length){
    html+='<div class="sh" style="margin-top:10px;color:var(--red)">Down Agents</div>';
    for(const a of down)html+='<div style="padding:3px 0;color:var(--red);font-size:12px">&#10005; '+e(a.name)+' ['+e(a.status)+']</div>'
  }

  if(escs.length){
    html+='<div class="sh" style="margin-top:10px;color:var(--red)">Escalations — need your decision ('+escs.length+')</div>';
    for(const ec of escs){
      const who=agentName(ec.agent_id,agents);
      html+='<div class="esc esc-'+(ec.severity||'low')+'">'
        +'<div class="esev">'+e(ec.severity||'?')+' &middot; '+e(who)+' asks</div>'
        +'<div class="ebody">'+e(ec.message_content||'')+'</div>'
        +'<div class="eact"><input class="eresp" id="esc-'+e(ec.id)+'" placeholder="your decision / answer…"/>'
        +'<button onclick="doResolveEsc(\\''+e(ec.id)+'\\')">Send</button>'
        +'<button class="appr" onclick="doResolveEsc(\\''+e(ec.id)+'\\',\\'Approved — go ahead.\\')">Approve</button></div>'
        +'</div>'
    }
  }else{
    html+='<div style="margin-top:10px;color:var(--green);font-size:12px">&#10003; No pending escalations</div>'
  }

  if(!agents.length&&!tasks.length&&!escs.length)return'<div class="empty">No data — run /swarm init first</div>';
  return html
}

function updateHeader(state){
  const cfg=state.config||{};
  const agents=state.agents||[];
  const tasks=state.tasks||[];
  document.getElementById('h-project').innerHTML='project: <b>'+e(cfg.project||'unknown')+'</b>';
  const online=agents.filter(a=>!['offline','credits_exhausted'].includes(a.status)).length;
  document.getElementById('h-agents').innerHTML='agents: <b>'+online+'/'+agents.length+'</b>';
  const open=tasks.filter(t=>t.status==='open').length;
  const active=tasks.filter(t=>t.status==='in_progress'||t.status==='assigned').length;
  const done=tasks.filter(t=>t.status==='done').length;
  document.getElementById('h-tasks').innerHTML='tasks: <b>'+open+' open &middot; '+active+' active &middot; '+done+' done</b>';
  document.getElementById('cnt-agents').textContent=agents.length;
  document.getElementById('cnt-tasks').textContent=tasks.length;
  document.getElementById('cnt-msgs').textContent=(state.flow||[]).length;
  document.getElementById('cnt-escs').textContent=(state.escalations||[]).length;
}

function renderFlow(state){
  const flow=state.flow||[];
  const agents=state.agents||[];
  if(!flow.length)return'<div class="empty">No messages yet. Inject one above &#8593;</div>';
  return flow.slice().reverse().map(m=>{
    const t=m.timestamp?new Date(m.timestamp).toLocaleTimeString():'';
    const isRoom=m.box==='room'||m.to==='room';
    const isCast=m.to==='broadcast';
    const from=partyName(m.from,agents);
    const to=isRoom?'Common Room':partyName(m.to||m.agent,agents);
    const kind=isRoom?'<span class="mkind mk-room">room</span>':(isCast?'<span class="mkind mk-cast">all</span>':'<span class="mkind mk-dm">dm</span>');
    return '<div class="msg" data-box="'+(m.box||'')+'" data-agent="'+(m.agent||m.from||'')+'">'
      +'<span class="mt">'+e(t)+'</span> '+kind
      +'<span class="mf">'+e(from)+'</span><span class="marr">&#8594;</span><span class="mto">'+e(to)+'</span>'
      +'<span class="mbody">: '+e(m.content||'')+'</span></div>';
  }).join('')
}

let _lastFlow=[];
function populateFlowFilters(state){
  const sel=document.getElementById('flt-agent');
  if(!sel)return;
  const cur=sel.value;
  const agents=state.agents||[];
  sel.innerHTML='<option value="">all agents</option>'+agents.map(a=>'<option value="'+e(a.id)+'">'+e(a.name)+'</option>').join('')+'<option value="human">human</option>';
  if(cur)sel.value=cur;
}
function applyMsgFilter(){
  const fa=document.getElementById('flt-agent').value;
  const ft=document.getElementById('flt-type').value;
  const fs=(document.getElementById('flt-text').value||'').toLowerCase();
  const msgs=document.querySelectorAll('#b-msgs .msg');
  msgs.forEach(el=>{
    const txt=el.textContent.toLowerCase();
    const box=el.dataset.box||'';
    const agent=el.dataset.agent||'';
    let show=true;
    if(fa&&agent!==fa)show=false;
    if(ft&&box!==ft)show=false;
    if(fs&&!txt.includes(fs))show=false;
    el.style.display=show?'':'none';
  });
}

function populateInject(state){
  const sel=document.getElementById('inj-agent');
  if(!sel)return;
  const cur=sel.value;
  sel.innerHTML='<option value="room">&#128226; Common Room</option>'+(state.agents||[]).map(a=>'<option value="'+e(a.id)+'">'+e(a.name)+'</option>').join('');
  if(cur)sel.value=cur;
}

function doInject(){
  const agent=document.getElementById('inj-agent').value;
  const text=document.getElementById('inj-text').value.trim();
  if(!agent||!text)return;
  fetch('/api/inject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent:agent,text:text})})
    .then(r=>r.json()).then(()=>{document.getElementById('inj-text').value='';fetchState();})
    .catch(()=>{});
}

function doResolveEsc(id,preset){
  const el=document.getElementById('esc-'+id);
  const v=preset||(el?el.value.trim():'');
  if(!v){alert('Type a decision, or click Approve.');return;}
  fetch('/api/escalation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,decision:v})})
    .then(r=>r.json()).then(j=>{if(j&&j.ok===false)alert('Failed: '+j.error);else fetchState();})
    .catch(e=>alert('Failed: '+e.message));
}

function doCreateTask(){
  const title=document.getElementById('nt-title').value.trim();
  if(!title)return;
  const priority=document.getElementById('nt-prio').value;
  const tags=document.getElementById('nt-tags').value.trim();
  fetch('/api/task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:title,priority:priority,tags:tags})})
    .then(r=>r.json()).then(()=>{document.getElementById('nt-title').value='';document.getElementById('nt-tags').value='';fetchState();})
    .catch(()=>{});
}

async function fetchState(){
  const dot=document.getElementById('conn-dot');
  const txt=document.getElementById('conn-txt');
  try{
    const r=await fetch('/api/state');
    if(!r.ok)throw new Error('HTTP '+r.status);
    const state=await r.json();
    document.getElementById('b-team').innerHTML=renderTeam(state);
    document.getElementById('b-tasks').innerHTML=renderTasks(state);
    document.getElementById('b-msgs').innerHTML=renderFlow(state);
    document.getElementById('b-health').innerHTML=renderHealth(state);
    populateInject(state);
    populateFlowFilters(state);
    applyMsgFilter();
    updateHeader(state);
    dot.className='dot ok';txt.textContent='live';
    document.getElementById('rtime').textContent='updated '+new Date().toLocaleTimeString();
  }catch(err){
    dot.className='dot err';txt.textContent='error: '+err.message;
  }
}

function postAgent(id,action,value){
  return fetch('/api/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,action:action,value:value})})
    .then(r=>r.json()).then(()=>fetchState()).catch(e=>alert('Failed: '+e.message));
}
function doAgent(id,action){ postAgent(id,action); }
function doAgentPrompt(id,action,cur){
  const label=action==='budget'?'Max LLM calls before auto-pause (0 = unlimited):':'Capabilities (comma-separated):';
  const v=prompt(label,cur||'');
  if(v===null)return;
  postAgent(id,action,v);
}

function doControl(action,confirmMsg){
  if(!confirm(confirmMsg))return;
  fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action})})
    .then(r=>r.json()).then(j=>{
      if(action==='stop-all'){document.body.innerHTML='<div style="padding:40px;font-family:monospace;color:#e6edf3">Swarm stopped. You can close this tab.</div>';}
      else{const n=(j.stopped||[]).length;alert(n?('Stopped '+n+' worker(s): '+j.stopped.join(', ')):'No workers running.');fetchState();}
    }).catch(e=>alert('Control failed: '+e.message));
}

function fetchNow(){
  document.getElementById('conn-dot').className='dot spin';
  document.getElementById('conn-txt').textContent='refreshing…';
  fetchState();
}

fetchState();
setInterval(fetchState,3000);
</script>
</body>
</html>`;

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/state') {
    try {
      const state = readState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Inject a message into an agent's inbox (control-panel → agent).
  if (req.url === '/api/inject' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { agent, text } = JSON.parse(body || '{}');
        if (!agent || !text) throw new Error('agent and text required');
        const msg = injectMessage(agent, text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Per-agent control: make lead, pause/resume, edit capabilities/role, set call budget.
  if (req.url === '/api/agent' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { id, action, value } = JSON.parse(body || '{}');
        if (!id || !action) throw new Error('id and action required');
        const r = controlAgent(id, action, value);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Process control (stop workers / stop everything) — e.g. when an LLM runs out of tokens.
  if (req.url === '/api/control' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { action } = JSON.parse(body || '{}');
        const r = controlAction(action);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Resolve a pending escalation (panel → worker decision).
  if (req.url === '/api/escalation' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { id, decision } = JSON.parse(body || '{}');
        if (!id || !decision) throw new Error('id and decision required');
        const esc = resolveEscalationFromPanel(id, decision);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, escalation: esc }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Create a task from the panel (dashboard → board).
  if (req.url === '/api/task' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { title, priority, tags } = JSON.parse(body || '{}');
        if (!title) throw new Error('title required');
        const t = createTaskFromPanel(title, priority, tags);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, task: t }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML.replace(/__SWARM_ROOT__/g, swarmRoot.replace(/[<>&]/g, '')));
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[swarm-dash] Port ${PORT} in use. Try: node dashboard/web.js ${PORT + 1}`);
  } else {
    console.error(`[swarm-dash] ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[swarm-dash] Dashboard running at http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') console.log(`[swarm-dash] LAN-exposed (SWARM_DASH_HOST=0.0.0.0) — reachable at http://<this-machine-ip>:${PORT} (no auth; trusted network only)`);
  console.log(`[swarm-dash] Swarm root: ${swarmRoot}`);
  console.log('[swarm-dash] Press Ctrl+C to stop. Auto-refreshes every 3s.');
});

process.on('SIGINT',  () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
