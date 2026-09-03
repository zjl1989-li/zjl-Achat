// Probe: W-class cli-key adapter routing + CLI stdout parsing + env isolation.
// No real key / no network needed.
import { describeProbe, createAdapter, extractCliReply, cliEnv } from '../server/adapters.mjs';

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

// 1) explicit apiKey -> W + WbCliKeyAdapter
const a1 = { id: 'w1', name: 'WB-key', config: { apiKey: 'sk-test-123' } };
check('probe {apiKey} -> W', describeProbe(a1).type === 'W');
check('createAdapter {apiKey} -> WbCliKeyAdapter', createAdapter(a1).constructor.name === 'WbCliKeyAdapter');

// 2) env var CODEBUDDY_API_KEY set -> WbCliKeyAdapter wins over RC (host/port)
process.env.CODEBUDDY_API_KEY = 'sk-env-999';
const a2 = { id: 'w2', name: 'WB-env', config: { host: '127.0.0.1', port: 49796 } };
check('probe {host,port} still -> W', describeProbe(a2).type === 'W');
check('createAdapter env-key -> WbCliKeyAdapter (key wins)', createAdapter(a2).constructor.name === 'WbCliKeyAdapter');
delete process.env.CODEBUDDY_API_KEY;

// 3) no key + host/port -> WbAcpAdapter (RC fallback, unchanged)
const a3 = { id: 'w3', name: 'WB-rc', config: { host: '127.0.0.1', port: 49796 } };
check('createAdapter {host,port} no key -> WbAcpAdapter', createAdapter(a3).constructor.name === 'WbAcpAdapter');

// 4) meta sanity
const ad = createAdapter(a1);
check('WbCliKeyAdapter meta.adapterType === W', ad.meta().adapterType === 'W');
check('WbCliKeyAdapter meta.hasNativeSession === false', ad.meta().hasNativeSession === false);

// 5) WbAcpAdapter unaffected
const rc = createAdapter(a3);
check('WbAcpAdapter meta.adapterType === W', rc.meta().adapterType === 'W');
check('WbAcpAdapter still present (no regression)', rc.constructor.name === 'WbAcpAdapter');

// 6) extractCliReply: real `--output-format json` shape is an ARRAY whose trailing
//    element is {type:'result', result:'<text>', usage:{...}} (captured live 2026-09-02).
const liveShape = JSON.stringify([
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  { type: 'message', role: 'assistant', sessionId: 'x' },
  {
    type: 'result', subtype: 'success', is_error: false,
    result: 'cli-key 通路已连通', duration_ms: 2972,
    usage: { input_tokens: 23512, output_tokens: 7 },
  },
]);
const r6 = extractCliReply(liveShape);
check('extractCliReply array -> reply text', r6.text === 'cli-key 通路已连通');
check('extractCliReply array -> usage passthrough', r6.usage && r6.usage.input_tokens === 23512);
check('extractCliReply array -> isError false', r6.isError === false);

const r7 = extractCliReply(JSON.stringify([{ type: 'result', is_error: true, result: 'boom' }]));
check('extractCliReply flags is_error', r7.isError === true && r7.text === 'boom');
check('extractCliReply bare object', extractCliReply('{"result":"ok"}').text === 'ok');
check('extractCliReply plain text fallback', extractCliReply('hello').text === 'hello');
check('extractCliReply empty', extractCliReply('').text === '');

// 7) cliEnv must NOT leak the desktop app's session env into the CLI child, or the
//    child binds the desktop's port (EADDRINUSE) and hangs with zero output.
process.env.CODEBUDDY_SERVICE_PROXY_URL = 'http://127.0.0.1:60314/internal/hooks/services/invoke';
process.env.CODEBUDDY_GATEWAY_PASSWORD = 'leak-me';
process.env.CODEBUDDY_MCP_CONFIG = '{"mcpServers":{}}';
process.env.CODEBUDDY_SESSION_ID = 'sess-leak';
const e = cliEnv('sk-key', 'internal');
check('cliEnv drops CODEBUDDY_SERVICE_PROXY_URL', e.CODEBUDDY_SERVICE_PROXY_URL === undefined);
check('cliEnv drops CODEBUDDY_GATEWAY_PASSWORD', e.CODEBUDDY_GATEWAY_PASSWORD === undefined);
check('cliEnv drops CODEBUDDY_MCP_CONFIG', e.CODEBUDDY_MCP_CONFIG === undefined);
check('cliEnv drops CODEBUDDY_SESSION_ID', e.CODEBUDDY_SESSION_ID === undefined);
check('cliEnv keeps only 1 injected key var', e.CODEBUDDY_API_KEY === 'sk-key');
check('cliEnv sets internet environment', e.CODEBUDDY_INTERNET_ENVIRONMENT === 'internal');
check('cliEnv keeps PATH', typeof e.PATH === 'string' || typeof e.Path === 'string');
check('cliEnv leaks no other CODEBUDDY_*',
  Object.keys(e).filter((k) => k.startsWith('CODEBUDDY_')).length === 3);
delete process.env.CODEBUDDY_SERVICE_PROXY_URL;
delete process.env.CODEBUDDY_GATEWAY_PASSWORD;
delete process.env.CODEBUDDY_MCP_CONFIG;
delete process.env.CODEBUDDY_SESSION_ID;

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
