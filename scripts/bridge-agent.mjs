// bridge-agent.mjs - headless BeiChen executor for the C-class file bridge.
//
// This is the "external product" side of zjl-achat's Bridge Adapter. It runs as
// a standalone, always-on node process (NOT a GUI window, NOT a model mock):
//   1. poll  bridge/<agentId>/inbox  for tasks written by achat
//   2. run a real LLM tool-call loop (DeepSeek) that actually does the work
//      (pick a GitHub project, fetch live data, search the web, write a report)
//   3. write the conclusion + deliverables back to outbox, and file artifacts
//      into the originating group space via achat's API
//
// Because it is a daemon, achat messages reach BeiChen PASSIVELY - no human has
// to paste anything into any input box. That is what makes the hub fully
// automatic, not a copy-paste relay.
//
// Pure ESM, zero npm deps. ASCII only (Chinese is allowed inside strings sent
// to the model, never in identifiers/comments).

import {
  readdirSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const AGENT_ID = process.argv.includes('--agent')
  ? process.argv[process.argv.indexOf('--agent') + 1]
  : (process.env.BRIDGE_AGENT_ID || 'beichen-bridge');
const ACHAT = process.env.ACHAT_URL || 'http://127.0.0.1:8787';
const POLL_MS = +(process.env.POLL_MS || 1000);
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';

const BRIDGE_DIR = join(process.cwd(), 'bridge', AGENT_ID);
const INBOX = join(BRIDGE_DIR, 'inbox');
const OUTBOX = join(BRIDGE_DIR, 'outbox');
const ARTIFACTS = join(BRIDGE_DIR, 'artifacts');

// ---- load DeepSeek key (reuse the one already on this machine) ----
function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.opencodereview/config.json'), 'utf8'));
    return cfg.llm && cfg.llm.auth_token;
  } catch { return null; }
}
const KEY = loadKey();
if (!KEY) { console.error('[bridge-agent] no DeepSeek key found, abort'); process.exit(1); }

mkdirSync(INBOX, { recursive: true });
mkdirSync(OUTBOX, { recursive: true });
mkdirSync(ARTIFACTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tools the LLM can call. Each returns a short string fed back as a tool result.
// ---------------------------------------------------------------------------

async function ghSearch(q) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=5`;
  const res = await fetch(url, { headers: { 'User-Agent': 'zjl-achat-bridge', Accept: 'application/vnd.github+json' } });
  if (!res.ok) return `GitHub search failed (${res.status}). Try a different query.`;
  const j = await res.json();
  if (!j.items || !j.items.length) return 'No repositories found. Refine the query.';
  const lines = j.items.map((r, i) => {
    const topics = (r.topics || []).slice(0, 5).join(', ');
    return `${i + 1}. ${r.full_name} | stars:${r.stargazers_count} | lang:${r.language || '?'} | license:${r.license ? r.license.spdx_id : '?'} | ${r.description || ''}${topics ? ' | topics: ' + topics : ''}`;
  });
  return 'Top candidates:\n' + lines.join('\n');
}

async function ghRepo(fullName) {
  const res = await fetch(`https://api.github.com/repos/${fullName}`, { headers: { 'User-Agent': 'zjl-achat-bridge', Accept: 'application/vnd.github+json' } });
  if (!res.ok) return `Cannot fetch ${fullName} (${res.status}).`;
  const r = await res.json();
  const meta = {
    full_name: r.full_name, description: r.description, stars: r.stargazers_count,
    forks: r.forks_count, open_issues: r.open_issues_count, language: r.language,
    license: r.license ? r.license.spdx_id : null, created: r.created_at, pushed: r.pushed_at,
    topics: r.topics || [], homepage: r.homepage || '', default_branch: r.default_branch,
  };
  let readme = '';
  try {
    const rr = await fetch(`https://raw.githubusercontent.com/${fullName}/${meta.default_branch}/README.md`);
    if (rr.ok) readme = (await rr.text()).slice(0, 6000);
  } catch { /* ignore */ }
  return JSON.stringify(meta, null, 2) + '\n\nREADME (excerpt):\n' + readme;
}

async function webFetch(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'zjl-achat-bridge' }, redirect: 'follow' });
    if (!res.ok) return `Fetch failed (${res.status}) for ${url}`;
    const txt = await res.text();
    return txt.slice(0, 8000);
  } catch (e) { return `Fetch error: ${e.message}`; }
}

const writtenArtifacts = new Map(); // filename -> absolute path

