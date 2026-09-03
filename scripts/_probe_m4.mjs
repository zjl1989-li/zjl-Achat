import { describeProbe, probeAdapterType, createAdapter } from '../server/adapters.mjs';

const cases = [
  { name: 'dsh(ports)',       agent: { adapterType: 'A', config: { ports: [3080, 43120] } } },
  { name: 'workbuddy(host+port)', agent: { adapterType: 'W', config: { host: '127.0.0.1', port: 57005 } } },
  { name: 'beichen-bridge(localDir)', agent: { adapterType: 'C', config: { localDir: 'bridge/beichen-bridge' } } },
  { name: 'beichen(model)',  agent: { adapterType: 'B', config: { model: 'deepseek-chat' } } },
  { name: 'auto: ports',     agent: { config: { ports: [3080, 43120] } } },
  { name: 'auto: host+port', agent: { config: { host: '127.0.0.1', port: 57005 } } },
  { name: 'auto: localDir',   agent: { config: { localDir: 'bridge/x' } } },
  { name: 'auto: model',      agent: { config: { model: 'deepseek-chat' } } },
  { name: 'auto: mcp',        agent: { config: { mcpServer: 'stdio://x' } } },
  { name: 'auto: a2a',        agent: { config: { a2a: 'http://x' } } },
  { name: 'auto: binaryPath', agent: { config: { binaryPath: 'C:/x/exe' } } },
  { name: 'auto: empty',      agent: { config: {} } },
  { name: 'explicit override', agent: { config: { ports: [3080], adapterType: 'W' } } },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const { type, reason } = describeProbe(c.agent);
  const expected = c.agent.adapterType || null;
  const ok = expected ? type === expected : true;
  console.log(`${ok ? '✓' : '✗'} ${c.name.padEnd(24)} -> ${type}  ${reason}`);
  ok ? pass++ : fail++;
}
// createAdapter smoke: every class instantiates to a concrete adapter (M5: E/F/D no longer placeholder)
const expectClass = { A: 'DshAdapter', W: 'WbAcpAdapter', C: 'BridgeAdapter', B: 'ModelAdapter', E: 'McpAdapter', F: 'ProtocolAdapter', D: 'DesktopGuiAdapter' };
let smokeFail = 0;
for (const t of ['A', 'W', 'C', 'B', 'E', 'F', 'D']) {
  const a = createAdapter({ id: 'x', config: { adapterType: t } });
  const meta = a.meta();
  const ok = a.constructor.name === expectClass[t] && meta.adapterType === t && !meta.unsupported;
  if (!ok) smokeFail++;
  console.log(`   createAdapter(${t}) -> ${a.constructor.name}  meta.type=${meta.adapterType} unsupported=${!!meta.unsupported} ${ok ? '✓' : '✗'}`);
}
if (smokeFail) { console.log(`smoke FAILED: ${smokeFail} class(es) wrong`); fail += smokeFail; }
console.log(`\n${pass} passed, ${fail} failed`);
