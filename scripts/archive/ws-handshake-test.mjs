// Test if WorkBuddy ACP endpoint upgrades to WebSocket (which would be the
// bidirectional channel for approval responses).
// Run: node scripts/ws-handshake-test.mjs <port>
import http from 'node:http';
import crypto from 'node:crypto';
const PORT = Number(process.argv[2]) || 54209;
const HOST = '127.0.0.1';
const key = crypto.randomBytes(16).toString('base64');

async function testUpgrade(path, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, upgrade: res.upgrade, headers: res.headers }));
    });
    req.on('upgrade', (res, socket) => {
      resolve({ status: res.statusCode, upgrade: true, headers: res.headers, socketAlive: true });
      try { socket.destroy(); } catch {}
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

async function main() {
  // First establish a connectionId via POST connect
  const connectReq = await new Promise((resolve, reject) => {
    const data = JSON.stringify({});
    const req = http.request({ host: HOST, port: PORT, path: '/api/v1/acp/connect', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
  console.log('connect:', connectReq.status, connectReq.body.slice(0, 200));
  let cj = {}; try { cj = JSON.parse(connectReq.body); } catch {}
  const connectionId = cj.connectionId;
  console.log('connectionId:', connectionId);

  // Test 1: plain WS upgrade on /api/v1/acp
  console.log('\n=== WS upgrade on /api/v1/acp ===');
  const r1 = await testUpgrade('/api/v1/acp', {
    Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': 13,
    'Sec-WebSocket-Key': key, 'acp-connection-id': connectionId,
  });
  console.log('result:', JSON.stringify(r1));

  // Test 2: WS upgrade on root
  console.log('\n=== WS upgrade on / ===');
  const r2 = await testUpgrade('/', { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': 13, 'Sec-WebSocket-Key': key });
  console.log('result:', JSON.stringify(r2));

  // Test 3: check response headers of a plain SSE connect to see server info
  console.log('\n=== server headers on POST /api/v1/acp ===');
  const initReq = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    const req = http.request({ host: HOST, port: PORT, path: '/api/v1/acp', method: 'POST', headers: { 'Content-Type': 'application/json', 'acp-connection-id': connectionId, 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b.slice(0, 300) }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
  console.log('status:', initReq.status);
  console.log('headers:', JSON.stringify(initReq.headers));
  console.log('body head:', initReq.body);
}
main().catch((e) => { console.error('error', e.message); process.exit(1); });
