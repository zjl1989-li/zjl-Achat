// Cross-agent drive test: DSH (third party) drives the REAL WorkBuddy app.
// NOT self-referential - the driver is DSH, the driven is WorkBuddy's own
// Remote Control ACP service. Chain:
//   user msg -> bus.dispatch(toAgentId=dsh) -> DSH replies (asks WB)
//   -> bus.dispatch(toAgentId=workbuddy, delegatedBy=dsh) -> WbAcpAdapter
//   -> WorkBuddy RC -> reply lands back in the group conv.
// Run: node scripts/test-dsh-drive-wb.mjs
import { readFileSync } from 'node:fs';
import { dispatch, probeAgent } from '../server/bus.mjs';

const store = JSON.parse(readFileSync(new URL('../server/data.json', import.meta.url), 'utf8'));
const all = store.agents || [];
const dsh = all.find((a) => a.id === 'dsh');
const wb = all.find((a) => a.id === 'workbuddy');
if (!dsh || !wb) { console.error('agents dsh/workbuddy not found in data.json'); process.exit(1); }

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

const events = [];
const emit = (t, d) => events.push({ t, d });
const persist = () => {};
const recordTool = () => {};

async function main() {
  console.log('== cross-agent drive: DSH -> WorkBuddy real app ==');
  console.log('probe dsh...', await probeAgent(dsh));
  console.log('probe workbuddy...', await probeAgent(wb));

  const conv = {
    id: 'g-wb-drive', type: 'group',
    memberIds: ['dsh', 'workbuddy'],
    messages: [{
      id: 'm1', sender: 'user',
      text: '@DSH 请向群里的 WorkBuddy 真身提问：请它只回复「桥接成功」这四个字，不要加任何其他内容。',
      ts: Date.now(),
    }],
  };

  // Hop 1: DSH answers and asks WorkBuddy.
  console.log('\n-- hop 1: dispatch to DSH --');
  await dispatch({ conv, agents: [dsh, wb], toAgentId: 'dsh', emit, persist, recordTool, settings: {} });
  const dshReply = conv.messages.filter((m) => m.sender === 'agent' && m.agentId === 'dsh').at(-1);
  console.log('DSH reply:', JSON.stringify(dshReply?.text));
  check('dsh replied', !!dshReply?.text);
  check('dsh has no error', !dshReply?.error, JSON.stringify(dshReply));

  // Hop 2: hand the turn to WorkBuddy, marked as delegated by DSH.
  console.log('\n-- hop 2: dispatch to WorkBuddy (delegated by DSH) --');
  await dispatch({
    conv, agents: [dsh, wb], toAgentId: 'workbuddy', delegatedBy: 'dsh', depth: 1,
    emit, persist, recordTool, settings: {},
  });
  const wbReply = conv.messages.filter((m) => m.sender === 'agent' && m.agentId === 'workbuddy').at(-1);
  console.log('WorkBuddy reply:', JSON.stringify(wbReply?.text));
  check('workbuddy replied', !!wbReply?.text);
  check('workbuddy has no error', !wbReply?.error, JSON.stringify(wbReply));
  check('workbuddy text is 桥接成功', wbReply?.text?.includes('桥接成功'), `got=${JSON.stringify(wbReply?.text)}`);

  console.log('\n-- conversation --');
  for (const m of conv.messages) {
    const who = m.sender === 'user' ? 'user' : (m.agentId || m.sender);
    console.log(`[${who}] ${String(m.text || '').slice(0, 200)}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
