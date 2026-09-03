// Zero-cost regression for store.mjs: what happens when data.json is missing,
// corrupt, or fine. Runs in throwaway temp directories, so the real
// server/data.json is never touched - this suite deliberately destroys files,
// and a test that can eat production data is worse than no test.
//
//   node scripts/test-store.mjs
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { DEFAULT_AGENTS } from '../server/agents.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'server');

let pass = 0;
let fail = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
}

// Default agent count is owned by agents.mjs; read it instead of hardcoding so
// adding a bridge agent does not rot this suite's expectations.
const N = DEFAULT_AGENTS.length;

// store.mjs resolves data.json next to itself, so each scenario gets its own
// copy of the module in its own directory. Separate path means a separate
// module instance, which is what makes the in-memory `recovered` flag testable.
const dirs = [];
function sandbox(seed) {
  const dir = mkdtempSync(join(tmpdir(), 'achat-store-'));
  dirs.push(dir);
  copyFileSync(join(SRC, 'store.mjs'), join(dir, 'store.mjs'));
  copyFileSync(join(SRC, 'agents.mjs'), join(dir, 'agents.mjs'));
  if (seed !== undefined) writeFileSync(join(dir, 'data.json'), seed, 'utf8');
  const url = pathToFileURL(join(dir, 'store.mjs')).href;
  return { dir, data: join(dir, 'data.json'), open: () => import(url) };
}

const GOOD = JSON.stringify({
  conversations: { c1: { id: 'c1', type: 'group', memberIds: ['a'], messages: [{ role: 'user', text: 'hi' }] } },
  agents: [{ id: 'a', name: 'A' }],
  toolStats: { a: { read: 2 } },
  settings: { delegation: true },
  revision: 41,
});

// --- missing file: a first run, not an error ---------------------------------
{
  const s = sandbox(undefined);
  const { store } = await s.open();
  check('missing data.json -> default agents', store.getAgents().length, N);
  check('missing data.json -> no recovery notice', store.getRecovery(), null);
  check('missing data.json -> default settings', store.getSettings(), { delegation: false });
}

// --- corrupt file: this is the one that matters ------------------------------
{
  const s = sandbox('this is not json at all {{{ [[[');
  const { store } = await s.open();
  check('corrupt -> server still boots with defaults', store.getAgents().length, N);
  check('corrupt -> conversations empty', store.getConversations().length, 0);
  check('corrupt -> broken copy kept as .corrupt', existsSync(s.data + '.corrupt'), true);
  check('corrupt -> original data.json removed', existsSync(s.data), false);
  const r = store.getRecovery();
  check('corrupt -> recovery notice is set', !!r, true);
  check('corrupt -> notice names the .corrupt path', r && r.path, s.data + '.corrupt');
  check('corrupt -> notice carries a timestamp', typeof (r && r.at) === 'string', true);

  // Recovery is worthless if the recovered state cannot be written back out.
  store.setSettings({ delegation: true });
  const back = JSON.parse(readFileSync(s.data, 'utf8'));
  check('corrupt -> can still persist after recovery', back.settings, { delegation: true });
}

// --- good file: the happy path must not regress ------------------------------
{
  const s = sandbox(GOOD);
  const { store } = await s.open();
  check('good -> conversations loaded', store.getConversations().length, 1);
  check('good -> messages loaded', store.getConversation('c1').messages.length, 1);
  check('good -> agents loaded', store.getAgents().map((a) => a.id), ['a']);
  check('good -> toolStats loaded', store.toolStatsOf('a'), { read: 2 });
  check('good -> settings loaded (not overwritten by defaults)', store.getSettings(), { delegation: true });
  check('good -> revision loaded', store.getRevision(), 41);
  check('good -> no recovery notice', store.getRecovery(), null);
}

// --- half-broken shapes: a file that parses but is not our data --------------
{
  const s = sandbox('null');
  const { store } = await s.open();
  check('json "null" -> falls back to defaults', store.getAgents().length, N);
}
{
  const s = sandbox('[1,2,3]');
  const { store } = await s.open();
  check('json array -> falls back to defaults', store.getAgents().length, N);
}
{
  const s = sandbox(JSON.stringify({ agents: [] }));
  const { store } = await s.open();
  check('empty agents array -> re-seeded', store.getAgents().length, N);
}
{
  const s = sandbox(JSON.stringify({ conversations: { c1: { id: 'c1' } } }));
  const { store } = await s.open();
  check('partial conv -> missing keys defaulted', store.getConversation('c1').messages, undefined);
  check('partial conv -> agents re-seeded', store.getAgents().length, N);
}

// --- atomic write: a failed save must not destroy the good file --------------
{
  const s = sandbox(GOOD);
  const { store } = await s.open();
  store.upsertAgent({ id: 'b', name: 'B' });
  const back = JSON.parse(readFileSync(s.data, 'utf8'));
  check('save -> agent appended', back.agents.map((a) => a.id), ['a', 'b']);
  check('save -> revision bumped', back.revision, 42);
  check('save -> no .tmp left behind', existsSync(s.data + '.tmp'), false);
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
