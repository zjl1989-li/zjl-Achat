// E2E probe: Codex joins achat as a G-class (CLI) member and answers a group
// message via a real `codex exec` turn. Requires the codex++ proxy host
// (127.0.0.1:57321) to be up and the account to have balance.
// Run: node scripts/test-codex-cli.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 18700 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const j = (r) => r.json();

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return j(res);
}

// Isolated instance: temp dir with server/ + public/ copied, no real data.json.
const tmp = mkdtempSync(join(tmpdir(), 'achat-codex-e2e-'));
cpSync('server', join(tmp, 'server'), { recursive: true, filter: (s) => !/data\.json|space|avatars|archive|\.log/.test(s) });
const child = spawn(process.execPath, ['server/server.mjs'], {
  cwd: tmp, env: { ...process.env, PORT: String(PORT) }, windowsHide: true, stdio: 'ignore',
});

let failed = false;
try {
  // wait for the server to accept requests
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    up = await fetch(BASE + '/api/agents').then((r) => r.ok).catch(() => false);
  }
  if (!up) throw new Error('server did not start');

  const agent = await api('POST', '/api/agents', {
    name: 'Codex', adapterType: 'G', role: 'CLI agent', model: 'deepseek-v4-flash',
    config: {
      cliCmd: 'codex',
      cliArgs: ['exec', '--skip-git-repo-check', '{prompt}'],
      outFileFlag: '-o', timeoutMs: 300000,
    },
  });
  console.log(`agent created: ${agent.id} adapterType=${agent.adapterType}`);
  if (agent.adapterType !== 'G') throw new Error(`expected adapterType G, got ${agent.adapterType}`);

  const group = await api('POST', '/api/groups', { name: 'codex-e2e', memberIds: [agent.id] });
  console.log(`group created: ${group.id}`);

  await api('POST', `/api/conversations/${group.id}/messages`, {
    text: `@Codex Do not use any tools. Reply with exactly two characters: OK`, toAgentId: agent.id,
  });
  console.log('message sent, waiting for codex exec reply (up to 300s)...');

  let reply = '';
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const conv = await api('GET', `/api/conversations/${group.id}`);
    const m = (conv.messages || []).filter((x) => x.sender === 'agent').pop();
    if (m) { reply = m.text || ''; break; }
  }
  if (!reply) throw new Error('no reply within 300s');
  console.log(`reply: ${JSON.stringify(reply.slice(0, 200))}`);
  // The reply must come from the final-message file: no session header noise.
  if (/tokens used|session id|--------/.test(reply)) throw new Error('reply contains raw CLI noise - output extraction failed');
  if (!/OK/.test(reply)) throw new Error(`reply does not contain OK`);
  console.log('E2E PASS');
} catch (e) {
  failed = true;
  console.log(`E2E FAIL: ${e.message}`);
} finally {
  child.kill('SIGTERM');
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* locked */ }
}
process.exit(failed ? 1 : 0);
