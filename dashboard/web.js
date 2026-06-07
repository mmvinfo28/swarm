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
  return t;
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
.tname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.twho{color:var(--purple);font-size:11px;flex-shrink:0}
.ttags{color:var(--muted);font-size:11px;margin-top:2px;padding-left:2px}

/* ── Section header ── */
.sh{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:8px 0 3px;padding-bottom:3px;border-bottom:1px solid var(--border)}

/* ── Message ── */
.msg{padding:3px 0;border-bottom:1px solid rgba(48,54,61,.4);font-size:12px;line-height:1.4}.msg:last-child{border-bottom:none}
.mt{color:var(--muted);margin-right:5px;font-size:11px}.mf{color:var(--blue)}.mto{color:var(--purple)}.marr{color:var(--border);margin:0 2px}.mbody{color:var(--text)}

/* ── Escalation ── */
.esc{padding:7px 9px;border-radius:4px;margin-bottom:5px;border-left:3px solid}
.esc-high{background:rgba(248,81,73,.08);border-color:var(--red)}.esc-medium{background:rgba(210,153,34,.08);border-color:var(--yellow)}.esc-low{background:rgba(88,166,255,.06);border-color:var(--blue)}
.esev{font-size:10px;font-weight:700;text-transform:uppercase;margin-bottom:3px}.ebody{font-size:12px}

/* ── Health bars ── */
.hrow{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.hlbl{color:var(--muted);width:65px;font-size:11px;flex-shrink:0}
.hbar{flex:1;height:5px;background:var(--bg3);border-radius:3px;overflow:hidden}
.hfill{height:100%;border-radius:3px;transition:width .4s}
.hval{font-size:11px;width:32px;text-align:right;color:var(--text)}

/* ── Misc ── */
.empty{color:var(--muted);padding:16px 0;text-align:center;font-style:italic;font-size:12px}
.tag-green{color:var(--green)}.tag-blue{color:var(--blue)}.tag-red{color:var(--red)}.tag-yellow{color:var(--yellow)}
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
    <button class="rbtn" onclick="fetchNow()">&#8635; Refresh</button>
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
      <div class="pb" id="b-msgs"><div class="empty">Loading…</div></div>
    </div>
    <div class="panel">
      <div class="ph">&#9711; Health &amp; Escalations <span class="cnt" id="cnt-escs">0</span></div>
      <div class="pb" id="b-health"><div class="empty">Loading…</div></div>
    </div>
  </div>
</div>

<script>
function e(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function shortId(id){return id?String(id).slice(0,8):'?'}
function agentName(id,agents){if(!id)return'none';const a=agents.find(a=>a.id===id);return a?a.name:shortId(id)}

function renderTeam(state){
  const agents=state.agents||[];
  if(!agents.length)return'<div class="empty">No agents registered</div>';
  const roles=(state.hierarchy||{}).roles||{};
  const lead=(state.hierarchy||{}).lead;
  const sdot=s=>{const m={idle:'s-idle',working:'s-working',reviewing:'s-reviewing',offline:'s-offline',credits_exhausted:'s-credits_exhausted',error:'s-error'};return'<span class="adot '+(m[s]||'s-offline')+'"></span>'};
  const row=a=>{
    const caps=Array.isArray(a.capabilities)?a.capabilities.slice(0,4).join(', '):'';
    const task=a.current_task?'<div class="atask">&#8594; task:'+e(shortId(a.current_task))+'</div>':'';
    return'<div class="agent">'+sdot(a.status)+'<div style="flex:1"><div class="aname">'+e(a.name)+'<span style="color:var(--muted);font-weight:400;font-size:11px"> ['+e(a.provider)+']</span></div><div class="ameta">'+e(a.status)+(caps?' &middot; '+e(caps):'')+'</div>'+task+'</div></div>'
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

function renderMessages(state){
  const msgs=(state.messages||[]).slice().reverse().slice(0,30);
  const agents=state.agents||[];
  if(!msgs.length)return'<div class="empty">No messages</div>';
  const icons={chat:'&#9656;',help_request:'?',knowledge_share:'*',task_handoff:'~',credit_alert:'$',status_update:'i',auto_reply:'&laquo;',priority_change:'^'};
  return msgs.map(m=>{
    const from=agentName(m.from,agents);
    const to=m.to==='broadcast'?'ALL':agentName(m.to,agents);
    const t=m.timestamp?new Date(m.timestamp).toLocaleTimeString():'';
    const icon=icons[m.type]||'&#9656;';
    const body=String(m.content||'').slice(0,80);
    return'<div class="msg"><span class="mt">'+e(t)+'</span>'+icon+' <span class="mf">'+e(from)+'</span><span class="marr">&#8594;</span><span class="mto">'+e(to)+'</span>: <span class="mbody">'+e(body)+'</span></div>'
  }).join('')
}

function renderHealth(state){
  const agents=state.agents||[];
  const tasks=state.tasks||[];
  const escs=state.escalations||[];
  let html='';

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
    html+='<div class="sh" style="margin-top:10px;color:var(--red)">Escalations ('+escs.length+')</div>';
    for(const ec of escs){
      html+='<div class="esc esc-'+(ec.severity||'low')+'"><div class="esev">'+e(ec.severity||'?')+'</div><div class="ebody">'+e((ec.message_content||'').slice(0,120))+'</div></div>'
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
    const who=m.from==='human'?'human':agentName(m.agent,agents);
    const dir=m.box==='room'?'<span style="color:var(--purple)">room</span>':(m.box==='in'?'<span style="color:var(--green)">in&#8594;</span>':'<span style="color:var(--blue)">&#8592;out</span>');
    return '<div class="msg"><span class="mt">'+e(t)+'</span> '+dir+' <span class="mf">'+e(who)+'</span>: <span class="mbody">'+e((m.content||'').slice(0,90))+'</span></div>';
  }).join('')
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
    updateHeader(state);
    dot.className='dot ok';txt.textContent='live';
    document.getElementById('rtime').textContent='updated '+new Date().toLocaleTimeString();
  }catch(err){
    dot.className='dot err';txt.textContent='error: '+err.message;
  }
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
  res.end(HTML);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[swarm-dash] Port ${PORT} in use. Try: node dashboard/web.js ${PORT + 1}`);
  } else {
    console.error(`[swarm-dash] ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[swarm-dash] Dashboard running at http://localhost:${PORT}`);
  console.log(`[swarm-dash] Swarm root: ${swarmRoot}`);
  console.log('[swarm-dash] Press Ctrl+C to stop. Auto-refreshes every 3s.');
});

process.on('SIGINT',  () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
