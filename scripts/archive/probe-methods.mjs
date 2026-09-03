// Probe candidate ACP methods for tool approval / permission handling against
// the REAL WorkBuddy ACP service. Prints which methods exist (not -32601).
// Run: node scripts/probe-methods.mjs <port>
const PORT = Number(process.argv[2]) || 49796;
const HOST = '127.0.0.1';
const CWD = 'D:\\Projects';

async function acpCall(path, headers, bodyObj, opts = {}) {
  const data = JSON.stringify(bodyObj);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.maxWaitMs || 15000);
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
const firstError = (events) => {
  const e = events.find((x) => x.error);
  return e ? e.error : null;
};

async function main() {
  console.log(`== probe ACP methods @ ${HOST}:${PORT} ==`);
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

  const candidates = [
    ['session/approve', { sessionId, toolCallId: 'probe' }],
    ['session/approveTool', { sessionId, toolCallId: 'probe' }],
    ['session/permission', { sessionId, toolCallId: 'probe', approved: true }],
    ['session/handlePermission', { sessionId, toolCallId: 'probe', approved: true }],
    ['session/approveRequest', { sessionId, toolCallId: 'probe', approved: true }],
    ['session/toolResult', { sessionId, toolCallId: 'probe', result: {} }],
    ['session/cancel', { sessionId }],
    ['session/load', { sessionId }],
    ['session/delete', { sessionId }],
    ['session/listFiles', { sessionId }],
    ['session/approve_tool_call', { sessionId, toolCallId: 'probe', approved: true }],
    ['session/respond', { sessionId, toolCallId: 'probe', approved: true }],
    ['session/answer', { sessionId, toolCallId: 'probe', answer: 'yes' }],
    ['tool/approve', { sessionId, toolCallId: 'probe', approved: true }],
    ['tool/call', { sessionId, tool: { name: 'Read', arguments: { filePath: 'C:\\Users\\wsx\\.workbuddy\\MEMORY.md' } } }],
  ];
  for (const [method, params] of candidates) {
    const r = await acpCall('/api/v1/acp', H, { jsonrpc:'2.0', id:2, method, params });
    const evs = parseEvents(r.text);
    const err = firstError(evs);
    const exists = err && err.code === -32601 ? 'NO (not found)' : (err ? `ERR ${JSON.stringify(err).slice(0,120)}` : 'EXISTS ✓');
    console.log(`  ${method} -> ${exists}`);
  }
}

function getResult(events) { return (events.find((x) => x.result) || {}).result || null; }
main().catch((e) => { console.error('error', e.message); process.exit(1); });