function writeReport(filename, markdown) {
  const safe = String(filename).replace(/[\\/:*?"<>|]/g, '_');
  const path = join(ARTIFACTS, safe.endsWith('.md') ? safe : safe + '.md');
  writeFileSync(path, markdown, 'utf8');
  writtenArtifacts.set(safe, path);
  return `Report written to ${path}`;
}

// ---------------------------------------------------------------------------
// LLM tool-call loop
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'select_github_project',
      description: 'Search GitHub for repositories matching a topic/intent and return the top candidates. Call this first when the user wants a GitHub project analyzed.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'search keywords, e.g. "crypto trading bot python"' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_repo_details',
      description: 'Fetch full metadata + README for one GitHub repository by its full name (owner/repo).',
      parameters: { type: 'object', properties: { full_name: { type: 'string', description: 'e.g. freqtrade/freqtrade' } }, required: ['full_name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch the raw text content of any public URL (docs, articles, pages).',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_report',
      description: 'Write a Markdown deliverable (analysis report, summary, etc.) to disk. Call this to produce the final artifact.',
      parameters: { type: 'object', properties: { filename: { type: 'string', description: 'file name, .md appended if missing' }, markdown: { type: 'string', description: 'full Markdown content' } }, required: ['filename', 'markdown'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'End the task. Provide a concise summary and the file names of artifacts produced (written via write_report). Must be called last.',
      parameters: { type: 'object', properties: { summary: { type: 'string', description: 'concise conclusion shown in the group chat' }, artifact_names: { type: 'array', items: { type: 'string' }, description: 'file names produced, empty if none' } }, required: ['summary'] },
    },
  },
];

async function callLLM(messages) {
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function runTask(task) {
  writtenArtifacts.clear();
  const system = (task.role || '') +
    '\n\n你是北辰，一个能调用真实工具的智能体。请先理解用户任务，必要时调用工具收集真实数据，' +
    '生成高质量交付物（如分析报告），最后务必调用 finish 工具结束并给出总结。报告要有真实数据和明确结论，不要编造。';
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: task.instruction || '(empty instruction)' },
  ];

  let finishResult = null;
  for (let step = 0; step < 14; step++) {
    const data = await callLLM(messages);
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error('empty LLM response');

    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push(msg); // assistant message with tool_calls
      for (const tc of msg.tool_calls) {
        const fn = tc.function;
        let out;
        try {
          const args = JSON.parse(fn.arguments || '{}');
          if (fn.name === 'select_github_project') out = await ghSearch(args.query);
          else if (fn.name === 'fetch_repo_details') out = await ghRepo(args.full_name);
          else if (fn.name === 'web_fetch') out = await webFetch(args.url);
          else if (fn.name === 'write_report') out = writeReport(args.filename, args.markdown);
          else if (fn.name === 'finish') { finishResult = args; out = 'task finished'; }
          else out = `unknown tool ${fn.name}`;
        } catch (e) { out = `tool error: ${e.message}`; }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 9000) });
      }
      if (finishResult) break;
    } else {
      // Model answered without tools: treat as the summary.
      finishResult = { summary: msg.content || '(no summary)', artifact_names: [] };
      break;
    }
  }

  const summary = (finishResult && finishResult.summary) || '(task completed, no summary)';
  const names = (finishResult && finishResult.artifact_names) || [...writtenArtifacts.keys()];
  const artifacts = names.map((n) => {
    const path = writtenArtifacts.get(n) || join(ARTIFACTS, n.endsWith('.md') ? n : n + '.md');
    return { type: 'doc', name: n, path };
  });
  return { summary, artifacts };
}

// ---------------------------------------------------------------------------
// File the result back into achat
// ---------------------------------------------------------------------------

async function fileToGroup(task, result) {
  const convId = task.convId;
  if (!convId) { console.log('[bridge-agent] no convId, skip group-space upload'); return; }
  for (const a of result.artifacts) {
    try {
      const b64 = readFileSync(a.path, 'base64');
      const r = await fetch(`${ACHAT}/api/conversations/${convId}/space`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: a.name, kind: 'doc', ownerId: AGENT_ID, content_base64: b64 }),
      });
      console.log(`[bridge-agent] uploaded ${a.name} -> group ${convId} (${r.status})`);
    } catch (e) { console.error(`[bridge-agent] upload ${a.name} failed: ${e.message}`); }
  }
}

// ---------------------------------------------------------------------------
// Daemon loop
// ---------------------------------------------------------------------------

async function handleTask(taskId) {
  const taskPath = join(INBOX, `${taskId}.json`);
  const lockPath = join(INBOX, `${taskId}.processing`);
  if (!existsSync(taskPath)) { try { rmSync(lockPath, { force: true }); } catch {} return; }
  writeFileSync(lockPath, String(Date.now()));
  let task;
  try { task = JSON.parse(readFileSync(taskPath, 'utf8')); }
  catch { try { rmSync(lockPath, { force: true }); } catch {} return; }

  console.log(`[bridge-agent] >>> task ${taskId}: ${String(task.instruction || '').slice(0, 80)}`);
  try {
    const result = await runTask(task);
    writeFileSync(join(OUTBOX, `${taskId}.result.json`), JSON.stringify({
      schema: 'zjl-achat-bridge/1',
      conclusion: result.summary,
      artifacts: result.artifacts,
    }, null, 2), 'utf8');
    await fileToGroup(task, result);
    console.log(`[bridge-agent] <<< done ${taskId}: ${result.summary.slice(0, 80)}`);
  } catch (e) {
    console.error(`[bridge-agent] task ${taskId} error: ${e.message}`);
    writeFileSync(join(OUTBOX, `${taskId}.result.json`), JSON.stringify({
      schema: 'zjl-achat-bridge/1',
      conclusion: `[北辰] 执行出错：${e.message}`,
      artifacts: [],
    }, null, 2), 'utf8');
  } finally {
    try { rmSync(lockPath, { force: true }); } catch {}
  }
}

async function main() {
  console.log(`[bridge-agent] started for agent "${AGENT_ID}" | achat=${ACHAT} | poll=${POLL_MS}ms`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const files = readdirSync(INBOX).filter((f) => f.endsWith('.json') && !f.endsWith('.processing') && !f.endsWith('.cancel'));
      for (const f of files) {
        const taskId = f.slice(0, -5);
        const lock = join(INBOX, `${taskId}.processing`);
        if (existsSync(lock)) continue; // another worker / in-progress
        await handleTask(taskId);
      }
    } catch (e) { console.error('[bridge-agent] poll error:', e.message); }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error('[bridge-agent] fatal:', e); process.exit(1); });
