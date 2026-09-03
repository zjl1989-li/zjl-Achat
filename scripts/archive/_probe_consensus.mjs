// Consensus orchestration test (no network): B-class agents with no API key
// return immediately, so we can verify rounds/frames/conclusion without tokens.
import { runConsensus } from '../server/bus.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const agents = [
  { id: 'a', name: '北辰', adapterType: 'B', config: {}, model: 'deepseek-chat' },
  { id: 'b', name: 'DSH', adapterType: 'B', config: {}, model: 'deepseek-chat' },
  { id: 'c', name: '投资研究', adapterType: 'B', config: {}, model: 'deepseek-chat' },
];

const events = [];
const negs = [];
const emit = (ev, data) => { if (ev === 'message') events.push(data); if (ev === 'negotiation') negs.push(data); };
const persist = () => {};

const conv = { id: 't', type: 'group', memberIds: ['a', 'b', 'c'], messages: [], negotiation: null };

await runConsensus({
  conv, agents,
  topic: '今天午饭吃什么',
  participantIds: ['a', 'b', 'c'],
  rounds: 2,
  synthesizerId: 'c',
  emit, persist,
  recordTool: () => {},
  settings: { delegation: false },
});

const roundFrames = conv.messages.filter((m) => m.meta && m.meta.consensus && m.meta.kind === 'round');
const conclFrame = conv.messages.filter((m) => m.meta && m.meta.consensus && m.meta.kind === 'conclusion');
const conclMsg = conv.messages.filter((m) => m.meta && m.meta.consensusConclusion);

ok(roundFrames.length === 2, `应有 2 个 round 帧，实际 ${roundFrames.length}`);
ok(conclFrame.length === 1, `应有 1 个 conclusion 帧，实际 ${conclFrame.length}`);
ok(conclMsg.length === 1, `应有 1 条共识结论消息，实际 ${conclMsg.length}`);
ok(conclMsg[0]?.agentId === 'c', `共识结论应由综合者 c 产出，实际 ${conclMsg[0]?.agentId}`);
// each participant replied once per round (2 rounds) -> 3*2 = 6, plus 1
// conclusion reply from the synthesizer => 7 agent messages total.
const agentMsgs = conv.messages.filter((m) => m.sender === 'agent');
ok(agentMsgs.length === 7, `应有 7 条 agent 回复(3人x2轮 + 1结论)，实际 ${agentMsgs.length}`);
ok(conv.negotiation && conv.negotiation.status === 'done', 'negotiation.status 应为 done');
ok(conv.negotiation.active === false, 'negotiation.active 应为 false');
ok(negs.length >= 4, `应发出多帧 negotiation 进度事件，实际 ${negs.length}`);
console.log('  negotiation:', negs.map((n) => `${n.negotiation.phase}:${n.negotiation.status}`).join(' -> '));
ok(negs[negs.length - 1].negotiation.status === 'done', '最后一帧 negotiation 应为 done');

// concurrency guard: a second run should refuse while active
conv.negotiation.active = true;
let threw = false;
try {
  await runConsensus({ conv, agents, topic: 'x', participantIds: ['a', 'b'], rounds: 1, emit, persist, recordTool: () => {}, settings: {} });
} catch { threw = true; }
ok(threw, '协商进行中应拒绝第二次发起');

console.log(`\nconsensus probe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
