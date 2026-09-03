// Capability probe: can this WorkBuddy ACP instance access REAL filesystem paths
// (D:\Projects) and actually use tools? Sends a task that requires reading a real
// file. Collects the full assistant stream (text + tool use evidence).
// Run: node scripts/capability-probe.mjs <port> "<task>"
const PORT = Number(process.argv[2]);
const TASK = process.argv[3] || '用工具读取 D:/Projects/zjl-achat/package.json 的内容，然后告诉我 name 字段是什么。不要含糊，直接给出字段值。';
const HOST = '127.0.0.1';

async function acpCall(path, headers, bodyObj, opts = {}) {
  const data = JSON.stringify(bodyObj);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.maxWaitMs || 180000);
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
  console.log(`== capability probe @ ${HOST}:${PORT} ==`);
  const conn = await acpCall('/api/v1/acp/connect', {}, {});
  const cj = (() => { try { return JSON.parse(conn.text); } catch { return parseEvents(conn.text).find((e) => e.connectionId) || {}; } })();
  const H = { 'acp-connection-id': cj.connectionId };
  if (cj.sessionToken) H['acp-session-token'] = cj.sessionToken;
  if (!cj.connectionId) { console.error('connect failed', conn.status, conn.text.slice(0,200)); process.exit(1); }

  await acpCall('/api/v1/acp', H, { jsonrpc:'2.0', id:0, method:'initialize', params:{ protocolVersion:1, clientInfo:{name:'achat-bridge',version:'1.0.0'}, clientCapabilities:{_meta:{'codebuddy.ai':{question:true,promptSuggestion:true,terminalOutput:true}}} } });

  // Try to set cwd to a REAL path and see if it sticks / is honored
  const sn = await acpCall('/api/v1/acp', H, { jsonrpc:'2.0', id:1, method:'session/new', params:{ cwd: 'D:\\Projects\\zjl-achat', mcpServers: [] } });
  const snEvents = parseEvents(sn.text);
  const sessionId = (getResult(snEvents) || {}).sessionId || snEvents.find((e) => e.sessionId)?.sessionId;
  console.log('created session:', sessionId);

  const sp = await acpCall('/api/v1/acp', H, { jsonrpc:'2.0', id:2, method:'session/prompt', params:{ sessionId, prompt:[{ type:'text', text:TASK }] } }, { maxWaitMs: 180000 });
  const spEvents = parseEvents(sp.text);
  // Collect all text + tool uses
  let text = '';
  const toolUses = [];
  for (const e of spEvents) {
    const u = e.params && e.params.update;
    if (u && u.sessionUpdate === 'agent_message_chunk' && u.content) {
      if (typeof u.content.text === 'string') text += u.content.text;
      if (u.content.tool_use) toolUses.push(u.content.tool_use);
    }
  }
  const stopReason = (getResult(spEvents) || {}).stopReason;
  console.log('--- tool uses detected:', toolUses.length);
  for (const t of toolUses) console.log('   tool:', JSON.stringify(t).slice(0, 200));
  console.log('--- assistant text ---');
  console.log(text);
  console.log('--- stopReason:', stopReason);
  console.log('\nRESULT:' + JSON.stringify({ sessionId, reply: text, toolUseCount: toolUses.length, stopReason }));
}

main().catch((e) => { console.error('error', e.message); process.exit(1); });
