// Zero-cost regression for the agent-agnostic "ask" contract.
// Proves the question-detection half works for BOTH adapter classes:
//   - detectAskFromModel: model-class agents (DeepSeek/Qwen/...) read plain text
//   - parseAsk:            DSH-class agents parse the structured ask tool
// Neither touches the network or the data file. Run from project root:
//   node scripts/test-ask.mjs
import { detectAskFromModel, parseAsk } from '../server/adapters.mjs';

let pass = 0;
let fail = 0;
function check(label, cond, extra = '') {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL  ' + label + (extra ? '  ' + extra : '')); }
}

// ---- model-class detection (B class: no ask tool, plain text) ----
const yes = detectAskFromModel('你更喜欢苹果还是西瓜？');
check('model: tail question -> ask', !!yes.ask && yes.ask.question.includes('苹果'), JSON.stringify(yes));
check('model: ask has no options (free-text answer)', yes.ask && Array.isArray(yes.ask.options) && yes.ask.options.length === 0);

const en = detectAskFromModel('Shall we continue?');
check('model: english tail "?" -> ask', !!en.ask);

const no = detectAskFromModel('这是一段正常的回复，没有提问。');
check('model: statement -> no ask', !no.ask);

const buried = detectAskFromModel('开头有个问题？但是结尾是陈述句，所以不算提问。');
check('model: question buried mid-text, statement tail -> no ask', !buried.ask);

const longTail = detectAskFromModel('x'.repeat(250) + '？');
check('model: over-long tail -> no ask (avoid noise)', !longTail.ask);

const empty = detectAskFromModel('');
check('model: empty -> no ask', !empty.ask);

// ---- DSH-class detection (A class: structured ask tool) ----
const good = parseAsk({
  name: 'ask_user_question',
  callId: 'c1',
  arguments: JSON.stringify({ questions: [{ question: '喜欢苹果还是西瓜？', options: [{ label: '苹果', description: '红的' }, { label: '西瓜' }] }] }),
});
check('dsh: question parsed', good.question === '喜欢苹果还是西瓜？', good.question);
check('dsh: options parsed', good.options.length === 2 && good.options[0].label === '苹果' && good.options[0].description === '红的');
check('dsh: callId passed', good.callId === 'c1');

const multi = parseAsk({ name: 'ask_user_question', callId: 'c2', arguments: JSON.stringify({ questions: [{ question: '第一问' }, { question: '第二问' }] }) });
check('dsh: multiple questions -> first wins', multi.question === '第一问');

const noOpts = parseAsk({ name: 'ask_user_question', callId: 'c3', arguments: JSON.stringify({ questions: [{ question: '纯文本问？' }] }) });
check('dsh: missing options -> []', Array.isArray(noOpts.options) && noOpts.options.length === 0);

const bad = parseAsk({ name: 'ask_user_question', callId: 'c4', arguments: 'not json' });
check('dsh: bad json -> safe default', bad.question && bad.options.length === 0 && bad.callId === 'c4');

// ---- the contract: both produce the SAME shape the core consumes ----
const shapeOk = (a) => a && typeof a.question === 'string' && Array.isArray(a.options) && 'callId' in a;
check('contract: model + dsh emit identical shape', shapeOk(yes.ask) && shapeOk(good));

console.log(`\nask contract: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
