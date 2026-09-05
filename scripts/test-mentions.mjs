// Regression test for @-mention routing. A wrong parse sends the turn to the
// wrong member - silent, and only noticed when the reply looks odd.
// Run: node scripts/test-mentions.mjs
import { parseMentions } from '../server/bus.mjs';

const AGENTS = [
  { id: 'beichen', name: 'WorkBuddy' },
  { id: 'dsh', name: 'DSH' },
  { id: 'invest', name: '投资研究' },
  { id: 'short', name: '投资' },   // deliberately shadows part of 投资研究
];
const MEMBERS = ['beichen', 'dsh', 'invest', 'short'];

let fail = 0;
// Order-insensitive: matching walks candidates longest-name-first, so which of
// two mentioned members lands first is an implementation detail. Both get routed.
const check = (label, got, want) => {
  const norm = (x) => JSON.stringify([...x].sort());
  const ok = norm(got) === norm(want);
  if (!ok) fail++;
  // got/want only on failure: printing 14 passing cases dumps ~30 lines of noise,
  // and the trailing "want []" reads like a failure at a glance.
  console.log(ok
    ? `PASS  ${label}`
    : `FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

check('by name',        parseMentions('@WorkBuddy 帮我看看', AGENTS, MEMBERS), ['beichen']);
check('by id',          parseMentions('@dsh 跑一下', AGENTS, MEMBERS), ['dsh']);
check('case-insensitive', parseMentions('@DSH 跑一下', AGENTS, MEMBERS), ['dsh']);
check('two mentions',   parseMentions('@WorkBuddy @DSH 开会', AGENTS, MEMBERS), ['beichen', 'dsh']);
check('deduped',        parseMentions('@WorkBuddy 和 @WorkBuddy', AGENTS, MEMBERS), ['beichen']);

// The whole reason for longest-first matching: "投资" must not eat "投资研究".
check('longest name wins', parseMentions('@投资研究 说说', AGENTS, MEMBERS), ['invest']);
check('short name still works', parseMentions('@投资 说说', AGENTS, MEMBERS), ['short']);

check('no mention -> broadcast', parseMentions('大家好', AGENTS, MEMBERS), []);
check('@ in email ignored', parseMentions('mail me at a@b.com', AGENTS, MEMBERS), []);
check('decorator ignored', parseMentions('@app.route("/x")', AGENTS, MEMBERS), []);
check('non-member ignored', parseMentions('@陌生人 你好', AGENTS, MEMBERS), []);

// A member outside this group must not be routed to.
check('outside member ignored', parseMentions('@WorkBuddy 在吗', AGENTS, ['dsh', 'invest']), []);
check('empty text', parseMentions('', AGENTS, MEMBERS), []);
check('null text', parseMentions(null, AGENTS, MEMBERS), []);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
