// TRUE-北辰 bridge skeleton (the real WorkBuddy "brain").
//
// This is the integration SEAM for wiring the actual WorkBuddy app into achat
// as a closed-source agent (transport: 'ui-auto' in config.launcher). Today
// WorkBuddy exposes no callable HTTP/RPC API and desktop-computer-use needs
// human --confirm, so true-北辰 automation is blocked until an endpoint exists.
//
// Until then this script fails CLEAN: it outputs a valid JSON result (so the
// monitor never crashes or hangs) explaining exactly what to set. The moment
// WorkBuddy exposes an API, set WORKBUDDY_BRIDGE_URL and this becomes live -
// no other code changes needed.
//
// Swap-in: in agents.mjs / data.json set beichen-bridge.config.launcher.
//   agentEntry: 'scripts/workbuddy-bridge.mjs'
//   transport:  'ui-auto'
// Pure ESM, ASCII only.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const taskPath = process.argv[2];
const artifactsDir = process.env.ACHAT_ARTIFACTS_DIR || join(process.cwd(), 'bridge', 'demo', 'artifacts');
mkdirSync(artifactsDir, { recursive: true });

function fail(msg) {
  process.stdout.write(JSON.stringify({ conclusion: '[workbuddy-bridge] ' + msg }));
  process.exit(0);
}

let task;
try { task = JSON.parse(readFileSync(taskPath, 'utf8')); }
catch { fail('无法读取任务文件'); }

const instruction = String(task.instruction || '');

// --- the only configuration this skeleton needs --------------------------
// Point this at the endpoint WorkBuddy will eventually expose (an HTTP/RPC
// that accepts { instruction } and returns the agent's reply + artifacts).
const bridgeUrl = process.env.WORKBUDDY_BRIDGE_URL || '';

if (!bridgeUrl) {
  // Clean, actionable failure. The monitor turns this into a normal reply in
  // the group - no crash, no hang, no orphaned inbox task.
  fail(
    '真身桥接尚未配置：请在环境变量 WORKBUDDY_BRIDGE_URL 中填入 WorkBuddy 暴露的 API/RPC 端点'
    + '（接受 { instruction } 并返回 { conclusion, artifacts }），或在 config.launcher 中指定。'
    + '当前 achat 的文件桥接传输层已跑通（见 demo-agent.mjs 真实验证），'
    + '只差 WorkBuddy 暴露一个可被程序调用的入口即可把"真北辰"接进来。',
  );
}

// --- live path (stub until the contract is finalised) ---------------------
// When the endpoint exists this is the only block that needs filling in:
//   POST bridgeUrl with { instruction, convId, artifactsDir }
//   poll/stream the run
//   write returned artifacts to artifactsDir
//   output { conclusion, artifacts:[{type,name,path}] }
(async () => {
  try {
    const res = await fetch(bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction,
        convId: process.env.ACHAT_CONV_ID || '',
        artifactsDir,
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const arts = (data.artifacts || []).map((a) => ({
      type: a.type || 'doc', name: a.name || (a.path ? a.path.split(/[\\/]/).pop() : 'artifact'), path: a.path || '',
    }));
    process.stdout.write(JSON.stringify({ conclusion: data.conclusion || '', artifacts: arts }));
    process.exit(0);
  } catch (e) {
    fail('调用 WorkBuddy 桥接端点失败：' + e.message);
  }
})();
