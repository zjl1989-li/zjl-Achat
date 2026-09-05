// Memory-layer tests: knowledge (obsidian vault), skills, acl, plus the
// cross-platform listening-port enumeration behind WbAcp discovery.
// Pure node:test, zero dependencies, ASCII only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledge } from '../server/memory/knowledge.mjs';
import { createSkills } from '../server/memory/skills.mjs';
import { createAcl } from '../server/memory/acl.mjs';
import { listListeningPorts } from '../server/adapters.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'achat-mem-'));
}

test('knowledge: write + search + read roundtrip', () => {
  const dir = join(tmp(), 'vault');
  const kb = createKnowledge({ dir });
  kb.write({ title: 'Ticker Notes', body: 'favorite stock is TBEA with 20 percent position', tags: ['stock'] });
  const hits = kb.search('TBEA');
  assert.equal(hits.length, 1);
  assert.ok(hits[0].score >= 1);            // body hit
  assert.ok(kb.search('ticker')[0].score >= 3);  // title hit weighs most
  const doc = kb.read('Ticker Notes');
  assert.ok(doc.body.includes('TBEA'));
  assert.equal(doc.meta.source, 'achat');
});

test('knowledge: same-title write appends a dated section (distill, not overwrite)', () => {
  const dir = join(tmp(), 'vault');
  const kb = createKnowledge({ dir });
  kb.write({ title: 'Group Conclusions', body: 'v1: keep zero deps' });
  kb.write({ title: 'Group Conclusions', body: 'v2: also add CI' });
  const doc = kb.read('Group Conclusions');
  assert.ok(doc.body.includes('v1: keep zero deps'));
  assert.ok(doc.body.includes('v2: also add CI'));
  assert.ok(/## \d{4}-\d{2}-\d{2}T/.test(doc.body));   // dated section header
});

test('knowledge: traversal titles stay inside the vault', () => {
  const dir = join(tmp(), 'vault');
  mkdirSync(dir, { recursive: true });
  const kb = createKnowledge({ dir });
  // '../..' characters are stripped by sanitizeTitle, so nothing escapes.
  const r = kb.write({ title: '../../evil', body: 'x' });
  assert.ok(r.path.startsWith(dir));
  assert.ok(!existsSync(join(dir, '..', 'evil.md')));
  assert.ok(!existsSync(join(dir, '..', '..', 'evil.md')));
  assert.equal(kb.read('..\\..\\evil2'), null);
});

test('knowledge: empty body rejected, remove works', () => {
  const dir = join(tmp(), 'vault');
  const kb = createKnowledge({ dir });
  assert.throws(() => kb.write({ title: 'x', body: '   ' }));
  kb.write({ title: 'Temp', body: 'data' });
  assert.equal(kb.remove('Temp'), true);
  assert.equal(kb.remove('Temp'), false);
  assert.deepEqual(kb.search('data'), []);
});

test('skills: register / get / upsert / remove, persisted to disk', () => {
  const file = join(tmp(), 'skills.json');
  const sk = createSkills({ file });
  sk.register({ id: 'summarize', name: 'Summarize', prompt: 'Summarize the thread' });
  assert.equal(sk.get('summarize').prompt, 'Summarize the thread');
  sk.register({ id: 'summarize', prompt: 'Summarize in plain words' });   // upsert
  assert.equal(sk.get('summarize').prompt, 'Summarize in plain words');
  assert.equal(sk.list().length, 1);
  assert.throws(() => sk.register({ id: 'empty' }));                      // no prompt/tools
  // Fresh instance reads the same file - real persistence, not memory-only.
  const sk2 = createSkills({ file });
  assert.equal(sk2.get('summarize').prompt, 'Summarize in plain words');
  assert.equal(sk2.remove('summarize'), true);
  assert.equal(sk2.get('summarize'), null);
});

test('acl: fail-closed by default, grant/revoke/audit', () => {
  const file = join(tmp(), 'acl.json');
  const acl = createAcl({ file });
  // No grant on file -> DENY, even for missing records entirely.
  assert.equal(acl.can({ convId: 'c1', agentId: 'a1', cap: 'kb.write' }), false);
  assert.equal(acl.can({}), false);
  acl.grant({ convId: 'c1', agentId: 'a1', cap: 'kb.write', grantedBy: 'user' });
  assert.equal(acl.can({ convId: 'c1', agentId: 'a1', cap: 'kb.write' }), true);
  // Scoping is exact: another conversation or capability stays denied.
  assert.equal(acl.can({ convId: 'c2', agentId: 'a1', cap: 'kb.write' }), false);
  assert.equal(acl.can({ convId: 'c1', agentId: 'a1', cap: 'kb.delete' }), false);
  // Wildcard grant is explicit, never implicit.
  acl.grant({ convId: 'c2', agentId: '*', cap: 'kb.read' });
  assert.equal(acl.can({ convId: 'c2', agentId: 'anyone', cap: 'kb.read' }), true);
  assert.equal(acl.can({ convId: 'c3', agentId: 'anyone', cap: 'kb.read' }), false);
  const trail = acl.audit();
  assert.equal(trail.length, 2);
  assert.ok(trail.every((g) => g.ts > 0 && typeof g.grantedBy === 'string'));
  assert.equal(acl.revoke({ convId: 'c1', agentId: 'a1', cap: 'kb.write' }), true);
  assert.equal(acl.can({ convId: 'c1', agentId: 'a1', cap: 'kb.write' }), false);
  // Double revoke is a no-op, not an error.
  assert.equal(acl.revoke({ convId: 'c1', agentId: 'a1', cap: 'kb.write' }), false);
  assert.ok(existsSync(file));
  assert.ok(readFileSync(file, 'utf8').includes('grantedBy'));
});

test('listListeningPorts: cross-platform enumeration returns sane ports', () => {
  const ports = listListeningPorts();
  assert.ok(Array.isArray(ports));
  for (const p of ports) {
    assert.ok(Number.isInteger(p) && p > 0 && p < 65536, `bad port ${p}`);
  }
  // A live system always has at least the loopback of THIS test runner's
  // parent chain listening somewhere; on any CI runner something listens.
  // Do not assert non-empty though: a locked-down sandbox may hide them all.
});
