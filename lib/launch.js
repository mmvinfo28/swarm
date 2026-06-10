#!/usr/bin/env node
'use strict';

// Universal detached launcher for the swarm stack and workers.
// Everything started here survives the launching shell (detached + unref),
// is idempotent (won't double-start a healthy server), and writes PID + logs
// under <root>/.swarm/.run/.
//
// Usage:
//   node lib/launch.js stack     [root] [--ws-port N] [--dash-port N]
//   node lib/launch.js server    [root] [--ws-port N]
//   node lib/launch.js dashboard [root] [--dash-port N]
//   node lib/launch.js agent codex|gemini [root] [caps]
//   node lib/launch.js status    [root]
//   node lib/launch.js stop      [root]

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PLUGIN_ROOT = path.join(__dirname, '..');
const DEFAULT_WS_PORT = parseInt(process.env.SWARM_SERVER_PORT || '9377', 10);
const DEFAULT_DASH_PORT = parseInt(process.env.SWARM_DASH_PORT || '7379', 10);

// ─── Paths ────────────────────────────────────────────────────────────────────

function findSwarmRoot(dir) {
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.swarm'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function runDir(root) {
  const d = path.join(root, '.swarm', '.run');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const pidFile = (root, name) => path.join(runDir(root), `${name}.pid`);
const logFile = (root, name) => path.join(runDir(root), `${name}.log`);
const portsFile = (root) => path.join(runDir(root), 'ports.json');

function readPorts(root) {
  try { return JSON.parse(fs.readFileSync(portsFile(root), 'utf-8')); }
  catch (_) { return {}; }
}

function mergePorts(root, patch) {
  const cur = readPorts(root);
  fs.writeFileSync(portsFile(root), JSON.stringify(Object.assign(cur, patch)), 'utf-8');
}

// ─── PID helpers ────────────────────────────────────────────────────────────────

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = exists but not ours
}

function readPid(root, name) {
  try {
    const pid = parseInt(fs.readFileSync(pidFile(root, name), 'utf-8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch (_) { return null; }
}

function writePid(root, name, pid) {
  fs.writeFileSync(pidFile(root, name), String(pid), 'utf-8');
}

function clearPid(root, name) {
  try { fs.unlinkSync(pidFile(root, name)); } catch (_) {}
}

// ─── Health check ─────────────────────────────────────────────────────────────

function health(port, cb) {
  const req = http.get(
    { host: '127.0.0.1', port, path: '/health', timeout: 1500 },
    (res) => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try { cb(res.statusCode === 200, JSON.parse(body)); }
        catch (_) { cb(res.statusCode === 200, null); }
      });
    }
  );
  req.on('error', () => cb(false, null));
  req.on('timeout', () => { req.destroy(); cb(false, null); });
}

// ─── Spawn detached ──────────────────────────────────────────────────────────

function spawnDetached(root, name, command, args, extraEnv) {
  const out = fs.openSync(logFile(root, name), 'a');
  const child = spawn(command, args, {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, { SWARM_ROOT: root }, extraEnv || {}),
    windowsHide: true,
  });
  child.unref();
  writePid(root, name, child.pid);
  return child.pid;
}

function resolvePython() {
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', windowsHide: true });
      if (r.status === 0) return cmd;
    } catch (_) {}
  }
  return null;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function startServer(root, wsPort, done) {
  const existing = readPid(root, 'server');
  if (isAlive(existing)) {
    health(wsPort, (ok) => {
      if (ok) { console.log(`[server]    already running (pid ${existing}) at ws://localhost:${wsPort}/ws`); done(true); }
      else    { console.log(`[server]    stale pid ${existing}, restarting...`); clearPid(root, 'server'); reallyStartServer(root, wsPort, done); }
    });
    return;
  }
  reallyStartServer(root, wsPort, done);
}

