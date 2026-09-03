// Call session/load properly to discover modes & config options (incl. permission mode).
// Run: node scripts/load-discover.mjs <port>
const PORT = Number(process.argv[2]) || 54209;
const HOST = '127.0.0.1';
const CWD = 'D:\\Projects';

async function call(path, h, b, maxWait = 20000) {
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
  const conn = await call('/api/v1/acp/connect', {}, {});
  const cj = evs(conn.txt).find((e) => e.connectionId) || JSON.parse(conn.txt);
  const H = { 'acp-connection-id': cj.connectionId };
  if (cj.sessionToken) H['acp-session-token'] = cj.sessionToken;
  await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'achat-bridge', version: '1.0.0' }, clientCapabilities: { _meta: { 'codebuddy.ai': { question: true, promptSuggestion: true, terminalOutput: true } } } } });

  // session/load with required mcpServers array
  const ld = await call('/api/v1/acp', H, { jsonrpc: '2.0', id: 1, method: 'session/load', params: { cwd: CWD, mcpServers: [] } });
  const evsLd = evs(ld.txt);
  // session/load streams a series of events; collect the "session/update"-style init or a result
  console.log('--- session/load raw events ---');
  let resultEvent = null;
  for (const e of evsLd) {
    if (e.result) resultEvent = e;
  }
  // The modes/configOptions come in a specific update event. Dump all session_info_update with modes
  for (const e of evsLd) {
    const u = e.params && e.params.update;
    if (u && (u.modes || u.configOptions || u.sessionUpdate === 'session_info_update' && (u._meta))) {
      const s = JSON.stringify(u);
      if (s.includes('mode') || s.includes('config')) { console.log('  [event]', s.slice(0, 1500)); }
    }
  }
  if (resultEvent) console.log('--- result ---', JSON.stringify(resultEvent.result).slice(0, 800));
  else console.log('--- no result event; first 3 events ---', evsLd.slice(0,3).map(e=>JSON.stringify(e).slice(0,400)).join('\n'));
}
main().catch((e) => { console.error('error', e.message); process.exit(1); });
