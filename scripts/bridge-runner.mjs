// Bridge runner: the external-product half of the C-class file-bridge (§8.1①).
// Polls bridge/<agentId>/inbox for tasks achat wrote, does the work (echo for
// a zero-cost demo, or a real LLM call), and writes back
// outbox/<taskId>.result.json so achat's BridgeAdapter can relay the
// conclusion + artifacts into the group.
//
// This is the reference loop a real product (北辰真身 / WorkBuddy sidecar /
// 豆包桌面) would replace with its own. It lives OUTSIDE achat's core - achat
// only writes inbox and reads outbox, per §8.
//
//   node scripts/bridge-runner.mjs [--agent beichen-bridge] [--mode echo|llm] [--poll 200]
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
const AGENT = arg('--agent', 'beichen-bridge');
const MODE = arg('--mode', 'echo'); // echo = zero-cost demo, llm = real DeepSeek call
const POLL = parseInt(arg('--poll', '200'), 10);
const BASE = join(process.cwd(), 'bridge', AGENT);
const INBOX = join(BASE, 'inbox');
const OUTBOX = join(BASE, 'outbox');
mkdirSync(INBOX, { recursive: true });
mkdirSync(OUTBOX, { recursive: true });

console.log(`[bridge-runner] agent=${AGENT} mode=${MODE} watch=${BASE}`);

async function llmReply(task) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return '[bridge llm] no DEEPSEEK_API_KEY, fallback to echo';
  const sys = task.role || '你是助手。';
  const body = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: task.instruction || '' },
    ],
    stream: false,
  };
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '[bridge llm] empty response';
  } catch (e) {
    return `[bridge llm] error: ${e.message}`;
  }
}

async function handle(taskPath) {
  const taskId = taskPath.split(/[\\/]/).pop().replace('.json', '');
  let task;
  try { task = JSON.parse(readFileSync(taskPath, 'utf8')); }
  catch { rmSync(taskPath, { force: true }); return; }
  console.log(`[bridge-runner] task ${taskId}: ${(task.instruction || '').slice(0, 60)}`);
  const conclusion = MODE === 'llm' ? await llmReply(task) : `[桥接回显] ${task.instruction}`;
  writeFileSync(join(OUTBOX, `${taskId}.result.json`), JSON.stringify({ conclusion, artifacts: [] }, null, 2));
  rmSync(taskPath, { force: true });
  console.log(`[bridge-runner] wrote result for ${taskId}`);
}

async function loop() {
  const files = existsSync(INBOX)
    ? readdirSync(INBOX).filter((f) => f.endsWith('.json') && !f.endsWith('.cancel'))
    : [];
  for (const f of files) await handle(join(INBOX, f));
}

setInterval(loop, POLL);
loop();
