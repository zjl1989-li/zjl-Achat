// CDP check: the launcher switch now lives in the settings panel, one per agent.
// Uses a throwaway agent so the boss's real data is never touched.
import { spawn } from 'node:child_process';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TMP = 'C:/Users/wsx/AppData/Local/Temp/achat-run-' + Date.now();
const NODE = 'C:/Users/wsx/.workbuddy/binaries/node/versions/22.22.2-2/node.exe';
const API = 'http://127.0.0.1:8787';
const TMPNAME = '__launch_probe_test__';
const errors = [];

const apiPost = (p, body) => fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const apiGet = (p) => fetch(API + p).then(r => r.json());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// --- create a throwaway agent with a real (harmless) local service ---
const created = await (await apiPost('/api/agents', {
  name: TMPNAME, color: '#888888', adapterType: 'A', role: 'temp', model: 'x',
  skills: [], system: '', status: 'offline', guiPath: '',
  config: {
    launcher: { enabled: false, service: NODE, serviceArgs: ['-e', 'setInterval(() => {}, 1000)'], cwd: 'D:/Projects/zjl-achat' },
  },
})).json();
const tmpId = created.id;
console.log('temp agent created:', tmpId);

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9342', '--user-data-dir=' + TMP,
  '--window-size=1400,900', 'http://127.0.0.1:8787/',
], { stdio: 'ignore', detached: true });
const cleanup = () => { try { process.kill(-edge.pid); } catch {} };
await sleep(3500);

let list = await (await fetch('http://127.0.0.1:9342/json/list')).json();
const page = list.find(t => t.type === 'page' && t.url.includes('8787'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('ERR: ' + m.params.entry.text);
};
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(res => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Log.enable');
await sleep(1200);

const cardInfo = () => evalJs(`(() => {
  const c = [...document.querySelectorAll('#agentRegistry .agent-card')].find(x => (x.querySelector('.ac-name')||{}).textContent === ${JSON.stringify(TMPNAME)});
  if (!c) return { found: false };
  const b = c.querySelector('.runbtn');
  return { found: true, hasRun: !!b, state: (c.querySelector('.runstate')||{}).textContent, on: b ? b.classList.contains('on') : null };
})()`);
const clickRun = () => evalJs(`(() => {
  const c = [...document.querySelectorAll('#agentRegistry .agent-card')].find(x => (x.querySelector('.ac-name')||{}).textContent === ${JSON.stringify(TMPNAME)});
  const b = c && c.querySelector('.runbtn'); if (!b) return 'no button';
  b.click(); return 'clicked';
})()`);

// 1) group header must be free of launcher switches
await evalJs(`(() => { const g = document.querySelectorAll('#groupList .gitem')[0]; if (g) g.click(); return 1; })()`);
await sleep(900);
console.log('\n1) GROUP HEADER');
console.log('   old .pw switches :', await evalJs(`document.querySelectorAll('#memberAvatars .pw').length`), '(expect 0)');
console.log('   avatars          :', await evalJs(`document.querySelectorAll('#memberAvatars .av').length`));

// 2) settings panel: only agents with a launcher get a run switch
await evalJs(`document.querySelector('#btnSettings').click()`);
await sleep(1000);
const all = await evalJs(`[...document.querySelectorAll('#agentRegistry .agent-card')].map(c => ({
  name: (c.querySelector('.ac-name')||{}).textContent, hasRun: !!c.querySelector('.runbtn'),
}))`);
console.log('\n2) SETTINGS PANEL (switch only where a local service exists)');
all.forEach(c => console.log('   ', String(c.name).padEnd(26), '| runSwitch:', c.hasRun));

console.log('\n   temp agent card  :', JSON.stringify(await cardInfo()));

// 3) round trip: click to start -> process really spawns -> click to stop -> dies
console.log('\n3) START / STOP ROUND TRIP');
console.log('   click  :', await clickRun());
await sleep(2500);
const st1 = (await apiGet('/api/agents')).find(a => a.id === tmpId);
console.log('   server launched  :', st1.launched, '| UI:', JSON.stringify(await cardInfo()));
const pid1 = st1.launched ? (await (await apiPost(`/api/agents/${tmpId}/launch`, {})).json()).servicePid : null;
if (pid1) console.log('   service pid', pid1, 'alive:', alive(pid1));

console.log('   click  :', await clickRun());
await sleep(2000);
const st2 = (await apiGet('/api/agents')).find(a => a.id === tmpId);
console.log('   server launched  :', st2.launched, '| UI:', JSON.stringify(await cardInfo()));
if (pid1) console.log('   service pid', pid1, 'still alive:', alive(pid1), '(expect false)');

// 4) remove the throwaway agent
const del = await fetch(`${API}/api/agents/${tmpId}`, { method: 'DELETE' }).then(r => r.json()).catch(e => ({ err: e.message }));
const left = (await apiGet('/api/agents')).filter(a => a.id === tmpId).length;
console.log('\n4) CLEANUP: deleted =', JSON.stringify(del).slice(0, 60), '| still present:', left);

console.log('\nERRORS:', errors.length ? errors : 'none');
ws.close(); cleanup();
process.exit(0);
