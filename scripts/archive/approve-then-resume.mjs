// Approve a permission, then (after the cancelled prompt) re-prompt the SAME
// session asking about what it read. If the tool result persisted, the second
// prompt should be able to recall it — proving the human-approve -> WB works ->
// result-recovery loop is viable end to end.
// Run: node scripts/approve-then-resume.mjs <port>
import http from 'node:http';
const PORT = Number(process.argv[2]) || 54209;
const HOST = '127.0.0.1';
const CWD = 'D:\\Projects';

function httpPost(path, headers, bodyObj, onData, maxWait = 20000) {
  return new Promise((resolve) => {
    const data = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
    const req = http.request({ host: HOST, port: PORT, path, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); onData && onData(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => resolve({ status: 'res-err', error: e.message }));
    });
    req.on('error', (e) => resolve({ status: 'req-err', error: e.message }));
    req.setTimeout(maxWait, () => { try { req.destroy(); } catch {} resolve({ status: 'timeout' }); });
    req.write(data); req.end();
  });
}
async function call(path, headers, bodyObj, maxWait) { return await httpPost(path, headers, bodyObj, null, maxWait); }
function evs(t) {
  const o = [];
  for (const l of String(t).split('\n')) { const x = l.trim(); if (x.startsWith('data:')) { const j = x.slice(5).trim(); if (j) { try { o.push(JSON.parse(j)); } catch {} } } else if (x.startsWith('{')) { try { o.push(JSON.parse(x)); } catch {} } }
  return o;
}
function extractText(body) {
  return evs(body).filter((e) => e.params?.update?.sessionUpdate === 'agent_message_chunk' && typeof e.params.update.content?.text === 'string').map((e) => e.params.update.content.text).join('');
}
function stopReasonOf(body) {
  return (evs(body).find((e) => e.result)?.result || {}).stopReason;
}

async function runPrompt(H, sessionId, reqId, text) {
  const p = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: reqId, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } }, 60000);
  const body = p.body;
  const textReply = extractText(body);
  // if there was a request_permission, auto-approve via independent POST
  const perm = evs(body).find((e) => e.method === 'session/request_permission' && e.id !== undefined);
  return { status: p.status, text: textReply, stopReason: stopReasonOf(body), hadPermission: !!perm, permId: perm?.id };
}

async function main() {
  const conn = await call('/api/v1/acp/connect', {}, {});
  const cj = evs(conn.body).find((e) => e.connectionId) || JSON.parse(conn.body);
  const H = { 'acp-connection-id': cj.connectionId };
  if (cj.sessionToken) H['acp-session-token'] = cj.sessionToken;
  await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'resume-test', version: '1.0.0' }, clientCapabilities: { _meta: { 'codebuddy.ai': { question: true, promptSuggestion: true, terminalOutput: true } } } } });
  const sn = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: CWD, mcpServers: [] } });
  const sessionId = (evs(sn.body).find((e) => e.result)?.result || {}).sessionId;
  console.log('session:', sessionId);

  // Prompt 1: read file (will hit approval)
  console.log('\n--- prompt 1: read file ---');
  const r1 = await runPrompt(H, sessionId, 2, '用工具读取 D:/Projects/zjl-achat/package.json，记住 name 字段，然后回答 name 是什么。');
  console.log('p1:', JSON.stringify({ text: r1.text, stop: r1.stopReason, perm: r1.hadPermission, permId: r1.permId }));
  if (r1.hadPermission) {
    // approve via independent POST
    const optionId = 'allow';
    const ar = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: r1.permId, result: { outcome: { outcome: 'selected', selectedOptionId: optionId } } }, 10000);
    console.log('approved via POST:', ar.status);
  }
  await new Promise((r) => setTimeout(r, 2000));

  // Prompt 2: ask what it read (same session) — should recall if tool result persisted
  console.log('\n--- prompt 2: recall (same session) ---');
  const r2 = await runPrompt(H, sessionId, 3, '你刚才读取的 package.json 里 name 字段是什么？直接回答。');
  console.log('p2:', JSON.stringify({ text: r2.text, stop: r2.stopReason, perm: r2.hadPermission }));
}
main().catch((e) => { console.error('error', e.message); process.exit(1); });
