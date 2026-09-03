// Determine how a client submits the permission decision to WorkBuddy's ACP
// server over plain HTTP. Tests an INDEPENDENT POST carrying the JSON-RPC
// response for session/request_permission.
// Run: node scripts/approve-via-post.mjs <port>
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

async function main() {
  const conn = await call('/api/v1/acp/connect', {}, {});
  const cj = evs(conn.body).find((e) => e.connectionId) || JSON.parse(conn.body);
  const H = { 'acp-connection-id': cj.connectionId };
  if (cj.sessionToken) H['acp-session-token'] = cj.sessionToken;
  await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'approve-test', version: '1.0.0' }, clientCapabilities: { _meta: { 'codebuddy.ai': { question: true, promptSuggestion: true, terminalOutput: true } } } } });
  const sn = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: CWD, mcpServers: [] } });
  const sessionId = (evs(sn.body).find((e) => e.result)?.result || {}).sessionId;
  console.log('session:', sessionId, '| connection:', cj.connectionId);

  const data = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '用工具读取 D:/Projects/zjl-achat/package.json，告诉我 name 字段。' }] } });
  console.log('sending prompt (default mode)...');
  const promptDone = { ended: false };
  const finalTail = await new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path: '/api/v1/acp', method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let buf = '';
      const timer = setTimeout(() => { try { req.destroy(); } catch {} resolve({ timedOut: true, tail: buf.slice(-1500) }); }, 30000);
      res.on('data', async (c) => {
        buf += c;
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim(); if (!t.startsWith('data:')) continue;
          const j = t.slice(5).trim(); if (!j) continue;
          let ev; try { ev = JSON.parse(j); } catch { continue; }
          if (ev && ev.method === 'session/request_permission' && ev.id !== undefined && !promptDone.ended) {
            promptDone.ended = true;
            clearTimeout(timer);
            const optionId = (ev.params.options || []).find((o) => o.optionId === 'allow')?.optionId || (ev.params.options || [])[0]?.optionId;
            console.log('\n>>> request_permission id=' + ev.id + ' tool=' + ev.params.toolCall?._meta?.['codebuddy.ai/toolName'] + ' path=' + ev.params.toolCall?.rawInput?.file_path);
            console.log('>>> options:', JSON.stringify(ev.params.options));
            // Respond via INDEPENDENT POST (separate request, same connection id)
            const respBody = { jsonrpc: '2.0', id: ev.id, result: { outcome: { outcome: 'selected', selectedOptionId: optionId } } };
            try {
              const ar = await call('/api/v1/acp', H, respBody, 10000);
              console.log('>>> INDEPENDENT POST:', ar.status, ar.body.slice(0, 300));
            } catch (e) { console.log('>>> independent POST threw:', e.message); }
          }
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve({ ended: true, tail: buf.slice(-4000) }); });
      res.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message, tail: buf.slice(-1500) }); });
    });
    req.on('error', (e) => resolve({ reqError: e.message }));
    req.write(data); req.end();
  });

  console.log('\n=== prompt stream ===');
  const tailEv = evs(finalTail.tail || '');
  const text = tailEv.filter((e) => e.params?.update?.sessionUpdate === 'agent_message_chunk' && typeof e.params.update.content?.text === 'string').map((e) => e.params.update.content.text).join('');
  if (text) console.log('\nREPLY TEXT:', text);
  const sr = tailEv.find((e) => e.result);
  console.log('\nstopReason:', sr?.result?.stopReason, '| streamEnded:', finalTail.ended, '| timedOut:', finalTail.timedOut);
}
main().catch((e) => { console.error('error', e.message); process.exit(1); });
