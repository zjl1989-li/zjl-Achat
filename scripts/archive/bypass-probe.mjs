// Set session mode to bypassPermissions via session/set_config_option, then
// send a task requiring reading a REAL D:\Projects file. Verify no approval stall.
// Run: node scripts/bypass-probe.mjs <port> "<task>"
const PORT = Number(process.argv[2]) || 54209;
const TASK = process.argv[3] || '用工具读取 D:/Projects/zjl-achat/package.json，告诉我 name 字段的值。';
const HOST = '127.0.0.1';
const CWD = 'D:\\Projects';

async function call(path, h, b, maxWait = 120000) {
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
  console.log(`== bypass probe @ ${HOST}:${PORT} ==`);
  const conn = await call('/api/v1/acp/connect', {}, {}, 10000);
  const cj = evs(conn.txt).find((e) => e.connectionId) || JSON.parse(conn.txt);
  const H = { 'acp-connection-id': cj.connectionId };
  if (cj.sessionToken) H['acp-session-token'] = cj.sessionToken;
  await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'achat-bridge', version: '1.0.0' }, clientCapabilities: { _meta: { 'codebuddy.ai': { question: true, promptSuggestion: true, terminalOutput: true } } } } });

  const sn = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: CWD, mcpServers: [] } });
  const snEvs = evs(sn.txt);
  const sessionId = (snEvs.find((e) => e.result)?.result || {}).sessionId;
  console.log('session:', sessionId);

  // Set mode to bypassPermissions (configId 'mode', select value)
  const setm = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 2, method: 'session/set_config_option', params: { sessionId, configId: 'mode', value: 'bypassPermissions' } });
  const setmEvs = evs(setm.txt);
  const setmErr = setmEvs.find((e) => e.error)?.error;
  if (setmErr) { console.log('set_config_option mode=bypassPermissions -> ERR', JSON.stringify(setmErr).slice(0, 300)); }
  else {
    const opts = (setmEvs.find((e) => e.result)?.result || {}).configOptions || setmEvs.find((e) => e.params?.update?.configOptions)?.params?.update?.configOptions;
    const modeOpt = (opts || []).find((o) => o.id === 'mode');
    console.log('set_config_option mode -> OK, currentValue:', modeOpt ? modeOpt.currentValue : (opts ? '?(see below)' : 'n/a'));
  }

  // Now prompt
  console.log('\n--- prompting ---');
  const sp = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: TASK }] } }, 120000);
  const spEvs = evs(sp.txt);
  let text = '';
  const toolUses = [];
  for (const e of spEvs) {
    const u = e.params && e.params.update;
    if (u && u.sessionUpdate === 'agent_message_chunk' && u.content) {
      if (typeof u.content.text === 'string') text += u.content.text;
      if (u.content.tool_use) toolUses.push(u.content.tool_use);
    }
  }
  const stopReason = (spEvs.find((e) => e.result)?.result || {}).stopReason;
  // also detect request_permission events
  const permEvents = spEvs.filter((e) => e.method === 'session/request_permission' || (e.params && e.method));
  console.log('tool uses:', toolUses.length, '| stopReason:', stopReason, '| events:', spEvs.length);
  console.log('--- assistant reply ---');
  console.log(text);
  console.log('\nRESULT:' + JSON.stringify({ sessionId, reply: text, toolUseCount: toolUses.length, stopReason }));
}
main().catch((e) => { console.error('error', e.message); process.exit(1); });
