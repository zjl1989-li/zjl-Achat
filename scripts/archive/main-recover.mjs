// Verify the recovery path: after an approval-driven write succeeds on the
// main-window instance (file lands), a SECOND prompt on the SAME session can
// recall the file content — proving achat can collect the result to relay to
// the group even though the original prompt stream dies after approval.
// Run: node scripts/main-recover.mjs <port>
import http from 'node:http';
import fs from 'node:fs';
const PORT = Number(process.argv[2]) || 57005;
const HOST = '127.0.0.1';
const CWD = 'D:\\Projects\\zjl-achat';
const target = 'D:/Projects/zjl-achat/_probe/_default-probe.txt';

function httpPost(path, headers, bodyObj, onData, maxWait = 15000) {
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

async function promptOnce(H, sessionId, reqId, text, approvePendings) {
  const p = await httpPost('/api/v1/acp', H, { jsonrpc: '2.0', id: reqId, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } }, null, 30000);
  return { status: p.status, body: p.body, text: extractText(p.body), stop: stopReasonOf(p.body), pendings: evs(p.body).filter((e) => e.method === 'session/request_permission') };
}

async function main() {
  const conn = await call('/api/v1/acp/connect', {}, {});
  const cj = evs(conn.body).find((e) => e.connectionId) || JSON.parse(conn.body);
  const H = { 'acp-connection-id': cj.connectionId };
  if (cj.sessionToken) H['acp-session-token'] = cj.sessionToken;
  await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'recover', version: '1.0.0' }, clientCapabilities: { _meta: { 'codebuddy.ai': { question: true } } } } });
  const sn = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: CWD, mcpServers: [] } });
  const sessionId = (evs(sn.body).find((e) => e.result)?.result || {}).sessionId;
  console.log('session:', sessionId);
  await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 9, method: 'session/set_config_option', params: { sessionId, configId: 'mode', value: 'default' } }, 8000);
  console.log('mode set to default');

  // Prompt 1: write (will pend on permission)
  const r1 = await promptOnce(H, sessionId, 2, '请用工具把文本 "recover-probe-123" 写入文件 ' + target + '。', true);
  console.log('p1 stop:', r1.stop, '| pendings:', r1.pendings.length, '| text:', r1.text || '(none)');
  if (r1.pendings.length) {
    for (const p of r1.pendings) {
      const optionId = (p.params.options || []).find((o) => o.optionId === 'allow')?.optionId || (p.params.options || [])[0]?.optionId;
      const ar = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: p.id, result: { outcome: { outcome: 'selected', selectedOptionId: optionId } } }, 8000);
      console.log('  approved pending id=' + p.id, '->', ar.status);
    }
  }
  console.log('file after p1 exists:', fs.existsSync(target));

  // Prompt 2: recall on SAME session (no permission expected)
  const r2 = await promptOnce(H, sessionId, 3, '你刚才写入 ' + target + ' 的内容是什么？直接回答文件内容。', false);
  console.log('p2 stop:', r2.stop, '| text:', r2.text || '(none)');
}
main().catch((e) => { console.error('error', e.message); process.exit(1); });
