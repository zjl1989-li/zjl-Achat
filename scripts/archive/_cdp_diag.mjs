import { spawn } from 'node:child_process';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TMP = 'C:/Users/wsx/AppData/Local/Temp/achat-diag2-' + Date.now();
const NODE = 'C:/Users/wsx/.workbuddy/binaries/node/versions/22.22.2-2/node.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TMPNAME = '__probe2__';
const c = await (await fetch('http://127.0.0.1:8787/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
  name: TMPNAME, color: '#888', adapterType: 'A', role: 't', model: 'x', skills: [], system: '', status: 'offline', guiPath: '',
  config: { launcher: { enabled: false, service: NODE, serviceArgs: ['-e', 'setInterval(()=>{},1000)'], cwd: 'D:/Projects/zjl-achat' } },
}) })).json();
const tmpId = c.id;
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9341', '--user-data-dir=' + TMP, '--window-size=1400,900',
  'http://127.0.0.1:8787/'], { stdio: 'ignore', detached: true });
await sleep(3500);
const list = await (await fetch('http://127.0.0.1:9341/json/list')).json();
const page = list.find(t => t.type === 'page' && t.url.includes('8787'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(res => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return 'JSERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Runtime.enable'); await sleep(1000);

console.log('--- in-page API view of agents ---');
console.log(await ev(`fetch('/api/agents').then(r=>r.json()).then(a=>a.map(x=>x.name+' :: launcher='+!!(x.config&&x.config.launcher)).join('\\n'))`));

console.log('\n--- group header innerHTML ---');
await ev(`(() => { const g = document.querySelectorAll('#groupList .gitem')[0]; if (g) g.click(); return 1; })()`);
await sleep(900);
console.log(await ev(`document.querySelector('#memberAvatars').innerHTML.slice(0, 600)`));
console.log('\n.pw count:', await ev(`document.querySelectorAll('#memberAvatars .pw').length`));

console.log('\n--- settings: temp card outerHTML ---');
await ev(`document.querySelector('#btnSettings').click()`);
await sleep(1200);
console.log(await ev(`(() => { const c=[...document.querySelectorAll('#agentRegistry .agent-card')].find(x=>(x.querySelector('.ac-name')||{}).textContent===${JSON.stringify(TMPNAME)}); return c ? c.querySelector('.ac-top').outerHTML : 'NOT FOUND'; })()`));

await fetch('http://127.0.0.1:8787/api/agents/' + tmpId, { method: 'DELETE' });
console.log('\ntemp agent deleted');
ws.close(); try { process.kill(-edge.pid); } catch {}
process.exit(0);