function reallyStartServer(root, wsPort, done) {
  const pid = spawnDetached(root, 'server', process.execPath,
    [path.join(PLUGIN_ROOT, 'lib', 'server.js'), String(wsPort), root]);
  mergePorts(root, { ws: wsPort });
  // Poll health briefly to confirm it came up.
  let tries = 0;
  const tick = () => {
    health(wsPort, (ok) => {
      if (ok) { console.log(`[server]    started (pid ${pid}) at ws://localhost:${wsPort}/ws`); done(true); }
      else if (++tries < 10) { setTimeout(tick, 300); }
      else { console.log(`[server]    spawned (pid ${pid}) — health not confirmed; see ${logFile(root, 'server')}`); done(false); }
    });
  };
  setTimeout(tick, 300);
}

function startDashboard(root, dashPort, done) {
  const existing = readPid(root, 'dashboard');
  if (isAlive(existing)) {
    console.log(`[dashboard] already running (pid ${existing}) at http://localhost:${dashPort}`);
    done(true);
    return;
  }
  const pid = spawnDetached(root, 'dashboard', process.execPath,
    [path.join(PLUGIN_ROOT, 'dashboard', 'web.js'), String(dashPort), root]);
  mergePorts(root, { dash: dashPort });
  console.log(`[dashboard] started (pid ${pid}) at http://localhost:${dashPort}`);
  done(true);
}

function startAgent(root, provider, caps) {
  const adapter = provider === 'gemini'
    ? path.join(PLUGIN_ROOT, 'adapters', 'gemini-wrapper.py')
    : path.join(PLUGIN_ROOT, 'adapters', 'codex-wrapper.py');

  if (!fs.existsSync(adapter)) { console.error(`[agent] adapter not found: ${adapter}`); return; }

  const python = resolvePython();
  if (!python) { console.error('[agent] no python interpreter found (tried python, python3, py)'); return; }

  const name = `agent-${provider}`;
  const existing = readPid(root, name);
  if (isAlive(existing)) {
    console.log(`[agent] ${provider} already running (pid ${existing}). Stop it first: node lib/launch.js stop`);
    return;
  }

  const args = [adapter, '--swarm-root', root];
  if (caps) args.push('--capabilities', caps);

  const pid = spawnDetached(root, name, python, args);
  console.log(`[agent] ${provider} started (pid ${pid}) caps=[${caps || ''}] → log: ${logFile(root, name)}`);
  const key = provider === 'gemini' ? 'GEMINI_API_KEY' : 'CODEX_API_KEY / OPENAI_API_KEY';
  if (provider === 'gemini' ? !process.env.GEMINI_API_KEY
                            : !(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY)) {
    console.log(`[agent] WARNING: ${key} not set — agent will idle. Set it, or use SWARM_FAKE_LLM=1 to test.`);
  }
}

function startWorker(root, provider, name, caps, interval) {
  const wname = 'worker-' + String(name || provider).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const existing = readPid(root, wname);
  if (isAlive(existing)) {
    console.log(`[worker] ${name} already running (pid ${existing}). Stop first: node lib/launch.js stop`);
    return;
  }
  const args = [path.join(PLUGIN_ROOT, 'lib', 'runner.js'),
    '--root', root, '--provider', provider, '--name', name, '--caps', caps || '', '--interval', String(interval || 30)];
  const pid = spawnDetached(root, wname, process.execPath, args);
  console.log(`[worker] ${name} (${provider}) started (pid ${pid}) → log: ${logFile(root, wname)}`);
  if (provider === 'claude') {
    console.log(`[worker] driver: claude headless (no API key). Set SWARM_DRIVER=fake to test free.`);
  }
}

function status(root) {
  const ports = readPorts(root);
  const wsPort = ports.ws || DEFAULT_WS_PORT;
  const dashPort = ports.dash || DEFAULT_DASH_PORT;
  console.log(`Swarm processes for ${root}:`);
  const names = fs.existsSync(runDir(root))
    ? fs.readdirSync(runDir(root)).filter(f => f.endsWith('.pid')).map(f => f.replace(/\.pid$/, ''))
    : [];
  if (!names.length) { console.log('  (none tracked)'); return; }

  let pending = names.length;
  for (const name of names) {
    const pid = readPid(root, name);
    const alive = isAlive(pid);
    if (name === 'server') {
      health(wsPort, (ok) => {
        console.log(`  server     pid ${pid} ${alive ? 'ALIVE' : 'DEAD '}  health:${ok ? 'OK' : 'down'}  ws://localhost:${wsPort}/ws`);
        if (--pending === 0) {}
      });
    } else {
      const where = name === 'dashboard' ? `  http://localhost:${dashPort}` : '';
      console.log(`  ${name.padEnd(10)} pid ${pid} ${alive ? 'ALIVE' : 'DEAD '}${where}`);
      if (--pending === 0) {}
    }
  }
}

