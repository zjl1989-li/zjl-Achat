// End-to-end check: bus.dispatch -> BridgeAdapter -> fake product -> reply
// (with artifacts) lands in the conversation. Zero token, pure local fs.
// Catches integration gaps that unit-testing send() alone would miss: the
// bus must read artifacts/ask off the adapter result and attach them to the
// agent message it emits.
import { dispatch } from '../server/bus.mjs';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

function fakeProduct(localDir, produce, delayMs = 150) {
  return new Promise((resolve) => {
    const inbox = join(localDir, 'inbox');
    mkdirSync(inbox, { recursive: true });
    const timer = setInterval(() => {
      const files = readdirSync(inbox).filter((f) => f.endsWith('.json') && !f.endsWith('.cancel'));
      if (!files.length) return;
      clearInterval(timer);
      const taskId = files[0].replace('.json', '');
      mkdirSync(join(localDir, 'outbox'), { recursive: true });
      writeFileSync(join(localDir, 'outbox', `${taskId}.result.json`), JSON.stringify(produce()));
      resolve();
    }, 30);
    setTimeout(() => { clearInterval(timer); resolve(); }, delayMs + 3000);
  });
}

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

async function main() {
  console.log('BridgeAdapter + bus.dispatch integration (zero token):');
  const dir = mkdtempSync(join(os.tmpdir(), 'bridge-disp-'));
  const agent = {
    id: 'beichen-bridge', name: '北辰（桥接）', system: 'sys',
    config: { adapterType: 'C', localDir: dir, pollMs: 50, maxWaitMs: 180000 },
  };
  const conv = {
    id: 'g1', type: 'group', memberIds: ['beichen-bridge'],
    messages: [{ id: 'm1', sender: 'user', text: '分析一下', ts: Date.now() }],
  };
  const events = [];
  const prod = fakeProduct(dir, () => ({
    conclusion: '桥接回复',
    artifacts: [{ type: 'doc', name: 'r.md', path: join(dir, 'outbox', 'r.md') }],
  }));
  await dispatch({
    conv, agents: [agent],
    emit: (t, d) => events.push({ t, d }),
    persist: () => {}, recordTool: () => {}, settings: {},
  });
  await prod;

  const agentMsgs = events.filter((e) => e.t === 'message' && e.d.message?.sender === 'agent');
  const reply = agentMsgs.find((e) => e.d.message.agentId === 'beichen-bridge');
  check('reply event emitted', !!reply, JSON.stringify(agentMsgs.map((e) => e.d.message)));
  check('reply text', reply?.d.message.text === '桥接回复', `got=${JSON.stringify(reply?.d.message.text)}`);
  check('reply carries artifacts', reply?.d.message.artifacts?.length === 1 && reply.d.message.artifacts[0].name === 'r.md', `got=${JSON.stringify(reply?.d.message.artifacts)}`);
  check('conv received reply', conv.messages.some((m) => m.agentId === 'beichen-bridge' && m.text === '桥接回复'), JSON.stringify(conv.messages.map((m) => m.text)));
  check('no stray ask', !conv.messages.some((m) => m.ask), 'unexpected ask state');

  console.log(`\n${pass} passed, ${fail} failed`);
  rmSync(dir, { recursive: true, force: true });
  if (fail) { console.log('failed:', failures.join(', ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
