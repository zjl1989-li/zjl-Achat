// Full dump of session/new response + attempt to load it back, to see modes/configOptions.
// Also test session/new with candidate extra params.
// Run: node scripts/new-dump.mjs <port>
const PORT = Number(process.argv[2]) || 54209;
const HOST = '127.0.0.1';
const CWD = 'D:\\Projects';

async function call(path, h, b, maxWait = 20000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), maxWait);
  try {
    const r = await fetch(`http://${HOST}:${PORT}${path}`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(b), signal: c.signal });
    return { s: r.status, txt: await r.text() };
  } finally { clearTimeout(t); }
}
function evs(t) {
  const o = [];
  for (const l of String(t).split('\n')) { const x = l.trim(); if (x.startsWith('data:')) { const j = x.slice(5).trim(); if (j) { try { o.push(JSON.parse(j)); } catch {} } } else if (x.startsWith('{')) { try { o.push(JSON.parse(x)); } catch {} } }
  return o;
}

async function main() {
  const conn = await call('/api/v1/acp/connect', {}, {});
  const cj = evs(conn.txt).find((e) => e.connectionId) || JSON.parse(conn.txt);
  const H = { 'acp-connection-id': cj.connectionId };
  if (cj.sessionToken) H['acp-session-token'] = cj.sessionToken;
  await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'achat-bridge', version: '1.0.0' }, clientCapabilities: { _meta: { 'codebuddy.ai': { question: true, promptSuggestion: true, terminalOutput: true } } } } });

  const sn = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: CWD, mcpServers: [] } });
  const snEvs = evs(sn.txt);
  const sessionId = (snEvs.find((e) => e.result)?.result || {}).sessionId || snEvs.find((e) => e.sessionId)?.sessionId;
  console.log('=== session/new === sessionId:', sessionId);
  // dump full result
  const res = snEvs.find((e) => e.result)?.result || {};
  console.log('session/new result keys:', Object.keys(res));
  console.log('full result:', JSON.stringify(res).slice(0, 2000));
  // dump any session_info_update events carrying modes/configOptions
  for (const e of snEvs) {
    const u = e.params && e.params.update;
    if (u && (u.modes || u.configOptions)) {
      console.log('\n[event has modes/configOptions]:', JSON.stringify(u).slice(0, 2500));
    }
  }

  // now load the session back
  console.log('\n=== session/load ===');
  const ld = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId, cwd: CWD, mcpServers: [] } });
  const ldEvs = evs(ld.txt);
  const ldRes = ldEvs.find((e) => e.result)?.result || {};
  console.log('load result keys:', Object.keys(ldRes));
  console.log('load result:', JSON.stringify(ldRes).slice(0, 2500));
  for (const e of ldEvs) {
    const u = e.params && e.params.update;
    if (u && (u.modes || u.configOptions)) {
      console.log('\n[load event modes/configOptions]:', JSON.stringify(u).slice(0, 2500));
    }
  }
  console.log('\nload events count:', ldEvs.length);
  if (ldEvs.length) console.log('first load event:', JSON.stringify(ldEvs[0]).slice(0, 500));
}
main().catch((e) => { console.error('error', e.message); process.exit(1); });
