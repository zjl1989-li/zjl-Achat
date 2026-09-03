// Zero-cost regression test for the launcher + dumb-monitor full loop.
// No LLM is invoked: the bridge's agentEntry (demo-agent.mjs) calls the real
// GitHub API. Verifies: (1) group message routed to beichen-bridge only,
// (2) monitor auto-picks the task, (3) a real reply + artifact come back,
// (4) the artifact is filed into the group space, (5) monitor still alive.
// Pure ESM, ASCII only. Usage: node scripts/test-launch-loop.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:8787';
const ROOT = process.cwd();

async function api(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
  return cond;
}

async function main() {
  // 1) create a group with beichen-bridge as the only member
  const grp = await api('/api/groups', 'POST', { name: '回归测试-全自动闭环', memberIds: ['beichen-bridge'] });
  const convId = grp.id;
  console.log('group created:', convId);

  // 2) send a message directed ONLY at beichen-bridge (no broadcast to others)
  await api(`/api/conversations/${convId}/messages`, 'POST', {
    text: '北辰帮我上github找一个量化交易项目，分析后生成一份报告给我！',
    toAgentId: 'beichen-bridge',
  });

  // 3) poll the conversation for the agent's reply (max ~30s)
  let reply = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const conv = await api(`/api/conversations/${convId}`);
    reply = (conv.messages || []).find((m) => m.sender === 'agent' && m.agentId === 'beichen-bridge');
    if (reply) break;
  }
  ok(!!reply, 'beichen-bridge produced a reply');
  if (reply) {
    ok(/github|star|报告|分析/i.test(reply.text || ''), 'reply references real analysis');
    console.log('  reply:', (reply.text || '').slice(0, 140));
    const arts = reply.artifacts || [];
    ok(arts.length >= 1, `reply carries ${arts.length} artifact(s)`);
    if (arts[0]) console.log('  artifact:', arts[0].name, '->', arts[0].path);
  }

  // 4) artifact should also be filed into the group space (by the monitor)
  const conv = await api(`/api/conversations/${convId}`);
  const spaceArts = (conv.artifacts || []).filter((a) => a.ownerId === 'beichen-bridge');
  ok(spaceArts.length >= 1, `group space has ${spaceArts.length} artifact(s) from beichen-bridge`);
  if (spaceArts[0]) {
    const local = join(ROOT, 'server', 'space', convId, spaceArts[0].name);
    ok(existsSync(local), `artifact file exists on disk: ${spaceArts[0].name}`);
  }

  // 5) monitor must still be alive (self-heal promise)
  const pidPath = join(ROOT, 'bridge', 'beichen-bridge', 'monitor.pid');
  const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8').trim()) : null;
  let alive = false;
  if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
  ok(alive, `monitor still alive (pid=${pid})`);

  console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
}

main().catch((e) => { console.error('test error', e); process.exit(1); });
