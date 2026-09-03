// Approve via independent POST and print FULL event payloads to understand the
// 'cancelled' stopReason — does the approval actually let the tool complete
// and produce a text reply, or does the stream die?
// Run: node scripts/approve-verbose.mjs <port>
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
  await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'verbose', version: '1.0.0' }, clientCapabilities: { _meta: { 'codebuddy.ai': { question: true, promptSuggestion: true, terminalOutput: true } } } } });
  const sn = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: CWD, mcpServers: [] } });
  const sessionId = (evs(sn.body).find((e) => e.result)?.result || {}).sessionId;
  console.log('session:', sessionId);

  const data = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '用工具读取 D:/Projects/zjl-achat/package.json，告诉我 name 字段。' }] } });
  console.log('sending prompt (default mode)...');
  const result = await new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path: '/api/v1/acp', method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let buf = '';
      const timer = setTimeout(() => { try { req.destroy(); } catch {} resolve({ timedOut: true, tail: buf }); }, 30000);
      res.on('data', async (c) => {
        buf += c;
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim(); if (!t.startsWith('data:')) continue;
          const j = t.slice(5).trim(); if (!j) continue;
          let ev; try { ev = JSON.parse(j); } catch { continue; }
          if (ev && ev.method === 'session/request_permission' && ev.id !== undefined) {
            clearTimeout(timer);
            const optionId = (ev.params.options || []).find((o) => o.optionId === 'allow')?.optionId;
            console.log('\n>>> PERMISSION id=' + ev.id, 'tool=' + ev.params.toolCall?._meta?.['codebuddy.ai/toolName'], 'path=' + ev.params.toolCall?.rawInput?.file_path);
            try {
              const ar = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: ev.id, result: { outcome: { outcome: 'selected', selectedOptionId: optionId } } }, 10000);
              console.log('>>> approve POST:', ar.status, ar.body.slice(0, 200));
            } catch (e) { console.log('>>> approve err:', e.message); }
          }
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve({ ended: true, tail: buf }); });
      res.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message, tail: buf }); });
    });
    req.on('error', (e) => resolve({ reqError: e.message, tail: '' }));
    req.write(data); req.end();
  });

  console.log('\n=== FULL STREAM (after approve) ===');
  const tailEvents = evs(result.tail || '');
  for (const e of tailEvents) {
    if (e.method === 'session/update') {
      const u = e.params?.update || {};
      const kind = u.sessionUpdate;
      if (kind === 'tool_call') console.log('  tool_call:', JSON.stringify(u.tool || {}).slice(0, 200));
      else if (kind === 'tool_call_update' && u.content) console.log('  tool_call_update:', typeof u.content === 'string' ? u.content.slice(0, 200) : JSON.stringify(u.content).slice(0, 200));
      else if (kind === 'agent_message_chunk') console.log('  msg:', typeof u.content?.text === 'string' ? u.content.text : JSON.stringify(u.content));
      else if (kind === 'agent_thought_chunk') console.log('  thought..');
      else if (kind === 'session_info_update') console.log('  info:', JSON.stringify(u.session).slice(0, 300));
      else console.log('  [' + kind + ']');
    } else if (e.method === 'result' || e.result) {
      console.log('  RESULT:', JSON.stringify(e.result || e).slice(0, 400));
    }
  }
}
main().catch((e) => { console.error('error', e.message); process.exit(1); });
