// Real end-to-end consensus test against the live achat server.
// Uses the dsh + dsh2 (two A-class DSH sessions) group so both participants
// genuinely reply without any API key. Validates: round frames injected,
// parallel dispatch, synthesizer conclusion, negotiation status transitions,
// errors isolation, and persistence.
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:8787';
const groupId = process.argv[2] || 'mtjq0ze8qjhdku';
const rounds = Number(process.argv[3] || 2);
const synthId = process.argv[4] || 'dsh';
const participants = process.argv.slice(5).length ? process.argv.slice(5) : ['dsh', 'dsh2'];
const topic = '我们合作做一个命令行待办工具。请协商：① 用什么语言实现；② 核心功能范围；③ 数据怎么存。各自先发表立场，再逐步收敛。';
const body = { topic, participantIds: participants, rounds, synthesizerId: synthId };

const get = async (p) => (await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' } })).json();

async function main() {
  console.log('== launch consensus on', groupId, '==');
  const r = await fetch(`${BASE}/api/conversations/${groupId}/consensus`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  console.log('launch status:', r.status, (await r.text()).slice(0, 80));

  const deadline = Date.now() + 240000;
  let lastRound = -1, lastStatus = '';
  while (Date.now() < deadline) {
    const c = await get(`/api/conversations/${groupId}`);
    const n = c.negotiation;
    if (n && (n.round !== lastRound || n.status !== lastStatus)) {
      lastRound = n.round; lastStatus = n.status;
      console.log(`[t+${((Date.now() - (n.startedAt || Date.now())) / 1000).toFixed(0)}s] phase=${n.phase} round=${n.round}/${n.rounds} status=${n.status} errors=${n.errors ? n.errors.length : 0}`);
      if (n.errors && n.errors.length) console.log('   errors:', JSON.stringify(n.errors));
    }
    if (n && n.status === 'done') break;
    await sleep(2500);
  }

  const c = await get(`/api/conversations/${groupId}`);
  const msgs = c.messages || [];
  const roundFrames = msgs.filter((m) => m.meta && m.meta.kind === 'round');
  const conclFrames = msgs.filter((m) => m.meta && m.meta.kind === 'conclusion');
  const agentReplies = msgs.filter((m) => m.sender === 'agent');
  const dshReplies = agentReplies.filter((m) => m.agentId === 'dsh');
  const dsh2Replies = agentReplies.filter((m) => m.agentId === 'dsh2');
  const concl = agentReplies.filter((m) => m.meta && m.meta.consensusConclusion);

  console.log('\n== RESULT ==');
  console.log('negotiation.status :', c.negotiation && c.negotiation.status);
  console.log('round frames      :', roundFrames.length, '(expect 2)');
  console.log('conclusion frames :', conclFrames.length, '(expect 1)');
  console.log('agent replies     :', agentReplies.length, '(expect 2*2+1=5)');
  console.log('  dsh replies     :', dshReplies.length);
  console.log('  dsh2 replies    :', dsh2Replies.length);
  console.log('consensus concl.  :', concl.length, '(expect 1)');
  console.log('errors            :', JSON.stringify(c.negotiation && c.negotiation.errors || []));
  console.log('\n== synthesizer conclusion (first 400 chars) ==');
  if (concl[0]) console.log(concl[0].text.slice(0, 400));
  const ok = c.negotiation && c.negotiation.status === 'done' && roundFrames.length === 2 && conclFrames.length === 1 && dshReplies.length >= 2 && dsh2Replies.length >= 2;
  console.log('\nE2E_PASS=' + ok);
  process.exit(ok ? 0 : 2);
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
