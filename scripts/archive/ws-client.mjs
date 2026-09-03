// Minimal raw WebSocket client (RFC6455, no masking needed for server->client
// but required client->server) to test if WorkBuddy ACP is WebSocket-based.
// Run: node scripts/ws-client.mjs <port>
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2]) || 54209;
const HOST = '127.0.0.1';

function encodeFrame(payload, opcode = 0x1) {
  const payloadBytes = Buffer.from(payload, 'utf8');
  const masked = true;
  const maskKey = crypto.randomBytes(4);
  let header;
  if (payloadBytes.length < 126) {
    header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | payloadBytes.length]);
  } else if (payloadBytes.length < 65536) {
    header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | 126]);
    const ext = Buffer.alloc(2); ext.writeUInt16BE(payloadBytes.length);
    header = Buffer.concat([header, ext]);
  } else {
    header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | 127]);
    const ext = Buffer.alloc(8); ext.writeBigUInt64BE(BigInt(payloadBytes.length));
    header = Buffer.concat([header, ext]);
  }
  const maskedPayload = Buffer.from(payloadBytes);
  for (let i = 0; i < maskedPayload.length; i++) maskedPayload[i] ^= maskKey[i % 4];
  return Buffer.concat([header, maskKey, maskedPayload]);
}

function decodeFrames(buf) {
  const frames = [];
  let pos = 0;
  while (pos + 2 <= buf.length) {
    const b0 = buf[pos], b1 = buf[pos + 1];
    const fin = (b0 >> 7) & 1, opcode = b0 & 0x0f;
    let len = b1 & 0x7f;
    let off = pos + 2;
    if (len === 126) { len = buf.readUInt16BE(off); off += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(off)); off += 8; }
    const masked = (b1 >> 7) & 1;
    let maskKey = null;
    if (masked) { maskKey = buf.slice(off, off + 4); off += 4; }
    const payload = buf.slice(off, off + len);
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    frames.push({ fin, opcode, len, payload: payload.toString('utf8') });
    pos = off + len;
  }
  return { frames, remaining: buf.slice(pos) };
}

async function main() {
  const key = crypto.randomBytes(16).toString('base64');
  const ws = await new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST, port: PORT, path: '/api/v1/acp', method: 'GET',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': 13, 'Sec-WebSocket-Key': key },
    });
    req.on('upgrade', (res, socket) => resolve({ socket, res }));
    req.on('error', reject);
    req.on('response', (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => reject(new Error('no upgrade, status=' + res.statusCode + ' ' + b.slice(0,200)))); });
    req.end();
  });
  console.log('UPGRADE OK, status:', ws.res.statusCode);
  const socket = ws.socket;
  socket.setNoDelay(true);
  let buffer = Buffer.alloc(0);

  const send = (obj) => socket.write(encodeFrame(JSON.stringify(obj), 0x1));

  socket.on('data', (d) => {
    buffer = Buffer.concat([buffer, d]);
    const { frames, remaining } = decodeFrames(buffer);
    buffer = remaining;
    for (const f of frames) {
      if (f.opcode === 0x1) {
        let m; try { m = JSON.parse(f.payload); } catch { console.log('WS text:', f.payload.slice(0, 200)); continue; }
        console.log('WS recv:', JSON.stringify(m).slice(0, 300));
      } else if (f.opcode === 0x8) { console.log('WS close frame'); }
      else if (f.opcode === 0x9) { socket.write(encodeFrame(f.payload, 0xa)); console.log('WS ping -> pong'); }
    }
  });
  socket.on('close', () => { console.log('WS closed'); process.exit(0); });
  socket.on('error', (e) => { console.log('WS error:', e.message); process.exit(1); });

  // ACP over WS: connect? For WS transport the connection may be implicit.
  // Try sending initialize directly.
  send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'ws-test', version: '1.0.0' }, clientCapabilities: { _meta: { 'codebuddy.ai': { question: true } } } } });
  console.log('sent initialize over WS');
  setTimeout(() => { console.log('(10s timeout)'); process.exit(0); }, 10000);
}
main().catch((e) => { console.error('error:', e.message); process.exit(1); });
