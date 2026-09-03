// Dumb bridge shuttle. Pure transport: poll inbox -> invoke the REAL agent
// (its own brain, no LLM here) -> write outbox -> file artifacts into the
// group space. achat owns this process lifecycle; the agent owns the thinking.
// Zero dependencies, zero token cost on achat's side. ASCII only.
import { spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';

const ROOT = process.cwd();
const ACHAT_URL = process.env.ACHAT_URL || 'http://127.0.0.1:8787';

function parseArgs(argv) {
  const a = { agent: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent') a.agent = argv[++i];
  }
  return a;
}
const { agent: AGENT_ID } = parseArgs(process.argv.slice(2));
if (!AGENT_ID) { console.error('bridge-monitor: missing --agent'); process.exit(1); }

const dataPath = join(ROOT, 'server', 'data.json');
const agents = JSON.parse(readFileSync(dataPath, 'utf8')).agents;
const agent = agents.find((x) => x.id === AGENT_ID);
if (!agent || !agent.config || !agent.config.launcher) {
  console.error(`bridge-monitor: agent ${AGENT_ID} has no launcher config`);
  process.exit(1);
}
const localDir = agent.config.localDir
  ? (isAbsolute(agent.config.localDir) ? agent.config.localDir : join(ROOT, agent.config.localDir))
  : join(ROOT, 'bridge', AGENT_ID);
const inboxDir = join(localDir, 'inbox');
const outboxDir = join(localDir, 'outbox');
const artifactsDir = join(localDir, 'artifacts');
const agentEntry = agent.config.launcher.agentEntry || 'scripts/demo-agent.mjs';
const pollMs = agent.config.pollMs || 1000;

mkdirSync(inboxDir, { recursive: true });
mkdirSync(outboxDir, { recursive: true });
mkdirSync(artifactsDir, { recursive: true });

const logPath = join(localDir, 'monitor.log');
function log(...a) { try { writeFileSync(logPath, `[${new Date().toISOString()}] ${a.join(' ')}\n`, { flag: 'a' }); } catch {} }
writeFileSync(join(localDir, 'monitor.pid'), String(process.pid));
log('started monitoring', AGENT_ID, '->', inboxDir);

function listTasks() {
  if (!existsSync(inboxDir)) return [];
  return readdirSync(inboxDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.processing'))
    .map((f) => join(inboxDir, f))
    .sort((a, b) => a.localeCompare(b));
}

function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

async function uploadArtifact(convId, art, agentId) {
  if (!convId || !art || !art.path || !existsSync(art.path)) return;
  try {
    const b64 = readFileSync(art.path).toString('base64');
    const res = await fetch(`${ACHAT_URL}/api/conversations/${convId}/space`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: art.name || art.path.split(/[\\/]/).pop(),
        kind: art.type || 'doc',
        ownerId: agentId,
        colorTag: agent.color || '#3b6fd4',
        content_base64: b64,
      }),
    });
    if (!res.ok) log('space upload failed', res.status);
  } catch (e) { log('space upload error', e.message); }
}

function processTask(taskPath) {
  const lock = taskPath + '.processing';
  if (existsSync(lock)) return;
  writeFileSync(lock, String(Date.now()));
  const taskId = taskPath.split(/[\\/]/).pop().replace('.json', '');
  const task = JSON.parse(readFileSync(taskPath, 'utf8'));
  log('>>> task', taskId, JSON.stringify((task.instruction || '').slice(0, 60)));

  const child = spawn(process.execPath, [join(ROOT, agentEntry), taskPath], {
    cwd: ROOT,
    env: { ...process.env, ACHAT_ARTIFACTS_DIR: artifactsDir, ACHAT_CONV_ID: String(task.convId || ''), ACHAT_AGENT_ID: AGENT_ID },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => log('  agent stderr:', d.toString().slice(0, 200)));
  child.on('close', async (code) => {
    let result = extractJson(out);
    if (!result) {
      result = { conclusion: `[bridge] agent 未返回有效结果（exit ${code}）` };
      log('  no json from agent, exit', code);
    }
    const outboxPath = join(outboxDir, `${taskId}.result.json`);
    writeFileSync(outboxPath, JSON.stringify({
      conclusion: result.conclusion || '',
      ask: result.ask || undefined,
      artifacts: (result.artifacts || []).map((x) => ({ type: x.type || 'doc', name: x.name || (x.path ? x.path.split(/[\\/]/).pop() : 'artifact'), path: x.path || '' })),
    }, null, 2));
    // File artifacts into the group space automatically (no human needed).
    for (const art of (result.artifacts || [])) await uploadArtifact(task.convId, art, AGENT_ID);
    // Let the BridgeAdapter read outbox, then clean the inbox task.
    rmSync(taskPath, { force: true });
    rmSync(lock, { force: true });
    log('<<< done', taskId);
  });
}

const timer = setInterval(() => {
  for (const t of listTasks()) processTask(t);
}, pollMs);

function shutdown() {
  clearInterval(timer);
  try { rmSync(join(localDir, 'monitor.pid'), { force: true }); } catch {}
  log('stopped');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
