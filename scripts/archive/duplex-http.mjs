// ACP over HTTP with a DUPLEX request: keep the request body stream open
// (chunked, no Content-Length, no req.end) so we can write the prompt and,
// later, the permission approval — all on the SAME connection/stream. This
// mirrors the official SDK's duplex HTTP transport.
// Run: node scripts/duplex-http.mjs <port>
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
  // establish connection (separate POST connect, normal)
  const conn = await call('/api/v1/acp/connect', {}, {});
  const cj = evs(conn.body).find((e) => e.connectionId) || JSON.parse(conn.body);
  const H = { 'acp-connection-id': cj.connectionId };
  if (cj.sessionToken) H['acp-session-token'] = cj.sessionToken;
  await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'duplex-http', version: '1.0.0' }, clientCapabilities: { _meta: { 'codebuddy.ai': { question: true, promptSuggestion: true, terminalOutput: true } } } } });
  const sn = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: CWD, mcpServers: [] } });
  const sessionId = (evs(sn.body).find((e) => e.result)?.result || {}).sessionId;
  console.log('session:', sessionId);

  // Now open ONE duplex POST: request body stays open (chunked). We'll send the
  // prompt via req.write, and later the approval via req.write again.
  const promptMsg = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '用工具读取 D:/Projects/zjl-achat/package.json，告诉我 name 字段。' }] } });
  console.log('opening duplex POST (chunked, request body stays open)...');
  const result = await new Promise((resolve) => {
    const req = http.request({
      host: HOST, port: PORT, path: '/api/v1/acp', method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Transfer-Encoding': 'chunked' },
    }, (res) => {
      let buf = '';
      const timer = setTimeout(() => { try { req.destroy(); } catch {} resolve({ timedOut: true, tail: buf }); }, 35000);
      res.on('data', async (c) => {
        buf += c;
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim(); if (!t.startsWith('data:')) continue;
          const j = t.slice(5).trim(); if (!j) continue;
          let ev; try { ev = JSON.parse(j); } catch { continue; }
          if (ev && ev.method === 'session/request_permission' && ev.id !== undefined) {
            const optionId = (ev.params.options || []).find((o) => o.optionId === 'allow')?.optionId;
            console.log('\n>>> PERMISSION id=' + ev.id, 'tool=' + ev.params.toolCall?._meta?.['codebuddy.ai/toolName']);
            // Write the approval back on the SAME request stream
            const approval = JSON.stringify({ jsonrpc: '2.0', id: ev.id, result: { outcome: { outcome: 'selected', selectedOptionId: optionId } } });
            try { req.write(approval + '\n'); console.log('>>> wrote approval on same request stream'); }
            catch (e) { console.log('>>> write failed:', e.message); }
          }
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve({ ended: true, tail: buf }); });
      res.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message, tail: buf }); });
    });
    req.on('error', (e) => resolve({ reqError: e.message, tail: '' }));
    req.write(promptMsg);
    // NOTE: intentionally do NOT req.end() — keep duplex
    console.log('sent prompt, request body stream kept open');
    setTimeout(() => { resolve({ timedOut: true, tail: '' }); }, 35000); // safety
  });

  console.log('\n=== stream tail ===');
  const tailEvents = evs(result.tail || '');
  const text = tailEvents.filter((e) => e.params?.update?.sessionUpdate === 'agent_message_chunk' && typeof e.params.update.content?.text === 'string').map((e) => e.params.update.content.text).join('');
  if (text) console.log('REPLY TEXT:', text);
  const sr = tailEvents.find((e) => e.result);
  console.log('stopReason:', sr?.result?.stopReason, '| ended:', result.ended, '| timedOut:', result.timedOut);
}
main().catch((e) => { console.error('error', e.message); process.exit(1); });
