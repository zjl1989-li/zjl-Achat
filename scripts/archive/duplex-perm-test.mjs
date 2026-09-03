// Test whether WorkBuddy's ACP over HTTP supports writing the permission
// response back on the SAME response stream (duplex). Uses node http so the
// response body is a writable stream too (chunked). We send session/prompt in
// DEFAULT permission mode (which triggers approval for reading non-trusted dirs)
// and, upon receiving the session/request_permission request, write the
// approval JSON-RPC response back on the same socket.
// Run: node scripts/duplex-perm-test.mjs <port>
import http from 'node:http';
const PORT = Number(process.argv[2]) || 54209;
const HOST = '127.0.0.1';
const CWD = 'D:\\Projects';

function post(path, headers, bodyObj, onData, maxWait = 20000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const req = http.request({ host: HOST, port: PORT, path, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      res.on('data', (c) => onData && onData(c));
      res.on('end', () => resolve({ status: res.statusCode }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(maxWait, () => { try { req.destroy(); } catch {} reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

async function call(path, headers, bodyObj, maxWait) {
  const chunks = [];
  const r = await post(path, headers, bodyObj, (c) => chunks.push(c), maxWait);
  return { status: r.status, body: Buffer.concat(chunks).toString('utf8') };
}
function evs(t) {
  const o = [];
  for (const l of String(t).split('\n')) { const x = l.trim(); if (x.startsWith('data:')) { const j = x.slice(5).trim(); if (j) { try { o.push(JSON.parse(j)); } catch {} } } else if (x.startsWith('{')) { try { o.push(JSON.parse(x)); } catch {} } }
  return o;
}

async function main() {
  const conn = await call('/api/v1/acp/connect', {}, {});
  const cj = evs(conn.body).find((e) => e.connectionId) || JSON.parse(conn.body);
  const H = { 'acp-connection-id': cj.connectionId };
  if (cj.sessionToken) H['acp-session-token'] = cj.sessionToken;
  await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'duplex-test', version: '1.0.0' }, clientCapabilities: { _meta: { 'codebuddy.ai': { question: true, promptSuggestion: true, terminalOutput: true } } } } });
  const sn = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: CWD, mcpServers: [] } });
  const sessionId = (evs(sn.body).find((e) => e.result)?.result || {}).sessionId;
  console.log('session:', sessionId);

  console.log('sending prompt (default mode; will likely hit approval)...');
  const data = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '用工具读取 D:/Projects/zjl-achat/package.json，告诉我 name 字段。' }] } });
  const req = http.request({ host: HOST, port: PORT, path: '/api/v1/acp', method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
    let buf = '';
    let permResponded = false;
    const timer = setTimeout(() => { try { req.destroy(); } catch {} console.log('GLOBAL TIMEOUT'); process.exit(1); }, 30000);
    res.on('data', (c) => {
      buf += c;
      // try to find complete request_permission JSON-RPC request
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const j = t.slice(5).trim();
        if (!j) continue;
        let ev; try { ev = JSON.parse(j); } catch { continue; }
        if (ev && ev.method === 'session/request_permission' && ev.id !== undefined && !permResponded) {
          permResponded = true;
          console.log('\n=== REQUEST_PERMISSION received, id=' + ev.id + ' ===');
          console.log('  sessionId:', ev.params.sessionId);
          console.log('  toolCall:', JSON.stringify(ev.params.toolCall || {}).slice(0, 400));
          console.log('  options:', JSON.stringify(ev.params.options || []).slice(0, 500));
          // Respond by writing back on the same request body stream
          const optionId = (ev.params.options || [])[0]?.optionId;
          const outcome = optionId
            ? { outcome: 'selected', selectedOptionId: optionId }
            : { outcome: 'cancelled' };
          const resp = JSON.stringify({ jsonrpc: '2.0', id: ev.id, result: { outcome } });
          console.log('  WRITING RESPONSE:', resp);
          try { req.write(resp + '\n'); } catch (e) { console.log('  write error:', e.message); }
        }
      }
    });
    res.on('end', () => { clearTimeout(timer); console.log('\n=== STREAM ENDED ==='); console.log('final text tail:', buf.split('data:').slice(-6).join('\ndata:')); process.exit(0); });
    res.on('error', (e) => { clearTimeout(timer); console.log('res error', e.message); process.exit(1); });
  });
  req.on('error', (e) => { console.log('req error', e.message); process.exit(1); });
  req.write(data);
  req.end();
}
main().catch((e) => { console.error('error', e.message); process.exit(1); });
