// Regression for the offline light: does it actually mean offline?
//
// A model-backed agent used to report "up" whenever it merely held a key, so a
// revoked or over-quota key sat green forever and the traffic light lied. This
// proves the probe is real (garbage key -> offline), that it is cached (the 20s
// heartbeat must not become a paid round-trip), and that a dead DSH port is
// still detected.
//
// Cost: a few /models calls - no LLM tokens, no data touched.
// Run: node scripts/test-offline.mjs
import { ModelAdapter, DshAdapter } from '../server/adapters.mjs';
import { readFileSync, existsSync } from 'node:fs';

const log = (...a) => console.log(...a);
const light = (up) => (up ? 'GREEN (idle)' : 'DARK (offline)');
const timed = async (fn) => { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; };

// Optional: a real key is only needed to prove a working key stays green.
const KEY_FILE = 'C:/Users/wsx/.opencodereview/config.json';
let realKey = '';
try {
  if (existsSync(KEY_FILE)) realKey = JSON.parse(readFileSync(KEY_FILE, 'utf8')).llm.auth_token;
} catch { /* run without it; the real-key case is skipped below */ }
delete process.env.DEEPSEEK_API_KEY; // so the "no key" case is genuinely key-less

let fail = 0;
const check = (ok, msg) => { if (!ok) fail++; log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const skip = (msg) => log(`  SKIP  ${msg}`);

log('--- B class (model API) ---');

const garbage = new ModelAdapter({ id: 'b2', name: 'garbage', config: { apiKey: 'sk-this-key-is-garbage' } });
const noKey = new ModelAdapter({ id: 'b3', name: 'nokey', config: {} });

const g = await timed(() => garbage.ping());
log(`  garbage key    ping=${g.r} ${g.ms}ms  -> ${light(g.r)}`);
const n = await timed(() => noKey.ping());
log(`  no key         ping=${n.r} ${n.ms}ms  -> ${light(n.r)}`);

check(g.r === false, 'a garbage key shows OFFLINE (this is the bug that was fixed)');
check(n.r === false, 'no key shows offline');
check(n.ms < 20, 'a key-less agent short-circuits without any network call');

if (realKey) {
  const good = new ModelAdapter({ id: 'b1', name: 'good', config: { apiKey: realKey } });
  const first = await timed(() => good.ping());
  log(`  real key       ping=${first.r} ${first.ms}ms  -> ${light(first.r)}`);
  const second = await timed(() => good.ping());
  log(`  real key again ping=${second.r} ${second.ms}ms  (should be ~0ms)`);
  check(first.r === true, 'a working key shows green');
  // The whole point of the cache: an uncached probe turns the 20s heartbeat
  // into a paid round-trip every tick.
  check(second.ms < 20, 'repeat probe is cached, heartbeat stays free');
} else {
  skip('real key not available - set config.json to cover the green/cached path');
}

log('');
log('--- A class (DSH, local RPC) ---');
const dead = new DshAdapter({ id: 'd1', name: 'dead', config: { ports: [39999] } });
const d = await timed(() => dead.ping());
log(`  dead port      ping=${d.r} ${d.ms}ms  -> ${light(d.r)}`);
check(d.r === false, 'DSH on a dead port shows offline');

log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