function stop(root) {
  if (!fs.existsSync(runDir(root))) { console.log('Nothing to stop.'); return; }
  const names = fs.readdirSync(runDir(root)).filter(f => f.endsWith('.pid')).map(f => f.replace(/\.pid$/, ''));
  if (!names.length) { console.log('Nothing to stop.'); return; }
  for (const name of names) {
    const pid = readPid(root, name);
    if (isAlive(pid)) {
      try { process.kill(pid); console.log(`  stopped ${name} (pid ${pid})`); }
      catch (e) { console.log(`  could not stop ${name} (pid ${pid}): ${e.message}`); }
    } else {
      console.log(`  ${name} not running`);
    }
    clearPid(root, name);
  }
  // Remove stale markers
  try { fs.unlinkSync(path.join(root, '.swarm', '.server-url')); } catch (_) {}
  try { fs.unlinkSync(portsFile(root)); } catch (_) {}
}

// ─── Arg parsing + dispatch ──────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { positional: [], wsPort: DEFAULT_WS_PORT, dashPort: DEFAULT_DASH_PORT, interval: 5 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ws-port' && argv[i + 1]) out.wsPort = parseInt(argv[++i], 10);
    else if (argv[i] === '--dash-port' && argv[i + 1]) out.dashPort = parseInt(argv[++i], 10);
    else if (argv[i] === '--interval' && argv[i + 1]) out.interval = parseInt(argv[++i], 10);
    else out.positional.push(argv[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);

  if (!cmd) {
    console.error('usage: launch.js <stack|server|dashboard|agent|status|stop> [root] [options]');
    process.exit(1);
  }

  // For `agent`/`worker`, positional[0] is provider, positional[1] is root.
  let root;
  if (cmd === 'agent' || cmd === 'worker') {
    root = a.positional[1] || findSwarmRoot(process.cwd());
  } else {
    root = a.positional[0] || findSwarmRoot(process.cwd());
  }

  if (!root || !fs.existsSync(path.join(root, '.swarm'))) {
    console.error(`[launch] no .swarm/ found at: ${root || '(none)'} — run /swarm init first.`);
    process.exit(1);
  }

  switch (String(cmd)) {
    case 'stack':
      startServer(root, a.wsPort, () => {
        startDashboard(root, a.dashPort, () => {
          console.log('');
          console.log(`Stack up. Dashboard: http://localhost:${a.dashPort}  |  WS: ws://localhost:${a.wsPort}/ws`);
          console.log('Stop with: node lib/launch.js stop');
          process.exit(0);
        });
      });
      break;
    case 'server':
      startServer(root, a.wsPort, () => process.exit(0));
      break;
    case 'dashboard':
      startDashboard(root, a.dashPort, () => process.exit(0));
      break;
    case 'agent': {
      const provider = (a.positional[0] || 'codex').toLowerCase();
      const caps = a.positional[2] || process.env.SWARM_CAPABILITIES || '';
      if (provider !== 'codex' && provider !== 'gemini') {
        console.error(`[agent] unknown provider "${provider}" (use codex or gemini)`);
        process.exit(1);
      }
      startAgent(root, provider, caps);
      process.exit(0);
      break;
    }
    case 'worker': {
      const provider = (a.positional[0] || 'claude').toLowerCase();
      const name = a.positional[2] || `${provider}-${Math.floor(Math.random()*1000)}`;
      const caps = a.positional[3] || process.env.SWARM_CAPABILITIES || '';
      startWorker(root, provider, name, caps, a.interval);
      process.exit(0);
      break;
    }
    case 'status':
      status(root);
      break;
    case 'stop':
      stop(root);
      process.exit(0);
      break;
    default:
      console.error(`[launch] unknown command: ${cmd}`);
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { startServer, startDashboard, startAgent, status, stop, isAlive, health };
