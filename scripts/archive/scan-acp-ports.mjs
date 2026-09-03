// Scan WorkBuddy listening ports for an ACP endpoint (/api/v1/acp/connect).
// Run: node scripts/scan-acp-ports.mjs
import http from 'node:http';
const CANDIDATES = [49789, 49796, 54209, 61006, 61007, 57005, 18488, 49790, 49795, 49800, 61008];
const PIDS_TO_PORT = { 9660: 54209, 16244: [49789, 61006, 61007], 16472: 57005, 18804: 18488 };

function tryConnect(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/v1/acp/connect', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2 }, timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ port, status: res.statusCode, body: b.slice(0, 150) }));
    });
    req.on('error', () => resolve({ port, status: 'ERR' }));
    req.setTimeout(3000, () => { try { req.destroy(); } catch {} resolve({ port, status: 'TIMEOUT' }); });
    req.write('{}'); req.end();
  });
}

const results = await Promise.all(CANDIDATES.map(tryConnect));
for (const r of results) console.log(r.port + ':', r.status, r.status === 200 ? r.body : '');
