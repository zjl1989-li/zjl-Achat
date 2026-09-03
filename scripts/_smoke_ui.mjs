// Headless UI smoke test: load the app, collect console errors / page errors,
// verify the send button is now an SVG and the message list renders.
// Temp script - run once, then delete.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const dir = mkdtempSync(join(tmpdir(), 'achat-smoke-'));

const edge = spawn(EDGE, [
  `--headless=new`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
  '--no-first-run', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageWs() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('no debug page');
}

const wsUrl = await getPageWs();
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });

let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description || 'exception');
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value).join(' '));
};
function call(method, params) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await call('Runtime.enable');

// errors observed before navigation must not pollute the result
await sleep(200);
errors.length = 0;
await call('Page.enable');
await call('Page.navigate', { url: 'http://127.0.0.1:8787' });
await sleep(2500);

const check = await call('Runtime.evaluate', {
  expression: `(() => ({
    title: document.title,
    sendIsSvg: !!document.querySelector('#btnSend svg'),
    msgBox: !!document.querySelector('#messages'),
    leftGroups: document.querySelectorAll('.group-item, #groupList > *').length,
    bodyClass: document.body.className,
  }))()`,
  returnByValue: true,
});
console.log('UI:', JSON.stringify(check.result?.result?.value));
await sleep(500);
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');

ws.close();
edge.kill();
process.exit(errors.length ? 1 : 0);
