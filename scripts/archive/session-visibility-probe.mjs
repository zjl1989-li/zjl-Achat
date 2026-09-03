// Probe: does the WorkBuddy ACP Remote Control service expose session listing,
// and does a session created via ACP map to a UI-visible conversation?
// Run: node scripts/session-visibility-probe.mjs [port]
const PORT = Number(process.argv[2]) || 49796;
const HOST = '127.0.0.1';
const CWD = 'D:\\Projects';

async function acpCall(path, headers, bodyObj, opts = {}) {
  const data = JSON.stringify(bodyObj);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.maxWaitMs || 60000);
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
const getResult = (events) => {
  const e = events.find((x) => x.result);
  return e ? e.result : null;
};

async function main() {
  console.log(`== session visibility probe @ ${HOST}:${PORT} ==`);
  const conn = await acpCall('/api/v1/acp/connect', {}, {});
  const cj = (() => { try { return JSON.parse(conn.text); } catch { return parseEvents(conn.text).find((e) => e.connectionId) || {}; } })();
  const H = { 'acp-connection-id': cj.connectionId };
  if (cj.sessionToken) H['acp-session-token'] = cj.sessionToken;
  if (!cj.connectionId) { console.error('connect failed', conn.status, conn.text.slice(0,200)); process.exit(1); }
  console.log('connected:', cj.connectionId);

  // initialize
  await acpCall('/api/v1/acp', H, { jsonrpc:'2.0', id:0, method:'initialize', params:{ protocolVersion:1, clientInfo:{name:'achat-bridge',version:'1.0.0'}, clientCapabilities:{_meta:{'codebuddy.ai':{question:true,promptSuggestion:true,terminalOutput:true}}} } });

  // 1) create a fresh session
  const sn = await acpCall('/api/v1/acp', H, { jsonrpc:'2.0', id:1, method:'session/new', params:{ cwd: CWD, mcpServers: [] } });
  const snEvents = parseEvents(sn.text);
  const sessionId = (getResult(snEvents) || {}).sessionId || snEvents.find((e) => e.sessionId)?.sessionId;
  console.log('created session:', sessionId);

  // 2) try common list/find methods to see if ACP exposes session enumeration
  const listMethods = [
    ['session/list', {}],
    ['session/find', { sessionId }],
    ['session/get', { sessionId }],
    ['session/read', { sessionId }],
    ['session/list_recents', {}],
  ];
  for (const [method, params] of listMethods) {
    const r = await acpCall('/api/v1/acp', H, { jsonrpc:'2.0', id:2, method, params });
    const evs = parseEvents(r.text);
    const result = getResult(evs);
    const err = evs.find((e) => e.error)?.error;
    console.log(`  ${method} -> HTTP ${r.status}`, err ? `ERROR ${JSON.stringify(err)}` : `result=${JSON.stringify(result)}`);
  }

  // 3) send a trivial prompt on the new session and see if UI reacts
  console.log('  sending test prompt on new session...');
  const sp = await acpCall('/api/v1/acp', H, {
    jsonrpc:'2.0', id:3, method:'session/prompt',
    params:{ sessionId, prompt:[{ type:'text', text:'只回复两个字：就绪' }] },
  }, { maxWaitMs: 120000 });
  const spEvents = parseEvents(sp.text);
  let reply = '';
  for (const e of spEvents) {
    const u = e.params && e.params.update;
    if (u && u.sessionUpdate === 'agent_message_chunk' && u.content && typeof u.content.text === 'string') reply += u.content.text;
  }
  console.log('  prompt HTTP', sp.status, '| reply:', JSON.stringify(reply));
  const stopReason = (getResult(spEvents) || {}).stopReason;
  console.log('  stopReason:', stopReason);

  console.log('\nRESULT:' + JSON.stringify({ connectionId: cj.connectionId, sessionId, reply, stopReason }));
}

main().catch((e) => { console.error('error', e.message); process.exit(1); });
