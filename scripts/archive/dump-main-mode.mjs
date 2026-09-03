// Dump session/new configOptions for the main-window instance to see its
// default permission mode, plus check whether the created session is the same
// as the UI's active conversation.
// Run: node scripts/dump-main-mode.mjs <port>
import http from 'node:http';
const PORT = Number(process.argv[2]) || 57005;
const HOST = '127.0.0.1';
const CWD = 'D:\\Projects\\zjl-achat';

function httpPost(path, headers, bodyObj, maxWait = 15000) {
  return new Promise((resolve) => {
    const data = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
    const req = http.request({ host: HOST, port: PORT, path, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => resolve({ status: 'res-err', error: e.message }));
    });
    req.on('error', (e) => resolve({ status: 'req-err', error: e.message }));
    req.setTimeout(maxWait, () => { try { req.destroy(); } catch {} resolve({ status: 'timeout' }); });
    req.write(data); req.end();
  });
}
async function call(path, headers, bodyObj) { return await httpPost(path, headers, bodyObj); }
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
  await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'dump-main', version: '1.0.0' }, clientCapabilities: { _meta: { 'codebuddy.ai': { question: true } } } } });
  const sn = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: CWD, mcpServers: [] } });
  const snEvs = evs(sn.body);
  const result = snEvs.find((e) => e.result)?.result;
  console.log('sessionId:', result?.sessionId);
  console.log('cwd:', result?.cwd);
  console.log('--- configOptions ---');
  for (const co of (result?.configOptions || [])) {
    console.log(' * type=' + co.type, 'id=' + co.id, 'name=' + co.name, 'currentValue=' + JSON.stringify(co.currentValue));
    if (co.type === 'select' && Array.isArray(co.options)) console.log('     options:', co.options.map((o) => o.value || o.id || o).join(' | '));
  }
  console.log('--- modes ---');
  for (const m of (result?.modes || [])) console.log(' * ', JSON.stringify(m).slice(0, 150));
}
main().catch((e) => { console.error('error', e.message); process.exit(1); });
