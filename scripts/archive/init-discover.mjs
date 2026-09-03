// Full init + method discovery. After proper initialize, probe method existence
// and inspect initialize capabilities for approval-related hooks.
// Run: node scripts/init-discover.mjs <port>
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
  console.log(`== full init + discover @ ${HOST}:${PORT} ==`);
  const conn = await call('/api/v1/acp/connect', {}, {});
  const cj = evs(conn.txt).find((e) => e.connectionId) || (() => { try { return JSON.parse(conn.txt); } catch { return {}; } })();
  const H = { 'acp-connection-id': cj.connectionId };
  if (cj.sessionToken) H['acp-session-token'] = cj.sessionToken;
  console.log('connected:', cj.connectionId);

  const init = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'achat-bridge', version: '1.0.0' }, clientCapabilities: { _meta: { 'codebuddy.ai': { question: true, promptSuggestion: true, terminalOutput: true } } } } });
  const initEvs = evs(init.txt);
  const initResult = initEvs.find((e) => e.result)?.result;
  console.log('initialize result:', JSON.stringify(initResult).slice(0, 800));

  const sn = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: CWD, mcpServers: [] } });
  const snEvs = evs(sn.txt);
  const sessionId = (snEvs.find((e) => e.result)?.result || {}).sessionId || snEvs.find((e) => e.sessionId)?.sessionId;
  console.log('session:', sessionId);

  // Now that initialized, probe existence (look for -32601 Method not found)
  const candidates = [
    'session/load','session/delete','session/cancel','session/approve','session/approveTool',
    'session/permission','session/handlePermission','session/approveRequest','session/toolResult',
    'session/respond','session/answer','session/list','session/find','session/status',
    'session/prompt','session/update','session/notify','session/new','tool/approve','tool/permission',
    'config/set','session/setCwd','session/rename','session/getFileHistory','session/listMessages',
  ];
  for (const m of candidates) {
    const params = { sessionId };
    if (m === 'session/load') params.cwd = CWD;
    const r = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 2, method: m, params });
    const e = evs(r.txt);
    const err = e.find((x) => x.error)?.error;
    const notFound = err && (err.code === -32601);
    const invalidParams = err && (err.code === -32602);
    if (notFound) console.log(`  ${m} -> not-found`);
    else if (invalidParams) console.log(`  ${m} -> EXISTS (invalid params) ${JSON.stringify(err.data||{}).slice(0,150)}`);
    else if (err) console.log(`  ${m} -> ERR ${JSON.stringify(err).slice(0,160)}`);
    else console.log(`  ${m} -> OK ${JSON.stringify(e.find(x=>x.result)?.result||{}).slice(0,120)}`);
  }
}
main().catch((e) => { console.error('error', e.message); process.exit(1); });
