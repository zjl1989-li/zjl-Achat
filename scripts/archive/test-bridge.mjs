// Zero-cost regression for the C-class Bridge Adapter (file-bridge, §8.1①).
// No network, no token: a "fake product" watches inbox/ and writes back
// outbox/<taskId>.result.json, exactly like a real closed-source product
// (or a WorkBuddy sidecar) would. Covers: normal result + artifacts, ask
// card shape, abort mid-wait, timeout, and corrupted result tolerance.
//
// Run: node scripts/test-bridge.mjs
import { BridgeAdapter } from '../server/adapters.mjs';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}
function freshDir() {
  return mkdtempSync(join(os.tmpdir(), 'bridge-test-'));
}
function makeAgent(localDir, overrides = {}) {
  return {
    id: 'beichen-bridge',
    name: '北辰（桥接）',
    system: 'sys',
    config: { adapterType: 'C', localDir, pollMs: 50, maxWaitMs: 180000, ...overrides },
  };
}
// The fake product: poll inbox for a new task file, hand it to `produce`,
// and write the returned object/string back as outbox/<taskId>.result.json.
// `produce` may return an object (JSON-encoded) or a raw string (for the
// corrupted-file case).
function fakeProduct(localDir, produce, delayMs = 150) {
  return new Promise((resolve) => {
    const inbox = join(localDir, 'inbox');
    mkdirSync(inbox, { recursive: true });
    const timer = setInterval(() => {
      const files = readdirSync(inbox).filter((f) => f.endsWith('.json') && !f.endsWith('.cancel'));
      if (!files.length) return;
      clearInterval(timer);
      const taskId = files[0].replace('.json', '');
      const task = JSON.parse(readFileSync(join(inbox, files[0]), 'utf8'));
      const out = produce(task, localDir);
      mkdirSync(join(localDir, 'outbox'), { recursive: true });
      const body = typeof out === 'string' ? out : JSON.stringify(out);
      writeFileSync(join(localDir, 'outbox', `${taskId}.result.json`), body);
      resolve();
    }, 30);
    setTimeout(() => { clearInterval(timer); resolve(); }, delayMs + 3000);
  });
}

async function main() {
  console.log('BridgeAdapter regression (zero token):');

  // --- Case 1: normal result + artifacts ---
  {
    const dir = freshDir();
    const agent = makeAgent(dir);
    const adapter = new BridgeAdapter(agent);
    const product = fakeProduct(dir, () => ({
      conclusion: '分析完成：建议观望。',
      artifacts: [{ type: 'doc', name: 'report.md', path: join(dir, 'outbox', 'report.md') }],
    }));
    const res = await adapter.send({
      messages: [{ role: 'user', content: '帮我分析一下' }],
      peers: [], roster: ['北辰（桥接）（你）'],
    });
    await product;
    check('case1 text', res.text === '分析完成：建议观望。', `got=${JSON.stringify(res.text)}`);
    check('case1 artifacts', res.artifacts?.length === 1 && res.artifacts[0].type === 'doc' && res.artifacts[0].name === 'report.md', `got=${JSON.stringify(res.artifacts)}`);
    check('case1 no ask', res.ask === undefined, `got=${JSON.stringify(res.ask)}`);
    check('case1 cleaned', !existsSync(join(dir, 'inbox')) || readdirSync(join(dir, 'inbox')).filter((f) => f.endsWith('.json')).length === 0, 'inbox not cleaned');
    rmSync(dir, { recursive: true, force: true });
  }

  // --- Case 2: ask card shape ---
  {
    const dir = freshDir();
    const agent = makeAgent(dir);
    const adapter = new BridgeAdapter(agent);
    const product = fakeProduct(dir, () => ({
      conclusion: '',
      ask: { question: '你喜欢苹果还是西瓜？', options: [{ label: '苹果' }, { label: '西瓜' }] },
    }));
    const res = await adapter.send({ messages: [{ role: 'user', content: '选一个' }] });
    await product;
    check('case2 ask question', res.ask?.question === '你喜欢苹果还是西瓜？', `got=${JSON.stringify(res.ask)}`);
    check('case2 ask options', res.ask?.options?.length === 2 && res.ask.options[0].label === '苹果', `got=${JSON.stringify(res.ask?.options)}`);
    check('case2 empty text', res.text === '', `got=${JSON.stringify(res.text)}`);
    rmSync(dir, { recursive: true, force: true });
  }

  // --- Case 3: abort mid-wait ---
  {
    const dir = freshDir();
    const agent = makeAgent(dir);
    const adapter = new BridgeAdapter(agent);
    const ac = new AbortController();
    const p = adapter.send({ messages: [{ role: 'user', content: '长任务' }], signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    let threw = false;
    let name = '';
    try { await p; } catch (e) { threw = true; name = e.name; }
    check('case3 aborted', threw && name === 'AbortError', `threw=${threw} name=${name}`);
    check('case3 cleaned', !existsSync(join(dir, 'inbox')) || readdirSync(join(dir, 'inbox')).filter((f) => f.endsWith('.json') || f.endsWith('.cancel')).length === 0, 'leftover files');
    rmSync(dir, { recursive: true, force: true });
  }

  // --- Case 4: timeout (no product writes back) ---
  {
    const dir = freshDir();
    const agent = makeAgent(dir, { maxWaitMs: 400, pollMs: 50 });
    const adapter = new BridgeAdapter(agent);
    const res = await adapter.send({ messages: [{ role: 'user', content: '没人理我' }] });
    check('case4 timeout text', typeof res.text === 'string' && res.text.includes('超时'), `got=${JSON.stringify(res.text)}`);
    rmSync(dir, { recursive: true, force: true });
  }

  // --- Case 5: corrupted result tolerance ---
  {
    const dir = freshDir();
    const agent = makeAgent(dir);
    const adapter = new BridgeAdapter(agent);
    const product = fakeProduct(dir, () => '{ this is not valid json');
    const res = await adapter.send({ messages: [{ role: 'user', content: '坏文件' }] });
    await product;
    check('case5 corrupted fallback', res.text === '[bridge] result file corrupted', `got=${JSON.stringify(res.text)}`);
    rmSync(dir, { recursive: true, force: true });
  }

  // --- Case 6: context assembly ferried to the product ---
  {
    const dir = freshDir();
    const agent = makeAgent(dir);
    const adapter = new BridgeAdapter(agent);
    let seenTask = null;
    const product = fakeProduct(dir, (task) => { seenTask = task; return { conclusion: 'ok' }; });
    await adapter.send({
      messages: [{ role: 'user', content: '指令在这里' }],
      peers: ['DSH: 它说了啥'],
      roster: ['北辰（桥接）（你）', 'DSH'],
      answerTo: null,
    });
    await product;
    check('case6 instruction ferried', seenTask?.instruction === '指令在这里', `got=${JSON.stringify(seenTask?.instruction)}`);
    check('case6 peers ferried', Array.isArray(seenTask?.peers) && seenTask.peers[0] === 'DSH: 它说了啥', `got=${JSON.stringify(seenTask?.peers)}`);
    check('case6 roster ferried', Array.isArray(seenTask?.roster) && seenTask.roster.includes('DSH'), `got=${JSON.stringify(seenTask?.roster)}`);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('failed:', failures.join(', ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
