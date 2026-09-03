// M5 verification: E (MCP) + F (A2A) adapters end-to-end against mock servers.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describeProbe, createAdapter } from '../server/adapters.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

// ---- 1. classify + createAdapter routing ----
console.log('[1] 分类与路由');
ok(describeProbe({ config: { mcp: { command: 'x' } } }).type === 'E', 'mcp -> E');
ok(describeProbe({ config: { a2a: 'http://x' } }).type === 'F', 'a2a -> F');
ok(createAdapter({ id: 'e1', config: { mcp: { command: 'x' } } }).constructor.name === 'McpAdapter', 'createAdapter(E) -> McpAdapter');
ok(createAdapter({ id: 'f1', config: { a2a: 'http://x' } }).constructor.name === 'ProtocolAdapter', 'createAdapter(F) -> ProtocolAdapter');
{
  const m = createAdapter({ id: 'e1', config: { mcp: { command: 'x' } } }).meta();
  ok(m.adapterType === 'E' && m.capabilities.includes('mcp'), 'McpAdapter.meta 含 mcp 能力');
}

// ---- 2. E: MCP stdio end-to-end against mock server ----
console.log('[2] E 类 MCP stdio 端到端');
{
  const agent = {
    id: 'mcp-echo', name: 'mcp-echo',
    config: { mcp: { command: NODE, args: [join(__dir, '_mock_mcp_stdio.mjs')] } },
  };
  const a = new (createAdapter(agent).constructor)(agent);
  const pingOk = await a.ping();
  ok(pingOk, 'MCP ping（initialize + tools/list）成功');
  let events = [];
  const res = await a.send({ messages: [{ role: 'user', content: '你好 MCP' }], onEvent: (e) => events.push(e) });
  ok(res.text === '[mock-mcp] 你好 MCP', 'MCP send 返回工具回文: ' + JSON.stringify(res.text));
  ok(events.some((e) => e.kind === 'step' && /MCP/.test(e.step)), 'MCP send 产出 step 事件');
}

// ---- 3. F: A2A HTTP end-to-end against mock server ----
console.log('[3] F 类 A2A 端到端');
{
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('agent.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'mock-a2a', url: `http://127.0.0.1:${PORT}/rpc` }));
      return;
    }
    if (req.url === '/rpc') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        const j = JSON.parse(b);
        const text = j.params?.message?.parts?.[0]?.text || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { id: j.params.id, status: { state: 'completed', message: { role: 'agent', parts: [{ type: 'text', text: '[a2a] ' + text }] } } } }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, r));
  const PORT = server.address().port;
  const agent = { id: 'a2a-1', name: 'a2a-1', config: { a2a: `http://127.0.0.1:${PORT}` } };
  const a = new (createAdapter(agent).constructor)(agent);
  ok(await a.ping(), 'A2A ping（Agent Card）成功');
  let ev = [];
  const res = await a.send({ messages: [{ role: 'user', content: 'A2A 你好' }], onEvent: (e) => ev.push(e) });
  ok(res.text === '[a2a] A2A 你好', 'A2A send 返回回文: ' + JSON.stringify(res.text));
  server.close();
}

// ---- 4. F: generic protocolEndpoint (JSON) ----
console.log('[4] F 类 generic endpoint');
{
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const j = JSON.parse(b);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply: '[gen] ' + (j.message || j.text) }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const PORT = server.address().port;
  const agent = { id: 'gen-1', name: 'gen-1', config: { protocolEndpoint: `http://127.0.0.1:${PORT}` } };
  const a = new (createAdapter(agent).constructor)(agent);
  const res = await a.send({ messages: [{ role: 'user', content: 'generic 你好' }] });
  ok(res.text === '[gen] generic 你好', 'generic send 返回回文: ' + JSON.stringify(res.text));
  server.close();
}

// ---- 5. D: Desktop GUI (Launch+File) reuses the file bridge ----
console.log('[5] D 类 Desktop GUI（复用文件桥）');
{
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'achat-d-'));
  const agent = { id: 'dgui-1', name: 'dgui-1', config: { binaryPath: '/usr/bin/somegui', localDir: dir, maxWaitMs: 4000 } };
  const a = createAdapter(agent);
  ok(a.constructor.name === 'DesktopGuiAdapter', 'createAdapter(D) -> DesktopGuiAdapter');
  ok(a.meta().adapterType === 'D', 'DesktopGuiAdapter.meta.type = D');
  // emulate the launched local binary: read inbox task, write outbox result
  const watcher = (async () => {
    for (let i = 0; i < 100; i++) {
      let f;
      try { f = fs.readdirSync(path.join(dir, 'inbox')).find((x) => x.endsWith('.json')); }
      catch { f = undefined; } // inbox not created by adapter.ping() yet
      if (f) {
        const task = JSON.parse(fs.readFileSync(path.join(dir, 'inbox', f), 'utf8'));
        fs.writeFileSync(path.join(dir, 'outbox', f.replace('.json', '.result.json')), JSON.stringify({ conclusion: '[d-gui] ' + task.instruction }));
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  const res = await a.send({ messages: [{ role: 'user', content: 'D 你好' }] });
  await watcher;
  ok(res.text === '[d-gui] D 你好', 'D send 经文件桥回文: ' + JSON.stringify(res.text));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
