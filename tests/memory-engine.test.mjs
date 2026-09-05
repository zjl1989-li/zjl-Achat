// Memory-engine pipe tests: L0 context budget (bus.buildContext) and the
// L1 -> L2 distillation pipe (distill.conv / distill.message).
// Pure node:test, zero dependencies, ASCII only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../server/bus.mjs';
import { distillConv, distillMessage } from '../server/memory/distill.mjs';
import { createKnowledge } from '../server/memory/knowledge.mjs';

const agents = [
  { id: 'a1', name: '北辰' },
  { id: 'a2', name: 'DSH' },
];

function convOf(messages) {
  return { id: 'c1', name: '测试群', memberIds: ['a1', 'a2'], messages };
}

test('L0 budget: old turns dropped, the turn being answered always kept', () => {
  // 5 user turns of ~50 chars each (250 total) with a 120-char budget.
  const msgs = [];
  for (let i = 1; i <= 5; i++) {
    msgs.push({ sender: 'user', text: `问题${i}：${'内容'.repeat(20)}` });
    msgs.push({ sender: 'agent', agentId: 'a1', text: `回答${i}：${'分析'.repeat(20)}` });
  }
  const ctx = buildContext(convOf(msgs), 'a1', agents, 120);
  // Something was trimmed...
  const joined = ctx.map((m) => m.content).join('\n');
  assert.ok(!joined.includes('问题1'), 'oldest user turn should be dropped');
  // ...but the turn being answered (the LAST user message) survives.
  assert.ok(joined.includes('问题5'), 'last user turn must always be kept');
});

test('L0 budget: everything kept while under budget', () => {
  const msgs = [
    { sender: 'user', text: '你好' },
    { sender: 'agent', agentId: 'a1', text: '你好，有什么可以帮你？' },
  ];
  const ctx = buildContext(convOf(msgs), 'a1', agents, 12000);
  assert.equal(ctx.length, 2);
});

test('distill: whole-conversation digest covers seats, asks, artifacts', () => {
  const conv = convOf([
    { sender: 'user', text: '帮我们评估一下要不要上 CI' },
    { sender: 'system', text: '议题：CI 上不上', ts: Date.now(), meta: { consensus: true, kind: 'round' } },
    { sender: 'agent', agentId: 'a1', text: '建议上，成本为零收益明显。' },
    { sender: 'agent', agentId: 'a2', text: '同意，我来写 workflow。', artifacts: [{ id: 'x1', name: 'ci.yml', path: '/tmp/ci.yml' }] },
  ]);
  const note = distillConv(conv, agents);
  assert.match(note.title, /群档-测试群/);
  assert.ok(note.body.includes('北辰'));
  assert.ok(note.body.includes('DSH'));
  assert.ok(note.body.includes('要不要上 CI'));
  assert.ok(note.body.includes('ci.yml'));
});

test('distill: single message pin keeps speaker and timestamp', () => {
  const ts = Date.now();
  const conv = convOf([{ sender: 'agent', agentId: 'a1', text: '最终决定：采用零依赖方案。', ts }]);
  const note = distillMessage(conv, conv.messages[0], agents);
  assert.match(note.title, /群档-测试群-摘录/);
  assert.ok(note.body.includes('北辰'));
  assert.ok(note.body.includes('零依赖方案'));
  assert.ok(note.body.includes('时间：'));
});

test('pipe: distill -> KB write -> recall finds it back (roundtrip)', () => {
  const kb = createKnowledge({ dir: join(mkdtempSync(join(tmpdir(), 'achat-pipe-')), 'kb') });
  const conv = convOf([
    { sender: 'user', text: '小组结论：KLineChart 胜出，下周接入行情面板' },
  ]);
  const d = distillConv(conv, agents);
  kb.write({ ...d, source: 'distill' });
  const hits = kb.search('KLineChart');
  assert.equal(hits.length, 1);
  assert.ok(hits[0].snippet.length > 0 || hits[0].score > 0);
  // Same-title re-distill appends a dated section, not a duplicate note.
  kb.write({ ...d, source: 'distill' });
  const files = kb.recent(10);
  assert.equal(files.filter((f) => f.title === d.title).length, 1);
});
