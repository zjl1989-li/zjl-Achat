// Probe session/set_mode and session/set_config_option on WorkBuddy ACP.
// These may be how we switch permission mode (bypassPermissions) to avoid
// per-tool approval dialogs on the isolated instance.
// Run: node scripts/probe-mode.mjs <port>
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
  console.log(`== probe mode methods @ ${HOST}:${PORT} ==`);
  const conn = await call('/api/v1/acp/connect', {}, {});
  const cj = evs(conn.txt).find((e) => e.connectionId) || (() => { try { return JSON.parse(conn.txt); } catch { return {}; } })();
  const H = { 'acp-connection-id': cj.connectionId };
  if (cj.sessionToken) H['acp-session-token'] = cj.sessionToken;

  await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'achat-bridge', version: '1.0.0' }, clientCapabilities: { _meta: { 'codebuddy.ai': { question: true, promptSuggestion: true, terminalOutput: true } } } } });

  const sn = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: CWD, mcpServers: [] } });
  const snEvs = evs(sn.txt);
  const sessionId = (snEvs.find((e) => e.result)?.result || {}).sessionId || snEvs.find((e) => e.sessionId)?.sessionId;
  console.log('session:', sessionId);

  // session/set_mode variants
  const modeCandidates = [
    ['session/set_mode', { sessionId, mode: 'bypassPermissions' }],
    ['session/set_mode', { sessionId, mode: 'acceptEdits' }],
    ['session/set_mode', { sessionId, mode: 'plan' }],
    ['session/set_config_option', { sessionId, key: 'permissionMode', value: 'bypassPermissions' }],
    ['session/set_config_option', { sessionId, key: 'permissions.defaultMode', value: 'bypassPermissions' }],
    ['session/set_config_option', { sessionId, option: { key: 'permissionMode', value: 'bypassPermissions' } }],
  ];
  for (const [m, params] of modeCandidates) {
    const r = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 2, method: m, params });
    const e = evs(r.txt);
    const err = e.find((x) => x.error)?.error;
    if (err) console.log(`  ${m} ${JSON.stringify(params)} -> ERR ${JSON.stringify(err).slice(0, 180)}`);
    else console.log(`  ${m} ${JSON.stringify(params)} -> OK ${JSON.stringify(e.find((x) => x.result)?.result || {}).slice(0, 150)}`);
  }
}
main().catch((e) => { console.error('error', e.message); process.exit(1); });
