// Create a new session in the REAL WorkBuddy via its Remote Control ACP service.
// Port is explicit (bypasses netstat discovery, which the sandbox blocks).
// Run: node scripts/create-session-probe.mjs [port]
const PORT = Number(process.argv[2]) || 49796;
const HOST = '127.0.0.1';

async function acpCall(path, headers, bodyObj, opts = {}) {
  const data = JSON.stringify(bodyObj);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.maxWaitMs || 60000);
  try {
    const res = await fetch(`http://${HOST}:${PORT}${path}`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: data,
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function parseEvents(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (t.startsWith('data:')) {
      const j = t.slice(5).trim();
      if (j) { try { out.push(JSON.parse(j)); } catch { /* partial */ } }
    } else if (t.startsWith('{')) {
      try { out.push(JSON.parse(t)); } catch { /* partial */ }
    }
  }
  return out;
}

async function main() {
  console.log(`== create session in REAL WorkBuddy @ ${HOST}:${PORT} ==`);

  // 1) connect -> connectionId
  const conn = await acpCall('/api/v1/acp/connect', {}, {});
  const cj = (() => { try { return JSON.parse(conn.text); } catch { return parseEvents(conn.text).find((e) => e.connectionId) || {}; } })();
  const connectionId = cj.connectionId;
  const sessionToken = cj.sessionToken;
  if (!connectionId) { console.error('connect failed:', conn.status, conn.text.slice(0, 300)); process.exit(1); }
  console.log('connected. connectionId =', connectionId);
  const H = { 'acp-connection-id': connectionId };
  if (sessionToken) H['acp-session-token'] = sessionToken;

  // 2) initialize
  const init = await acpCall('/api/v1/acp', H, {
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: {
      protocolVersion: 1,
      clientInfo: { name: 'achat-bridge', version: '1.0.0' },
      clientCapabilities: { _meta: { 'codebuddy.ai': { question: true, promptSuggestion: true, terminalOutput: true } } },
    },
  });
  console.log('initialize -> HTTP', init.status);
  const initEvents = parseEvents(init.text);
  const serverInfo = initEvents.find((e) => e.result && e.result.serverInfo);
  console.log('serverInfo =', JSON.stringify(serverInfo?.result?.serverInfo || null));
  console.log('protocolVersion =', initEvents.find((e) => e.result && e.result.protocolVersion)?.result?.protocolVersion);

  // 3) session/new -> sessionId
  const sn = await acpCall('/api/v1/acp', H, {
    jsonrpc: '2.0', id: 1, method: 'session/new',
    params: { cwd: 'D:\\Projects', mcpServers: [] },
  });
  console.log('session/new -> HTTP', sn.status);
  const snEvents = parseEvents(sn.text);
  const sessionId =
    (snEvents.find((e) => e.result && e.result.sessionId) || {}).result?.sessionId
    || snEvents.find((e) => e.sessionId)?.sessionId;
  if (!sessionId) { console.error('session/new failed:', sn.status, sn.text.slice(0, 500)); process.exit(1); }
  console.log('NEW SESSION sessionId =', sessionId);

  console.log('\nRESULT:' + JSON.stringify({ connectionId, sessionId, serverInfo: serverInfo?.result?.serverInfo || null }));
}

main().catch((e) => { console.error('error', e.message); process.exit(1); });
