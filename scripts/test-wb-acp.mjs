// End-to-end test for the WorkBuddy ACP bridge adapter (type 'W').
// Default: drives the REAL WorkBuddy desktop app via its Remote Control ACP
// service (WorkBuddy must be running, port auto-discovered).
// With WB_PORT set: talks to a mock ACP server on that port instead (no real
// WorkBuddy needed) - used to verify the adapter code offline.
// Run: node scripts/test-wb-acp.mjs
//      WB_PORT=55999 node scripts/test-wb-acp.mjs   (against _mock_acp.mjs)
import { createAdapter } from '../server/adapters.mjs';

const forcedPort = process.env.WB_PORT ? Number(process.env.WB_PORT) : 0;
const agent = {
  id: 'workbuddy',
  name: 'WorkBuddy 真身',
  system: '你是 WorkBuddy，一个通用 AI 助手。请用简洁的中文回答。',
  adapterType: 'W',
  config: { adapterType: 'W', host: '127.0.0.1', cwd: '.', maxWaitMs: 120000, ...(forcedPort ? { port: forcedPort } : {}) },
};

const adapter = createAdapter(agent);
console.log('meta:', JSON.stringify(adapter.meta()));

console.log('ping...');
const ok = await adapter.ping();
console.log('ping ->', ok);
if (!ok) { console.error('WorkBuddy not reachable (is it running?)'); process.exit(1); }

console.log('\nsending prompt to REAL WorkBuddy...');
const res = await adapter.send({
  agent,
  messages: [{ role: 'user', content: '请只回复「桥接成功」这四个字，不要加任何其他内容。' }],
  peers: [],
  roster: ['WorkBuddy 真身（你）', '北辰', 'DSH'],
  answerTo: null,
  allowDelegate: false,
  signal: null,
  onEvent: (ev) => console.log('  event:', ev.kind, ev.step || ''),
});
console.log('\nREPLY TEXT:', JSON.stringify(res.text));
console.log('nativeSessionId:', res.nativeSessionId);
console.log('usage:', JSON.stringify(res.usage));
process.exit(res.text && res.text.includes('桥接成功') ? 0 : 2);
