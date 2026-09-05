// node:test unit/integration suite for Tmesh core.
// Zero dependencies: node:test + node:assert only. ASCII only.
// Isolation: copies server/ + public/ into a per-run temp dir (excluding the
// real data.json / avatars / logs), so production data is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, cpSync, writeFileSync, existsSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let tmp, store, srvProc, base;

function req(pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + pathname, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function waitHealth(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await req('/api/conversations');
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((s) => setTimeout(s, 200));
  }
  throw new Error('server did not become healthy in time');
}

// ~5KB of base64 so persistAvatar's >4KB threshold trips.
const B64 = Buffer.alloc(6000, 7).toString('base64');

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'achat-test-'));
  // Copy server/ without production data, plus public/ for static-serve tests.
  cpSync(join(ROOT, 'server'), join(tmp, 'server'), {
    recursive: true,
    filter: (f) => !/(data\.json|avatars|space[\\/]|\.log|\.bak|\.corrupt|\.pre-optimize|\.achat\.lock)$/.test(f),
  });
  cpSync(join(ROOT, 'public'), join(tmp, 'public'), {
    recursive: true,
    filter: (f) => !f.includes('.backup-'),
  });
  // Regression: a stale lock (pid of a long-dead process) must be taken over,
  // not brick startup. Covers the Windows kill(pid,0) quirk fix.
  writeFileSync(join(tmp, 'server', '.achat.lock'), '999999999');
  writeFileSync(join(tmp, 'server', 'data.json'), JSON.stringify({
    revision: 0,
    savedAt: new Date().toISOString(),
    agents: [
      { id: 'a1', name: 'A1', avatar: 'data:image/png;base64,' + B64, config: { a: { b: 1 } } },
      { id: 'a2', name: 'A2', avatar: 'data:image/x-icon;base64,' + B64 },
    ],
    conversations: {
      c1: { id: 'c1', name: 'G1', messages: [{ id: 'm1', from: 'user', text: 'hi' }], artifacts: [], memberIds: ['a1', 'a2'] },
    },
    toolStats: {},
    settings: {},
  }));
  ({ store } = await import(pathToFileURL(join(tmp, 'server', 'store.mjs')).href));

  const port = 20000 + (process.pid % 20000);
  base = `http://127.0.0.1:${port}`;
  srvProc = spawn(process.execPath, [join(tmp, 'server', 'server.mjs')], {
    cwd: tmp, env: { ...process.env, PORT: String(port) }, stdio: 'ignore',
  });
  await waitHealth();
});

after(() => {
  if (srvProc) srvProc.kill();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* windows may lag */ }
});

// ---------- store ----------

test('boot migration offloads large base64 avatars to files', () => {
  const [a1, a2] = store.getAgents();
  assert.equal(a1.avatar, '/avatars/a1.png');
  assert.equal(a2.avatar, '/avatars/a2.ico');
  assert.ok(existsSync(join(tmp, 'server', 'avatars', 'a1.png')));
  assert.ok(existsSync(join(tmp, 'server', 'avatars', 'a2.ico')));
});

test('conversations use object-key format (id -> object)', () => {
  assert.equal(store.getConversation('c1').name, 'G1');
  assert.equal(store.getConversations().length, 1);
});

test('upsertAgent deep-merges config patches', () => {
  store.upsertAgent({ id: 'a1', config: { launcher: { enabled: true } } });
  const a1 = store.getAgents().find((x) => x.id === 'a1');
  assert.equal(a1.config.a.b, 1); // untouched leaf survives
  assert.equal(a1.config.launcher.enabled, true);
});

test('avatar offload also runs on upsertAgent', () => {
  store.upsertAgent({ id: 'a3', name: 'A3', avatar: 'data:image/webp;base64,' + B64 });
  const a3 = store.getAgents().find((x) => x.id === 'a3');
  assert.equal(a3.avatar, '/avatars/a3.webp');
  assert.ok(existsSync(join(tmp, 'server', 'avatars', 'a3.webp')));
});

test('save is atomic: data.json parses, no .tmp residue', () => {
  store.upsertConversation({ id: 'g1', name: 'T', messages: [], artifacts: [], memberIds: [] });
  const parsed = JSON.parse(readFileSync(join(tmp, 'server', 'data.json'), 'utf8'));
  assert.ok(parsed.conversations.g1);
  assert.ok(!existsSync(join(tmp, 'server', 'data.json.tmp')));
});

test('deleteAgent scrubs the member list of every group', () => {
  store.deleteAgent('a2');
  assert.ok(!store.getAgents().some((x) => x.id === 'a2'));
  assert.ok(!store.getConversation('c1').memberIds.includes('a2'));
});

// ---------- server API surface ----------

test('GET /api/conversations returns summary list', async () => {
  const r = await req('/api/conversations');
  assert.equal(r.status, 200);
  const list = JSON.parse(r.body);
  assert.ok(Array.isArray(list));
  assert.ok(list.some((c) => c.id === 'c1' && c.count === 1));
});

test('POST /api/groups creates a group and it lists back', async () => {
  const r = await req('/api/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'UT' }),
  });
  assert.equal(r.status, 200);
  const { id } = JSON.parse(r.body);
  const list = JSON.parse((await req('/api/conversations')).body);
  assert.ok(list.some((c) => c.id === id));
});

test('forged Host header is rejected with 403 (DNS rebinding guard)', async () => {
  const r = await req('/api/conversations', { headers: { host: 'evil.example.com' } });
  assert.equal(r.status, 403);
});

test('/api/fetch blocks loopback and LAN targets (SSRF guard)', async () => {
  for (const target of ['http://127.0.0.1:9/', 'http://192.168.1.1/']) {
    const r = await req('/api/fetch?url=' + encodeURIComponent(target));
    assert.equal(r.status, 403, target);
  }
});

test('/api/fetch rejects non-http schemes', async () => {
  const r = await req('/api/fetch?url=' + encodeURIComponent('file:///etc/passwd'));
  assert.equal(r.status, 400);
});

test('/files serves only image extensions from absolute paths', async () => {
  const ok = await req('/files?path=' + encodeURIComponent(join(tmp, 'public', 'logo.png')));
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /png/);

  const notImg = await req('/files?path=' + encodeURIComponent(join(tmp, 'server', 'data.json')));
  assert.equal(notImg.status, 400);

  const missing = await req('/files?path=' + encodeURIComponent(join(tmp, 'nope.png')));
  assert.equal(missing.status, 404);

  const rel = await req('/files?path=' + encodeURIComponent('x.png'));
  assert.equal(rel.status, 400);
});

test('static path traversal is blocked', async () => {
  const r = await req('/..%2fserver%2fserver.mjs');
  assert.equal(r.status, 404);
});

test('/avatars filename whitelist blocks traversal', async () => {
  const r = await req('/avatars/..%2fdata.json');
  assert.equal(r.status, 404);
});
