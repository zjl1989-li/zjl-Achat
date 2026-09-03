// Send a uniquely-tagged prompt to a SPECIFIED WorkBuddy ACP instance and report
// the sessionId. Used to verify whether an isolated CLI host instance pollutes
// the main-window UI conversation.
// Run: node scripts/isolated-probe.mjs <port> "<text>"
const PORT = Number(process.argv[2]);
const TEXT = process.argv[3] || '只回复两个字：隔离';
const HOST = '127.0.0.1';
const CWD = 'D:\\Projects';

async function acpCall(path, headers, bodyObj, opts = {}) {
  const data = JSON.stringify(bodyObj);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.maxWaitMs || 120000);
  try {
    const res = await fetch(`http://${HOST}:${PORT}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: data, signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } finally { clearTimeout(timer); }
}
function parseEvents(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (t.startsWith('data:')) { const j = t.slice(5).trim(); if (j) { try { out.push(JSON.parse(j)); } catch {} } }
    else if (t.startsWith('{')) { try { out.push(JSON.parse(t)); } catch {} }
  }
  return out;
}
const getResult = (events) => (events.find((x) => x.result) || {}).result || null;

async function main() {
  console.log(`== isolated probe @ ${HOST}:${PORT} ==`);
  const conn = await acpCall('/api/v1/acp/connect', {}, {});
  const cj = (() => { try { return JSON.parse(conn.text); } catch { return parseEvents(conn.text).find((e) => e.connectionId) || {}; } })();
  const H = { 'acp-connection-id': cj.connectionId };
  if (cj.sessionToken) H['acp-session-token'] = cj.sessionToken;
  if (!cj.connectionId) { console.error('connect failed', conn.status, conn.text.slice(0,200)); process.exit(1); }
  console.log('connected:', cj.connectionId);

  await acpCall('/api/v1/acp', H, { jsonrpc:'2.0', id:0, method:'initialize', params:{ protocolVersion:1, clientInfo:{name:'achat-bridge',version:'1.0.0'}, clientCapabilities:{_meta:{'codebuddy.ai':{question:true,promptSuggestion:true,terminalOutput:true}}} } });

  const sn = await acpCall('/api/v1/acp', H, { jsonrpc:'2.0', id:1, method:'session/new', params:{ cwd: CWD, mcpServers: [] } });
  const snEvents = parseEvents(sn.text);
  const sessionId = (getResult(snEvents) || {}).sessionId || snEvents.find((e) => e.sessionId)?.sessionId;
  console.log('created session:', sessionId);

  const sp = await acpCall('/api/v1/acp', H, { jsonrpc:'2.0', id:2, method:'session/prompt', params:{ sessionId, prompt:[{ type:'text', text:TEXT }] } }, { maxWaitMs: 120000 });
  const spEvents = parseEvents(sp.text);
  let reply = '';
  for (const e of spEvents) {
    const u = e.params && e.params.update;
    if (u && u.sessionUpdate === 'agent_message_chunk' && u.content && typeof u.content.text === 'string') reply += u.content.text;
  }
  console.log('reply:', JSON.stringify(reply));
  console.log('\nRESULT:' + JSON.stringify({ connectionId: cj.connectionId, sessionId, reply }));
}

main().catch((e) => { console.error('error', e.message); process.exit(1); });
