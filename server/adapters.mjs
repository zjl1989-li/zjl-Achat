// Adapter layer: one interface, three implementations.
//   B class -> ModelAdapter:  OpenAI-compatible chat API (DeepSeek, Qwen, ...)
//   A class -> DshAdapter:    DSH Typert RPC (real agent: tools + skills)
//   C class -> BridgeAdapter: file-bridge for closed-source products (§8.1①)
// Node built-ins (node:fs/node:path) only - still zero EXTERNAL dependencies.
import { join, isAbsolute } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import http from 'node:http';
import { execSync, spawn } from 'node:child_process';

// Pure ESM, zero dependencies, ASCII only.

// Codex desktop app keeps its binary at bin/<hash>/codex.exe and ROTATES the
// hash dir on every update, so the path must be resolved fresh per spawn,
// never cached. Returns '' when the app is not installed.
export function resolveCodexCli() {
  const base = join(homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
  let best = '', bestM = 0;
  try {
    for (const e of readdirSync(base)) {
      const exe = join(base, e, 'codex.exe');
      try {
        const m = statSync(exe).mtimeMs;
        if (m > bestM) { bestM = m; best = exe; }
      } catch { /* dir without codex.exe */ }
    }
  } catch { /* no bin dir */ }
  return best;
}

// ---------- shared helpers ----------
function readEnvKey(name) {
  return process.env[name] || '';
}

// Liveness-probe tuning for B class (model APIs); see ModelAdapter.ping().
const PROBE_TTL_OK_MS = 5 * 60 * 1000;  // a healthy key stays trusted this long
const PROBE_TTL_FAIL_MS = 30 * 1000;    // a failure is retried much sooner
const PROBE_TIMEOUT_MS = 4000;          // never let a probe stall the heartbeat

// ---------- B class: OpenAI-compatible model API ----------
// Used by DeepSeek / Qwen / Doubao / GLM / Kimi ... switch via baseURL + key.
export class ModelAdapter {
  constructor(agent) {
    this.agent = agent;
    this.type = 'B';
    const cfg = agent.config || {};
    // apiBaseUrl is kept as a legacy alias so old records survive; the UI now writes baseURL.
    this.baseURL = cfg.baseURL || cfg.apiBaseUrl || 'https://api.deepseek.com/v1';
    // Same rule as probeAdapterType: the UI-edited top-level field wins.
    this.model = agent.model || cfg.model || 'deepseek-chat';
    this.key = cfg.apiKey || readEnvKey(cfg.apiKeyEnv) || readEnvKey('DEEPSEEK_API_KEY');
  }

  meta() {
    return {
      adapterType: 'B',
      hasNativeSession: false, // bare API, no app session to mirror
      capabilities: ['chat'],
    };
  }

  // Checking the key only proves it was configured, not that it works: a revoked
  // or over-quota key would sit there green forever, which makes the offline
  // light a lie for every model-backed agent. Probe for real instead.
  //
  // Cached, because the heartbeat runs every 20s and a round-trip per tick is
  // not worth it. A failure is re-checked much sooner than a success, so a
  // network blip clears in half a minute instead of five.
  async ping() {
    if (!this.key) return false;
    const ttl = this.probeOk ? PROBE_TTL_OK_MS : PROBE_TTL_FAIL_MS;
    if (this.probeAt && Date.now() - this.probeAt < ttl) return this.probeOk;
    this.probeAt = Date.now();
    this.probeOk = await this.reachable();
    return this.probeOk;
  }

  // /models is the cheapest endpoint that still demands a valid key - it answers
  // 401 for a revoked one, separating "configured" from "actually usable".
  async reachable() {
    try {
      const res = await fetch(`${this.baseURL}/models`, {
        headers: { Authorization: `Bearer ${this.key}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false; // network down, DNS failure, timeout - all mean unreachable
    }
  }

  async send({ messages, onDelta, signal, roster, allowDelegate, answerTo }) {
    if (!this.key) return { text: `[${this.agent.name}] 未配置 API Key，无法调用模型。` };

    // An answer must carry the question it answers: a bare "watermelon" in the
    // next turn is a non-sequitur to a stateless model. Fold it into the final
    // user message so the model knows what it is replying to. This is the
    // model-class half of the ask contract; DSH does the same by re-prompting.
    const msgs = answerTo
      ? messages.map((m, i) => i === messages.length - 1
        ? { ...m, content: `${m.content}\n\n[你刚才问用户的问题]\n${answerTo.question}\n[用户的回答]\n${lastUserText([m])}\n请基于这个回答继续执行原来的任务。` }
        : m)
      : messages;
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: systemText(this.agent.system, roster, allowDelegate) }, ...msgs],
      stream: !!onDelta,
      temperature: 0.7,
    };
    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Throw, do not return an error string: returning makes dispatch take its
      // success path, so the agent reports idle (green) right after a failure and
      // the error state becomes unreachable for every model-backed agent.
      // The message omits "调用失败" because dispatch prefixes it with the same.
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 120)}`);
    }

    if (!onDelta) {
      const data = await res.json();
      return detectAskFromModel(data.choices?.[0]?.message?.content || '(empty)');
    }
    return detectAskFromModel((await readSseDelta(res, onDelta)).text);
  }
}

// Model-class half of the adapter "ask" contract (the A-class half is
// parseAsk, which reads DSH's structured ask tool). A model has no ask tool,
// so a question is just text ending in a question mark. Only the tail is
// judged: a question mark buried in 500 words of prose is not a question card,
// but a closing "shall I continue?" is exactly one. A false positive only makes
// a message answerable, which costs nothing. Returned {ask} is the same shape
// DSH produces, so the core routes and renders both identically.
export function detectAskFromModel(text) {
  const t = String(text || '').trim();
  const tail = (t.split('\n').filter(Boolean).pop() || '').trim();
  // Tail-anchored: a question mark buried mid-sentence is NOT a question card,
  // only a genuine trailing "?" is (that is the intent above). A plain .test()
  // would fire on any embedded question mark and mis-flag prose like
  // "there is a question? but the sentence ends as a statement".
  if (!tail || tail.length > 200 || !/[?？]$/.test(tail)) return { text: t };
  return { text: t, ask: { question: tail, options: [], callId: '' } };
}

// How to summon a peer. Only injected when delegation is switched on - teaching
// the gesture to an agent whose @ will be ignored just makes it look stupid.
// The "when NOT to" half is the important half: without it a chatty model turns
// every reply into a group conference, and each ping is another paid turn.
export const DELEGATION_RULE =
  `你可以点名其他成员：回复里写 @他的名字（例如 @北辰），他会在你之后接着回答。` +
  `但以下情况不要点名——你自己就能回答的、只是顺带提到某人的、闲聊或确认类的。` +
  `每次点名都会多花一轮，只在真的需要他的专业能力时才用，一条回复最多点名一个人。`;

// Peer speech arrives as "[群内其他成员的发言]" background blocks. Say so, or
// the model copies the block's speaker tags into its own replies.
function systemText(system, roster, allowDelegate) {
  const parts = [system || ''];
  if (roster && roster.length) {
    parts.push(`你在群聊里，当前成员：${roster.join('、')}。其他成员的发言会作为「[群内其他成员的发言]」背景提供给你，那不是你说过的话，不要复述、不要模仿、也不要带名字前缀，直接回答用户的问题。`);
  }
  if (allowDelegate) parts.push(DELEGATION_RULE);
  return parts.filter(Boolean).join('\n\n');
}

// Parse OpenAI-style SSE stream, forward text deltas, return full text.
async function readSseDelta(res, onDelta) {
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') return { text };
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) { text += delta; onDelta(delta); }
      } catch { /* partial frame, skip */ }
    }
  }
  return { text };
}

// ---------- A class: DSH Typert RPC ----------
// Wire (verified 2026-08-31 against DSH 2.0.2, port 3080):
//   POST /api/<method>  body { type:'client-request', rpcId, method, payload }
//   resp { type:'server-response', rpcId, result:{ ok, value|error } }
// Events (session.history -> { events:[{event:{type,seq,time,data}}] }):
//   assistant/chunk  data.chunk.type='text-delta' -> data.chunk.text  (streaming)
//   assistant/message data.message.content[].text                     (final)
//   turn/end         data.reason.kind='completed'                     (done signal)
const DSH_PORTS = [3080, 43120];

export class DshAdapter {
  constructor(agent) {
    this.agent = agent;
    this.type = 'A';
    const cfg = agent.config || {};
    this.ports = cfg.ports || DSH_PORTS;
    this.cwd = cfg.cwd || process.cwd();
    this.baseURL = null;      // resolved lazily on first call
    this.sessionId = null;    // native session mirror id
    this.contextLost = false; // set when a cached session turns out to be dead
    this.maxWaitMs = cfg.maxWaitMs || 180000;
  }

  meta() {
    return {
      adapterType: 'A',
      hasNativeSession: true, // DSH exposes real sessions we can mirror
      capabilities: ['chat', 'code', 'fileIO', 'mcp'],
    };
  }

  // Port probe only. Lifecycle (launch/stop) is owned by the generic launcher
  // switch in server.mjs (/agents/:id/launch), driven by config.launcher.enabled.
  // This adapter never spawns - it just attaches to a DSH that is already up.
  async attach() {
    for (const port of this.ports) {
      const base = `http://127.0.0.1:${port}`;
      try {
        const res = await fetch(`${base}/api/session.list`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: `probe-${Date.now()}`, method: 'session.list', payload: {} }),
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) { this.baseURL = base; return base; }
      } catch { /* port closed, try next */ }
    }
    return null;
  }

  // Reuse a resolved port when possible, otherwise scan again.
  async ping() {
    if (this.baseURL && await this.rpc('session.list', {}, null, 2000).then(() => true).catch(() => false)) {
      return true;
    }
    this.baseURL = null;
    return !!(await this.attach());
  }

  async rpc(method, payload = {}, signal = null, timeoutMs = 0) {
    if (!this.baseURL && !(await this.attach())) {
      throw new Error(`DSH 未运行（已探测端口 ${this.ports.join(', ')}）`);
    }
    const res = await fetch(`${this.baseURL}/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `achat-${Date.now()}`, method, payload }),
      signal: signal || (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined),
    });
    const json = await res.json().catch(() => null);
    if (!json || json.result?.ok === false) {
      const err = json?.result?.error;
      const e = new Error(`${method} 失败: ${err ? err.code + ' ' + err.message : 'bad response'}`);
      e.code = err?.code || 'bad_response';   // callers branch on this, e.g. session-not-found
      throw e;
    }
    return json.result?.value;
  }

  // A DSH restart keeps the port - and every other RPC - green, so ping() stays
  // happy while the session we cached is long gone. Verify before relying on it:
  // otherwise session.prompt fails and we sit there burning maxWaitMs.
  async ensureSession(signal) {
    if (this.sessionId) {
      try {
        await this.rpc('session.history', { sessionId: this.sessionId, maxMessages: 1 }, signal, 3000);
        return this.sessionId;
      } catch (e) {
        if (e.code !== 'session-not-found') throw e;  // real failure, don't mask it
        this.sessionId = null;
        this.contextLost = true;                      // next turn starts with no history
      }
    }
    const created = await this.rpc('session.create', { cwd: this.cwd }, signal);
    this.sessionId = created.sessionId;
    return this.sessionId;
  }

  // Highest seq currently in the session. Used as the baseline so a *previous*
  // turn's turn/end can never be mistaken for this turn finishing.
  async currentSeq(signal) {
    try {
      const h = await this.rpc('session.history', { sessionId: await this.ensureSession(signal), maxMessages: 200 }, signal);
      return (h.events || []).reduce((m, e) => Math.max(m, e.event?.seq ?? -1), -1);
    } catch {
      return -1;
    }
  }

  // Real cancel (verified 2026-08-31): DSH stops the running turn server-side.
  // Without this, aborting only stopped us waiting while DSH kept working.
  cancel() {
    if (!this.sessionId) return;
    this.rpc('session.cancel', { sessionId: this.sessionId }).catch(() => {});
  }

  async send({ messages, signal, onEvent, peers, roster, allowDelegate, answerTo }) {
    const sessionId = await this.ensureSession(signal);
    const contextLost = this.contextLost;
    this.contextLost = false;    // report the loss once, on the turn that hits it
    const baseSeq = await this.currentSeq(signal);
    const text = lastUserText(messages);

    // session.prompt takes a single block, so what the agent cannot already see
    // has to be folded into the text: its persona (never sent before) and what
    // the other members said (its session only ever held its own turns).
    const blocks = [];
    if (this.agent.system) blocks.push(`[你的角色]\n${this.agent.system}`);
    if (roster && roster.length) blocks.push(`[群成员]\n${roster.join('、')}`);
    if (allowDelegate) blocks.push(`[点名规则]\n${DELEGATION_RULE}`);
    if (peers && peers.length) blocks.push(`[群内其他成员的发言]\n${peers.join('\n')}`);
    // An answer has to carry the question with it: this is a brand new turn from
    // DSH's point of view, and without the question the answer looks like a
    // non-sequitur ("watermelon" to an agent that has forgotten it asked).
    if (answerTo) {
      blocks.push(`[你刚才问用户的问题]\n${answerTo.question}`);
      blocks.push(`[用户的回答]\n${text}`);
      blocks.push(`请基于这个回答继续执行原来的任务。`);
    } else {
      blocks.push(`[用户对你说的话]\n${text}`);
    }

    await this.rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: blocks.join('\n\n') }],
    }, signal);

    // Poll history until turn/end (DSH prompt returns only {accepted:true}).
    const started = Date.now();
    let cursor = baseSeq;
    let ask = null;
    while (Date.now() - started < this.maxWaitMs) {
      if (signal?.aborted) throw abortError();
      await sleep(1000, signal);
      if (signal?.aborted) throw abortError();
      const hist = await this.rpc('session.history', { sessionId, maxMessages: 200 }, signal);
      const events = (hist.events || []).map((e) => e.event);
      const fresh = events.filter((e) => (e.seq ?? -1) > cursor);
      for (const ev of fresh) {
        cursor = Math.max(cursor, ev.seq ?? -1);
        // The ask tool never finishes on its own, so cut the turn loose the
        // moment it appears. Waiting would burn the whole maxWaitMs and still
        // leave the session running forever afterwards.
        if (!ask && ev.type === 'tool/call' && ev.data?.name === ASK_TOOL) {
          ask = parseAsk(ev.data);
          if (onEvent) onEvent({ kind: 'ask', ...ask });
          this.cancel();
          continue;   // not a normal tool event - the caller turns it into a card
        }
        const mapped = mapDshEvent(ev);
        if (mapped && onEvent) onEvent(mapped);
      }
      if (ask && fresh.some((e) => e.type === 'turn/end')) {
        return { text: ask.question, nativeSessionId: sessionId, contextLost, ask };
      }
      if (fresh.some((e) => e.type === 'turn/end')) {
        const final = [...events].reverse().find((e) => e.type === 'assistant/message' && (e.seq ?? -1) > baseSeq);
        const parts = final?.data?.message?.content || [];
        const reply = parts.map((p) => (p.type === 'text' ? p.text : '')).join('').trim();
        return {
          text: reply || '(DSH returned no text)',
          nativeSessionId: sessionId,
          contextLost,
          usage: final?.data?.usage,
        };
      }
    }
    // Timed out, but if a question landed we still owe it to the user: showing
    // it beats a timeout message, and the answer can still drive a fresh turn.
    if (ask) return { text: ask.question, nativeSessionId: sessionId, contextLost, ask };
    return { text: `[${this.agent.name}] DSH 响应超时（${this.maxWaitMs / 1000}s）`, nativeSessionId: sessionId };
  }
}

// DSH's ask_user_question tool hangs the turn indefinitely and nothing in the
// HTTP RPC layer can answer it (17 candidate method names all 404; a prompt sent
// while hung is only queued, never delivered - both verified 2026-08-31). The
// answer therefore has to arrive as a fresh turn: cancel the hung one, show the
// question, re-prompt with the answer folded in. DSH closes a cancelled turn
// itself (emits its own tool/result then turn/end), so the next turn never trips
// over an unanswered tool call.
const ASK_TOOL = 'ask_user_question';

// A-class half of the adapter "ask" contract (the model-class half is
// detectAskFromModel). Parses DSH's structured ask tool into the same {question,
// options, callId} shape the core expects, so both agents route identically.
// questions[] is a list; M1 shows the first one and keeps the rest as context.
export function parseAsk(d) {
  let qs = [];
  try { qs = JSON.parse(d.arguments || '{}').questions || []; } catch { qs = []; }
  const first = qs[0] || {};
  return {
    question: String(first.question || first.header || 'Agent 想问你一个问题'),
    options: (first.options || []).map((o) => ({
      label: String(o.label || ''),
      description: String(o.description || ''),
    })),
    callId: String(d.callId || ''),
  };
}

// DSH native events -> achat intermediate events (the "event" half of
// CodexHost's event|interaction split). Approval events are NOT exposed by
// DSH (policy "ask" auto-resolves), so interaction stays unimplemented.
function mapDshEvent(ev) {
  const d = ev.data || {};
  if (ev.type === 'tool/call') {
    let args = {};
    try { args = JSON.parse(d.arguments || '{}'); } catch { args = {}; }
    const detail = args.command || args.file_path || args.path || args.pattern || args.description || JSON.stringify(args);
    return { kind: 'tool_call', name: d.name || 'tool', callId: d.callId, detail: String(detail).slice(0, 160) };
  }
  if (ev.type === 'tool/result') {
    const blocks = d.message?.content || [];
    let out = '';
    for (const b of blocks) for (const p of (b.content || [])) if (p.type === 'text') out += p.text;
    return { kind: 'tool_result', callId: d.message?.source?.callId, detail: out.trim().slice(0, 200) };
  }
  if (ev.type === 'step/start') return { kind: 'step', step: d.step };
  return null;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  });
}

// ---------- C class: Bridge Adapter (file-bridge, §8.1①) ----------
// achat drives, external product is "dumb" (web/app/file): achat writes
// inbox/<taskId>.json, the product reads it, does the work, writes
// outbox/<taskId>.result.json (+ artifacts on disk), achat polls & relays.
// Fidelity L1.5 (§6.1): context assembly is achat's job, the bridge only
// ferries text + artifacts. No network, no token, no app session to mirror.
export class BridgeAdapter {
  constructor(agent) {
    this.agent = agent;
    this.type = 'C';
    const cfg = agent.config || {};
    this.baseDir = cfg.localDir
      ? (isAbsolute(cfg.localDir) ? cfg.localDir : join(process.cwd(), cfg.localDir))
      : join(process.cwd(), 'bridge', agent.id);
    this.pollMs = cfg.pollMs || 1000;
    this.maxWaitMs = cfg.maxWaitMs || 180000;
    this.curTaskId = null; // set during send, used by cancel()
  }

  meta() {
    return {
      adapterType: 'C',
      hasNativeSession: false, // external product has no app session to mirror
      capabilities: ['chat'],
    };
  }

  // Cheap liveness: the bridge dirs must exist and be writable. No network,
  // no token - a missing/unwritable dir is the only thing that can be wrong here.
  async ping() {
    try {
      mkdirSync(this.inbox(), { recursive: true });
      mkdirSync(this.outbox(), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  inbox() { return join(this.baseDir, 'inbox'); }
  outbox() { return join(this.baseDir, 'outbox'); }
  taskPath(id) { return join(this.inbox(), `${id}.json`); }
  resultPath(id) { return join(this.outbox(), `${id}.result.json`); }
  cancelPath(id) { return join(this.inbox(), `${id}.cancel`); }

  // The payload the external product consumes. achat owns context assembly
  // (role/roster/peers/answerTo); the bridge ferries it verbatim.
  buildTask({ messages, peers, roster, answerTo, convId }) {
    return {
      schema: 'zjl-achat-bridge/1',
      agentId: this.agent.id,
      instruction: lastUserText(messages),
      role: this.agent.system || '',
      roster: roster || [],
      peers: peers || [],
      answerTo: answerTo || null, // { question } when this turn answers a prior ask
      convId: convId || null, // group the task came from, so the external product can file artifacts back
      createdAt: Date.now(),
    };
  }

  async send({ messages, peers, roster, answerTo, signal, onEvent, convId }) {
    await this.ping(); // ensure inbox/outbox exist
    const taskId = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.curTaskId = taskId;
    writeFileSync(this.taskPath(taskId), JSON.stringify(this.buildTask({ messages, peers, roster, answerTo, convId }), null, 2));
    if (onEvent) onEvent({ kind: 'step', step: 'bridge: waiting for external product result' });

    const started = Date.now();
    try {
      while (Date.now() - started < this.maxWaitMs) {
        // Either branch throws; finally() owns cleanup, so a signal-rejected
        // sleep (which throws before we reach the in-loop checks) cannot leak
        // the inbox/outbox files behind.
        if (signal?.aborted) throw abortError();
        // /abort routes here via cancel() writing a cancel flag file.
        if (existsSync(this.cancelPath(taskId))) throw abortError();
        if (existsSync(this.resultPath(taskId))) {
          let result;
          try { result = JSON.parse(readFileSync(this.resultPath(taskId), 'utf8')); }
          catch { result = { conclusion: '[bridge] result file corrupted' }; }
          return {
            text: result.conclusion || '',
            ask: result.ask
              ? {
                  question: String(result.ask.question || result.ask),
                  options: (result.ask.options || []).map((o) => ({
                    label: String(o.label || o),
                    description: String(o.description || ''),
                  })),
                  callId: '',
                }
              : undefined,
            artifacts: (result.artifacts || []).map((a) => ({
              type: a.type || 'other',
              name: a.name || (a.path ? String(a.path).split(/[\\/]/).pop() : 'artifact'),
              path: a.path || '',
            })),
          };
        }
        await sleep(this.pollMs, signal);
      }
      return { text: `[${this.agent.name}] 文件桥等待超时（${this.maxWaitMs / 1000}s），外部产品未回写结果` };
    } finally {
      this.cleanup(taskId);
    }
  }

  // Cancel: drop the pending task and flag cancellation for any external watcher.
  cancel() {
    if (this.curTaskId) {
      try { writeFileSync(this.cancelPath(this.curTaskId), String(Date.now())); } catch { /* ignore */ }
    }
  }

  cleanup(taskId) {
    for (const p of [this.taskPath(taskId), this.cancelPath(taskId), this.resultPath(taskId)]) {
      try { rmSync(p, { force: true }); } catch { /* ignore */ }
    }
    if (this.curTaskId === taskId) this.curTaskId = null;
  }
}

// ---------- W class: WorkBuddy ACP bridge (closed-source product, §8.1④) ----------
// Drives the REAL WorkBuddy desktop app through its "Remote Control" ACP
// service (Agent Client Protocol). Verified 2026-09-01 end-to-end: achat sent
// "PONG" and real WorkBuddy streamed back exactly "PONG" (stopReason=end_turn).
//
// This is the §8.1④ "protocol bridge" that was assumed LOCKED ("消费级基本不
// 开放 🔒") - it is in fact OPEN. So it is a 4th adapter class, not the C
// file-bridge: C ferries files, this speaks ACP over HTTP/SSE and discovers its
// own port. It still belongs to the C-class CLOSED-SOURCE BRIDGE family: achat
// owns context assembly, WorkBuddy just answers (fidelity L1.5).
//
// Port is DYNAMIC (assigned at WorkBuddy startup) -> discovered by scanning
// local LISTENING ports for the "Remote Control" / "codebuddy" service title.
// Auth is NOT a blocker: /api/v1/acp/connect returns a connectionId we reuse;
// no pre-shared secret needed. One connection+session per turn keeps it simple
// (achat refolds context each turn, so no cross-turn WorkBuddy memory is needed).

// Parse SSE "data: {...}\n" lines -> array of JSON objects (tolerant of partial
// frames, same shape the probe used).
function parseSse(body) {
  const out = [];
  for (const line of String(body || '').split('\n')) {
    const t = line.trim();
    if (t.startsWith('data:')) {
      const j = t.slice(5).trim();
      if (j) { try { out.push(JSON.parse(j)); } catch { /* partial */ } }
    } else if (t.startsWith('{')) {
      try { out.push(JSON.parse(t)); } catch { /* partial */ }
    }
  }
  return out;
}

export class WbAcpAdapter {
  constructor(agent) {
    this.agent = agent;
    this.type = 'W';
    const cfg = agent.config || {};
    this.host = cfg.host || '127.0.0.1';
    this.port = cfg.port || 0;          // 0 = auto-discover on first use
    this.cwd = cfg.cwd || '.';
    this.maxWaitMs = cfg.maxWaitMs || 180000;
    this._activeReq = null;            // current HTTP request, for cancel()
  }

  meta() {
    return {
      adapterType: 'W',
      hasNativeSession: true, // ACP has sessions, but we spin a fresh one per turn
      capabilities: ['chat'],  // closed-source product: achat only gets the text back
    };
  }

  // Cheap liveness for the heartbeat: cached port first, rediscover only on death.
  async ping() {
    try {
      if (this.port && await this._tcpAlive(this.port)) return true;
      const p = await this.discoverPort();
      if (!p) return false;
      this.port = p;
      return await this._tcpAlive(p);
    } catch {
      return false;
    }
  }

  // Scan local LISTENING ports and locate the ACP service.
  // Primary signal: a port that ACTUALLY answers ACP connect (definitive proof
  // it speaks ACP - a title scan alone can miss a differently-titled port).
  // Fallback: the classic "Remote Control" / "codebuddy" title the service used
  // to expose. Returns the port or null (service not running).
  async discoverPort() {
    let out = '';
    try { out = execSync('netstat -ano', { encoding: 'utf8' }); } catch { return null; }
    const ports = [];
    for (const line of out.split('\n')) {
      const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m) ports.push(Number(m[1]));
    }
    for (const port of ports) {
      const c = await this._probeConnect(port);
      if (c) { this.port = port; return port; }
    }
    for (const port of ports) {
      const html = this._getTitle(port);
      if (html.includes('Remote Control') || html.toLowerCase().includes('codebuddy')) {
        this.port = port;
        return port;
      }
    }
    return null;
  }

  // POST /api/v1/acp/connect on a specific port; return {connectionId,...} if it
  // really speaks ACP, else null. Used by discoverPort and as a liveness probe.
  _probeConnect(port) {
    return this._acpRequest('/api/v1/acp/connect', {}, {}, { port, maxWaitMs: 1500 })
      .then((r) => {
        if (r.status < 200 || r.status >= 300) return null;
        try { const j = JSON.parse(r.body); return j.connectionId ? j : null; } catch { return null; }
      })
      .catch(() => null);
  }

  _getTitle(port) {
    return new Promise((resolve) => {
      const req = http.get(
        { host: this.host, port, path: '/', timeout: 800 },
        (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); },
      );
      req.on('error', () => resolve(''));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(''); });
    });
  }

  _tcpAlive(port) {
    return new Promise((resolve) => {
      const req = http.get(
        { host: this.host, port, path: '/', timeout: 1000 },
        (res) => { res.resume(); res.on('end', () => resolve(true)); },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(false); });
    });
  }

  // One ACP HTTP call. In SSE mode resolves as soon as doneWhen(events) is true
  // OR after maxWaitMs (best-effort, never hangs). signal abort rejects cleanly.
  _acpRequest(path, headers, bodyObj, opts = {}) {
    const sse = !!opts.sse;
    const doneWhen = opts.doneWhen || null;
    const signal = opts.signal || null;
    const maxWaitMs = opts.maxWaitMs || 120000;
    const port = opts.port || this.port;
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(bodyObj);
      let settled = false;
      let buf = '';
      let timer = null;
      const finish = (status, hdrs, body) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this._activeReq = null;
        resolve({ status, headers: hdrs, body });
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { req.destroy(); } catch { /* ignore */ }
        reject(abortError());
      };
      const req = http.request(
        {
          host: this.host, port, path, method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Content-Length': Buffer.byteLength(data),
          },
        },
        (res) => {
          if (!sse) {
            let b = '';
            res.on('data', (c) => (b += c));
            res.on('end', () => finish(res.statusCode, res.headers, b));
            return;
          }
          res.on('data', (c) => {
            buf += c;
            if (doneWhen && doneWhen(parseSse(buf))) finish(res.statusCode, res.headers, buf);
          });
          res.on('end', () => finish(res.statusCode, res.headers, buf));
        },
      );
      this._activeReq = req;
      req.on('error', (e) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); reject(e); } });
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      req.write(data);
      req.end();
      timer = setTimeout(() => finish(0, {}, buf), maxWaitMs);
    });
  }

  cancel() {
    if (this._activeReq) {
      try { this._activeReq.destroy(); } catch { /* ignore */ }
      this._activeReq = null;
    }
  }

  // guardrail() is defined at module scope and shared with WbCliKeyAdapter.

  async send({ messages, peers, roster, answerTo, signal, onEvent, allowDelegate }) {
    // 1) locate the service (cached port skips the scan)
    if (!this.port || !(await this._tcpAlive(this.port))) {
      const p = await this.discoverPort();
      if (!p) return { text: `[${this.agent.name}] 未找到 WorkBuddy Remote Control 服务（WorkBuddy 是否在运行？）` };
      this.port = p;
    }

    // 2) connect -> connectionId (no pre-shared token needed)
    const conn = await this._acpRequest('/api/v1/acp/connect', {}, {});
    let cj;
    try { cj = JSON.parse(conn.body); } catch { cj = parseSse(conn.body).find((e) => e.connectionId) || {}; }
    const connectionId = cj.connectionId;
    const sessionToken = cj.sessionToken;
    if (!connectionId) return { text: `[${this.agent.name}] ACP connect 失败（HTTP ${conn.status}）` };
    const H = { 'acp-connection-id': connectionId };
    if (sessionToken) H['acp-session-token'] = sessionToken;

    // 3) initialize (jsonrpc handshake; mirrors the verified probe)
    await this._acpRequest('/api/v1/acp', H, {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: {
        protocolVersion: 1,
        clientInfo: { name: 'achat-bridge', version: '1.0.0' },
        clientCapabilities: { _meta: { 'codebuddy.ai': { question: true, promptSuggestion: true, terminalOutput: true } } },
      },
    });

    // 4) session/new -> sessionId
    const sn = await this._acpRequest('/api/v1/acp', H, {
      jsonrpc: '2.0', id: 1, method: 'session/new',
      params: { cwd: this.cwd, mcpServers: [] },
    });
    const snEvents = parseSse(sn.body);
    const sessionId = (snEvents.find((e) => e.result && e.result.sessionId) || {}).result?.sessionId
      || snEvents.find((e) => e.sessionId)?.sessionId;
    if (!sessionId) return { text: `[${this.agent.name}] ACP session/new 失败（HTTP ${sn.status}）` };

    // 5) assemble context (achat owns it; WorkBuddy sees only this turn)
    const blocks = [];
    if (this.agent.system) blocks.push(`[你的角色]\n${this.agent.system}`);
    if (roster && roster.length) blocks.push(`[群成员]\n${roster.join('、')}`);
    if (allowDelegate) blocks.push(`[点名规则]\n${DELEGATION_RULE}`);
    if (peers && peers.length) blocks.push(`[群内其他成员的发言]\n${peers.join('\n')}`);
    if (answerTo) {
      blocks.push(`[你刚才问用户的问题]\n${answerTo.question}`);
      blocks.push(`[用户的回答]\n${lastUserText(messages)}`);
      blocks.push('请基于这个回答继续执行原来的任务。');
    } else {
      blocks.push(`[用户对你说的话]\n${lastUserText(messages)}`);
    }
    const prompt = blocks.join('\n\n');

    // 5.5) guardrail: block high-risk instructions BEFORE they reach WorkBuddy.
    // WorkBuddy runs in bypassPermissions (no approval dialogs), so this is the
    // only safety gate. The guard only inspects the USER's own instruction; the
    // system/role text we inject is ours and never blocked.
    const userText = lastUserText(messages) || '';
    const guard = guardrail(userText);
    if (!guard.allowed) {
      if (onEvent) onEvent({ kind: 'step', step: '已拦截：' + guard.reason });
      return {
        text: `[${this.agent.name}] 指令被护栏拦截，未转发给 WorkBuddy 真身。\n\n原因：${guard.reason}\n\n（WorkBuddy 当前为免审批模式，敏感操作不弹确认。护栏在 achat 侧兜底拦截高危指令。）`,
      };
    }

    if (onEvent) onEvent({ kind: 'step', step: 'WorkBuddy 处理中…' });

    // 6) session/prompt -> stream SSE until result.stopReason
    const sp = await this._acpRequest('/api/v1/acp', H, {
      jsonrpc: '2.0', id: 2, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: prompt }] },
    }, {
      sse: true,
      doneWhen: (evs) => evs.some((e) => e.result && e.result.stopReason),
      signal,
      maxWaitMs: this.maxWaitMs,
    });
    if (signal && signal.aborted) throw abortError();

    const evs = parseSse(sp.body);
    let text = '';
    let usage = null;
    for (const e of evs) {
      const u = e.params && e.params.update;
      if (u && u.sessionUpdate === 'agent_message_chunk' && u.content && typeof u.content.text === 'string') {
        text += u.content.text;
      } else if (u && u.sessionUpdate === 'usage_update') {
        usage = u.usage || usage;
      }
    }
    const stopReason = evs[evs.length - 1]?.result?.stopReason;
    return {
      text: text || `[${this.agent.name}] 未收到文本回复（stopReason=${stopReason || 'unknown'}）`,
      nativeSessionId: sessionId,
      usage,
    };
  }
}

// ---------- W-class safety guardrail (shared by RC + cli-key paths) ----------
// Inspects the USER's instruction and blocks high-risk requests before they
// reach WorkBuddy. Pattern-driven; mirrors WorkBuddy's forbidden_programs
// blacklist plus file-destructive / exfiltration patterns.
function guardrail(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return { allowed: true };

  // 1) destructive file operations that are never justified from a chat group
  const destructive = [
    /\brm\s+-rf\b/, /\brm\s+-r\b/, /\brmdir\s+\/?s\b/, /\bdel\s+\/f\b/,
    /\bformat\s+[a-z]:/, /\bdiskpart\b/, /\bremove-item\s+-recurse\b/,
    /\bshred\b/, /\bwipe\b/, /清空(整个)?(硬盘|磁盘|分区)/, /格式化(硬盘|磁盘|分区)/,
    /删除(整个)?(项目|仓库|目录)(?!内文件)/,
  ];
  for (const re of destructive) if (re.test(t)) {
    return { allowed: false, reason: `检测到破坏性文件操作（${re.source}），可能删除/格式化数据，已拦截。` };
  }

  // 2) system command blacklist (mirrors WorkBuddy forbidden_programs + more)
  const systemCmds = [
    /\bwsl(\.exe)?\b/, /\bwslconfig\.exe\b/, /\bwmic\b/, /\bsc\.exe\b/,
    /\breg\.exe\b/, /\bschtasks\.exe\b/, /\breg\s+(add|delete|query)\b/,
    /\bformat\s+\/?[a-z]:/, /\bgpupdate\b/, /\bbcdedit\b/, /\bdiskpart\b/,
    /\bnet\s+(user|localgroup|share)\b/, /\bwhoami\s*\/\s*priv\b/,
    /\bicacls\b/, /\battrib\s+[+-]s\b/, /\bsysteminfo\s*\/\s*s\b/,
  ];
  for (const re of systemCmds) if (re.test(t)) {
    return { allowed: false, reason: `检测到系统级命令（${re.source}），可能修改系统配置，已拦截。` };
  }

  // 3) network exfiltration / tunneling from the group (data leaves the box)
  const exfil = [
    /\bcurl\b/, /\bwget\b/, /\bnc\.exe\b/, /\bnetcat\b/, /\bssh\b/, /\bscp\b/,
    /\bftp\b/, /\btelegram\b/, /\bngrok\b/, /\bcloudflared\b/,
    /(上传|发送).{0,20}(token|密钥|密码|私钥|api[_ ]?key)/,
    /(泄露|外发|上传).{0,20}(文件|数据|资料)/,
  ];
  for (const re of exfil) if (re.test(t)) {
    return { allowed: false, reason: `检测到网络外联/数据外发意图（${re.source}），已拦截。` };
  }

  // 4) reading secrets that should never be surfaced into a chat group
  const secretPaths = [
    /\.env/, /\.env\.[\w.]+/, /id_rsa/, /id_ed25519/, /\.pem\b/, /\.pfx\b/, /\.p12\b/,
    /credentials?\.json/, /\.aws\//, /\.ssh\//, /secrets?\./, /token\.json/,
    /api[_-]?key[^/]*\.(json|txt|env)/, /\.npmrc\b/, /password[^/]*\.(json|txt)/,
  ];
  for (const re of secretPaths) if (re.test(t)) {
    return { allowed: false, reason: `检测到敏感凭据文件访问（${re.source}），不允许在群里读取，已拦截。` };
  }

  return { allowed: true };
}

// ---------- W class (cli-key variant): CodeBuddy CLI + official API Key ----------
// 2026-09-02: CodeBuddy ships an official API Key (CODEBUDDY_API_KEY) that
// authenticates the CLI (@tencent-ai/codebuddy-code) for MODEL calls. Unlike
// the RC-service path (WbAcpAdapter, needs the desktop app + a dynamic port),
// this spawns the CLI headless (-p / --print, --output-format json) and reads
// the reply from stdout. No desktop app, no dynamic port, stable long-lived key,
// and billing is separated from the desktop account quota (mitigates the 429).
// achat itself may be launched from inside the WorkBuddy desktop app, which injects
// session env (CODEBUDDY_SERVICE_PROXY_URL / GATEWAY_* / MCP_CONFIG / SESSION_ID ...).
// If the CLI child inherits those it believes it is desktop-hosted and tries to LISTEN
// on the port already held by the desktop app -> EADDRINUSE -> unhandled rejection ->
// the child hangs forever emitting nothing. So pass a minimal allowlisted env instead
// of process.env. Verified 2026-09-02: with a clean env the same call returns in ~3s.
const CLI_ENV_KEEP = [
  'PATH', 'Path', 'PATHEXT', 'ComSpec', 'SystemRoot', 'SYSTEMROOT', 'windir', 'OS',
  'TEMP', 'TMP', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'USERNAME',
  'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'PROGRAMDATA', 'ProgramFiles',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG',
];

export function cliEnv(apiKey, internetEnv) {
  const env = {};
  for (const k of CLI_ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.CODEBUDDY_API_KEY = apiKey;
  if (internetEnv) env.CODEBUDDY_INTERNET_ENVIRONMENT = internetEnv;
  env.CODEBUDDY_SKIP_GIT_BASH_CHECK = '1';
  return env;
}

export class WbCliKeyAdapter {
  constructor(agent) {
    this.agent = agent;
    this.type = 'W';
    const cfg = agent.config || {};
    const localApp = process.env.LOCALAPPDATA || '';
    this.cliPath = cfg.cliPath
      || readEnvKey('CODEBUDDY_CLI_PATH')
      || (localApp ? join(localApp, 'Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy') : '');
    this.apiKey = cfg.apiKey || readEnvKey('CODEBUDDY_API_KEY');
    this.model = cfg.model || 'deepseek-v4-flash';
    this.internetEnv = cfg.internetEnv || (process.env.CODEBUDDY_INTERNET_ENVIRONMENT || '');
    // Working dir for the CLI's file tools; '.' means "wherever achat runs".
    this.cwd = cfg.cwd && cfg.cwd !== '.' ? cfg.cwd : process.cwd();
    this.maxWaitMs = cfg.maxWaitMs || 180000;
    this._activeChild = null;
  }

  meta() {
    return { adapterType: 'W', hasNativeSession: false, capabilities: ['chat'] };
  }

  // Liveness: key present AND cli binary exists.
  async ping() {
    if (!this.apiKey) return false;
    try { return existsSync(this.cliPath); } catch { return false; }
  }

  cancel() {
    if (this._activeChild) { try { this._activeChild.kill('SIGTERM'); } catch {} this._activeChild = null; }
  }

  async send({ messages, peers, roster, answerTo, signal, onEvent, allowDelegate }) {
    if (!this.apiKey) return { text: `[${this.agent.name}] 未配置 CODEBUDDY_API_KEY（cli-key 通路需要 API Key）` };
    if (!existsSync(this.cliPath)) return { text: `[${this.agent.name}] 找不到 CodeBuddy CLI：${this.cliPath}` };

    const userText = lastUserText(messages) || '';
    const guard = guardrail(userText);
    if (!guard.allowed) {
      if (onEvent) onEvent({ kind: 'step', step: '已拦截：' + guard.reason });
      return { text: `[${this.agent.name}] 指令被护栏拦截，未转发。\n\n原因：${guard.reason}` };
    }

    // achat owns context; the CLI sees only this turn.
    const blocks = [];
    if (this.agent.system) blocks.push(`[你的角色]\n${this.agent.system}`);
    if (roster && roster.length) blocks.push(`[群成员]\n${roster.join('、')}`);
    if (allowDelegate) blocks.push(`[点名规则]\n${DELEGATION_RULE}`);
    if (peers && peers.length) blocks.push(`[群内其他成员的发言]\n${peers.join('\n')}`);
    if (answerTo) {
      blocks.push(`[你刚才问用户的问题]\n${answerTo.question}`);
      blocks.push(`[用户的回答]\n${userText}`);
      blocks.push('请基于这个回答继续执行原来的任务。');
    } else {
      blocks.push(`[用户对你说的话]\n${userText}`);
    }
    const prompt = blocks.join('\n\n');

    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--model', this.model,
      '--permission-mode', 'bypassPermissions',
      '--no-session-persistence',
    ];
    const env = cliEnv(this.apiKey, this.internetEnv);

    if (onEvent) onEvent({ kind: 'step', step: 'CodeBuddy CLI 处理中…' });

    let stdout = '';
    try {
      stdout = await new Promise((resolve, reject) => {
        // The CLI is a node shebang script with no .cmd wrapper — spawning it
        // directly fails on Windows. Always run it through our own node.
        // stdin must be closed: print mode otherwise waits on it and never exits.
        const child = spawn(process.execPath, [this.cliPath, ...args], {
          env, cwd: this.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        this._activeChild = child;
        let out = '', err = '';
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (err += c));
        let killed = false;
        const onAbort = () => { killed = true; try { child.kill('SIGTERM'); } catch {} reject(abortError()); };
        if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
        child.on('error', (e) => reject(e));
        child.on('close', (code) => {
          this._activeChild = null;
          if (killed) return; // abortError already rejected
          if (code !== 0 && !out) reject(new Error(`codebuddy exited ${code}: ${err.slice(0, 400)}`));
          else resolve(out);
        });
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('codebuddy timed out')); }, this.maxWaitMs);
        child.on('close', () => clearTimeout(timer));
      });
    } catch (e) {
      if (signal && signal.aborted) throw abortError();
      return { text: `[${this.agent.name}] CLI 调用失败：${String(e.message || e).slice(0, 300)}` };
    }

    const r = extractCliReply(stdout);
    if (r.isError) return { text: `[${this.agent.name}] CLI 报错：${r.text.slice(0, 300)}` };
    return { text: r.text || `[${this.agent.name}] CLI 未返回文本`, usage: r.usage };
  }
}

// Parse `codebuddy -p --output-format json` stdout -> { text, usage, isError }.
// Live shape (verified 2026-09-02): stdout is a JSON ARRAY of events; the reply
// sits in the trailing `{ type:'result', subtype:'success', result:'<text>',
// usage:{...} }`. A bare object / plain text is still tolerated.
export function extractCliReply(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return { text: '', usage: null, isError: false };
  let j;
  try { j = JSON.parse(s); } catch { return { text: s, usage: null, isError: false }; }
  if (typeof j === 'string') return { text: j, usage: null, isError: false };
  const node = Array.isArray(j)
    ? ([...j].reverse().find((e) => e && e.type === 'result') || {})
    : j;
  const raw = node.result ?? node.text ?? node.message ?? node.content ?? '';
  const text = typeof raw === 'string' ? raw : (raw && raw.text) || '';
  return { text, usage: node.usage || null, isError: !!node.is_error };
}

// ---------- E class: MCP Adapter (Model Context Protocol, §6.3 + M5) ----------
// Connects to any MCP server (stdio spawn or HTTP streamable) as a chat seat.
// MCP is a JSON-RPC capability protocol (tools/resources/prompts), not a "chat"
// API, so we route the user's message by calling a chat-like tool the server
// exposes (auto-detected from the name, or pinned via config.mcp.tool). The
// server's TEXT reply is relayed verbatim as the agent's message. Fidelity is
// L1.5-ish: achat owns context assembly, the MCP tool receives one text arg.
//
// cfg.mcp = { command, args?, env? }            -> stdio transport
// cfg.mcp = { url }                             -> HTTP/SSE streamable transport
// cfg.mcp.tool (optional) pins which tool is the "chat" tool.
// cfg.mcpServer is accepted as an alias of cfg.mcp.

// Minimal MCP JSON-RPC client over stdio or HTTP. One connection per call:
// initialize -> notifications/initialized -> tools/list -> tools/call -> close.
// Keeps process/transport lifetime inside the call so there is nothing to leak
// across turns (achat refolds context each turn anyway).
class McpClient {
  constructor(mcp) {
    this.mcp = mcp;
    this.transport = mcp.url ? 'http' : 'stdio';
    this.nextId = 1;
    this._pending = new Map();
    this._child = null;
    this._sessionId = null;
    this._buf = '';
  }

  async start() {
    if (this.transport === 'stdio') this._startStdio();
  }

  _startStdio() {
    const { command, args = [], env } = this.mcp;
    if (!command) throw new Error('MCP stdio 缺少 command');
    this._child = spawn(command, args, {
      env: { ...process.env, ...(env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this._child.stderr.on('data', () => {}); // server stderr is not our concern
    this._child.stdout.on('data', (c) => this._onStdout(c));
    this._child.on('exit', () => this._rejectAll(new Error('MCP process exited')));
  }

  _onStdout(chunk) {
    this._buf += chunk.toString();
    let i;
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i).trim();
      this._buf = this._buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code || ''} ${msg.error.message || ''}`.trim()));
      else resolve(msg.result);
    }
  }

  async request(method, params, timeoutMs = 30000) {
    if (this.transport === 'stdio') return this._requestStdio(method, params, timeoutMs);
    return this._requestHttp(method, params, timeoutMs);
  }

  _requestStdio(method, params, timeoutMs) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
    const timer = setTimeout(() => {
      if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(`MCP request timeout: ${method}`)); }
    }, timeoutMs);
    p.finally(() => clearTimeout(timer));
    this._child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  }

  async _requestHttp(method, params, timeoutMs) {
    const id = this.nextId++;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this._sessionId) headers['Mcp-Session-Id'] = this._sessionId;
    const res = await fetch(this.mcp.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) this._sessionId = sid;
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (ct.includes('text/event-stream')) {
      const evs = parseSse(text);
      const m = evs.find((e) => e.id === id);
      if (m && m.error) throw new Error(`${m.error.code || ''} ${m.error.message || ''}`.trim());
      if (m) return m.result;
      const last = evs[evs.length - 1];
      if (last && last.result) return last.result;
      return undefined;
    }
    let j; try { j = JSON.parse(text); } catch { throw new Error('MCP bad response: ' + text.slice(0, 120)); }
    if (j.error) throw new Error(`${j.error.code || ''} ${j.error.message || ''}`.trim());
    return j.result;
  }

  async notify(method, params) {
    if (this.transport === 'stdio') {
      this._child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
      return;
    }
    try {
      await fetch(this.mcp.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': this._sessionId || '' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* notifications are best-effort */ }
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'zjl-achat', version: '1.0.0' },
    });
    await this.notify('notifications/initialized', {});
  }

  async close() {
    if (this._child) { try { this._child.kill(); } catch { /* ignore */ } }
    this._rejectAll(new Error('MCP client closed'));
  }

  _rejectAll(err) {
    for (const { reject } of this._pending.values()) reject(err);
    this._pending.clear();
  }
}

function extractMcpText(call) {
  const content = call?.content || [];
  let out = '';
  for (const p of content) {
    if (p.type === 'text') out += p.text || '';
    else if (p.type === 'resource' && p.resource?.text) out += p.resource.text;
    else if (p.type === 'resource' && p.resource?.uri) out += String(p.resource.uri);
    else if (typeof p === 'string') out += p;
  }
  return out.trim();
}

export class McpAdapter {
  constructor(agent) {
    this.agent = agent;
    this.type = 'E';
    const cfg = agent.config || {};
    this.mcp = cfg.mcp || cfg.mcpServer || {};
    this.maxWaitMs = cfg.maxWaitMs || 120000;
    this.tool = this.mcp.tool || null; // explicit chat tool name
  }

  meta() {
    return { adapterType: 'E', hasNativeSession: false, capabilities: ['chat', 'mcp'] };
  }

  // Liveness: a real MCP handshake (initialize + tools/list) succeeds.
  async ping() {
    const c = new McpClient(this.mcp);
    try {
      await c.start();
      await c.initialize();
      await c.request('tools/list', {}, 8000);
      return true;
    } catch {
      return false;
    } finally {
      await c.close().catch(() => {});
    }
  }

  async send({ messages, signal, onEvent, convId }) {
    const text = lastUserText(messages);
    const c = new McpClient(this.mcp);
    try {
      await c.start();
      await c.initialize();
      if (onEvent) onEvent({ kind: 'step', step: 'MCP: 已连接，拉取工具列表…' });
      const list = await c.request('tools/list', {}, this.maxWaitMs);
      const tools = list?.tools || [];
      if (!tools.length) return { text: `[${this.agent.name}] MCP server 未暴露任何工具，无法作为对话席位` };
      const toolName = this._pickTool(tools);
      if (!toolName) {
        return {
          text: `[${this.agent.name}] MCP 暴露了 ${tools.length} 个工具但无法识别聊天工具；请在 config.mcp.tool 指定。候选：${tools.map((t) => t.name).join(', ')}`,
        };
      }
      if (onEvent) onEvent({ kind: 'step', step: 'MCP: 调用工具 ' + toolName });
      const tool = tools.find((t) => t.name === toolName);
      const args = this._buildArgs(tool, text);
      const call = await c.request('tools/call', { name: toolName, arguments: args }, this.maxWaitMs);
      const out = extractMcpText(call);
      return { text: out || `[${this.agent.name}] 工具 ${toolName} 未返回文本内容` };
    } finally {
      await c.close().catch(() => {});
    }
  }

  _pickTool(tools) {
    if (this.tool && tools.some((t) => t.name === this.tool)) return this.tool;
    const hint = /chat|complete|ask|generate|respond|run|invoke|answer|talk|query|agent/i;
    const hit = tools.find((t) => hint.test(t.name));
    if (hit) return hit.name;
    if (tools.length === 1) return tools[0].name;
    return null;
  }

  _buildArgs(tool, text) {
    const schema = (tool.inputSchema && tool.inputSchema.properties) || {};
    const keys = Object.keys(schema);
    const textKeys = ['message', 'input', 'prompt', 'query', 'text', 'content', 'instruction', 'user_input', 'question', 'user_message'];
    const args = {};
    for (const k of textKeys) {
      if (schema[k] && schema[k].type === 'string') { args[k] = text; return args; }
    }
    const firstStr = keys.find((k) => schema[k].type === 'string');
    if (firstStr) args[firstStr] = text;
    return args;
  }
}

// ---------- F class: Protocol Adapter (A2A / AG-UI, §6.3 + M5) ----------
// For agents that speak an open agent-to-agent protocol rather than a chat API:
//   cfg.a2a  -> A2A (Google Agent-to-Agent): discover Agent Card at
//               /.well-known/agent.json, then JSON-RPC tasks/send, read back
//               status.message + artifacts text parts.
//   cfg.agui -> AG-UI: POST a run payload, consume SSE, capture TEXT_MESSAGE_CONTENT.
//   cfg.protocolEndpoint / cfg.url -> generic: POST {message|text}, read JSON or SSE text.
// All three are "send a message, get text back" — achat owns context assembly.
export class ProtocolAdapter {
  constructor(agent) {
    this.agent = agent;
    this.type = 'F';
    const cfg = agent.config || {};
    this.a2a = cfg.a2a || null;
    this.agui = cfg.agui || null;
    this.endpoint = cfg.protocolEndpoint || cfg.url || null;
    this.maxWaitMs = cfg.maxWaitMs || 120000;
  }

  meta() {
    return { adapterType: 'F', hasNativeSession: false, capabilities: ['chat'] };
  }

  async ping() {
    try {
      if (this.a2a) {
        const r = await fetch(`${this.a2a.replace(/\/$/, '')}/.well-known/agent.json`, { signal: AbortSignal.timeout(3000) });
        return r.ok;
      }
      if (this.agui) {
        const r = await fetch(this.agui, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
        return r.status < 500;
      }
      if (this.endpoint) {
        const r = await fetch(this.endpoint, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
        return r.status < 500;
      }
      return false;
    } catch {
      return false;
    }
  }

  async send({ messages, signal, onEvent }) {
    const text = lastUserText(messages);
    if (this.a2a) return this._sendA2A(text, { onEvent, signal });
    if (this.agui) return this._sendAgui(text, { onEvent, signal });
    if (this.endpoint) return this._sendGeneric(text, { onEvent, signal });
    return { text: `[${this.agent.name}] F 类缺少 endpoint（config.a2a / config.agui / config.protocolEndpoint）` };
  }

  async _sendA2A(text, { onEvent, signal }) {
    let url = this.a2a;
    try {
      const card = await fetch(`${this.a2a.replace(/\/$/, '')}/.well-known/agent.json`, { signal: AbortSignal.timeout(5000) });
      if (card.ok) { const j = await card.json().catch(() => null); if (j && j.url) url = j.url; }
    } catch { /* fall back to base url */ }
    const taskId = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (onEvent) onEvent({ kind: 'step', step: 'A2A: tasks/send…' });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tasks/send',
        params: { id: taskId, message: { role: 'user', parts: [{ type: 'text', text }] } },
      }),
      signal: signal || AbortSignal.timeout(this.maxWaitMs),
    });
    const j = await res.json().catch(() => ({}));
    const result = j.result || {};
    const parts = [];
    for (const p of (result.status?.message?.parts || [])) if (p.type === 'text' && p.text) parts.push(p.text);
    for (const art of (result.artifacts || [])) for (const p of (art.parts || [])) if (p.type === 'text' && p.text) parts.push(p.text);
    const out = parts.join('\n').trim();
    return { text: out || `[${this.agent.name}] A2A 无文本回复（state=${result.status?.state || 'unknown'}）` };
  }

  async _sendAgui(text, { onEvent, signal }) {
    if (onEvent) onEvent({ kind: 'step', step: 'AG-UI: 启动 run…' });
    const runId = 'run_' + Date.now().toString(36);
    const threadId = 'thread_' + (this.agent.id || 'x');
    const res = await fetch(this.agui, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
      body: JSON.stringify({ threadId, runId, messages: [{ role: 'user', content: text }] }),
      signal: signal || AbortSignal.timeout(this.maxWaitMs),
    });
    const ct = res.headers.get('content-type') || '';
    let out = '';
    if (ct.includes('text/event-stream')) {
      const body = await res.text();
      for (const e of parseSse(body)) {
        if (e.type === 'TEXT_MESSAGE_CONTENT' && typeof e.text === 'string') out += e.text;
        else if (typeof e.text === 'string') out += e.text;
        else if (e.data && typeof e.data.text === 'string') out += e.data.text;
      }
    } else {
      const j = await res.json().catch(() => ({}));
      const v = j.text || j.reply || j.message;
      out = typeof v === 'string' ? v : '';
    }
    return { text: out.trim() || `[${this.agent.name}] AG-UI 未返回文本` };
  }

  async _sendGeneric(text, { onEvent, signal }) {
    if (onEvent) onEvent({ kind: 'step', step: 'protocol: POST…' });
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, text, input: text, role: 'user' }),
      signal: signal || AbortSignal.timeout(this.maxWaitMs),
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      const body = await res.text();
      let out = '';
      for (const e of parseSse(body)) {
        if (typeof e.text === 'string') out += e.text;
        if (e.data && typeof e.data.text === 'string') out += e.data.text;
      }
      return { text: out.trim() || `[${this.agent.name}] 协议端点未返回文本` };
    }
    const j = await res.json().catch(() => ({}));
    const v = j.reply || j.text || j.message || j.content || (typeof j === 'string' ? j : '');
    return { text: (typeof v === 'string' ? v : '').trim() || `[${this.agent.name}] 协议端点未返回文本` };
  }
}

// ---------- D class: Desktop GUI Adapter (Launch + File, M5 收尾) ----------
// A local desktop binary achat LAUNCHES (headless/hidden, via the generic
// launcher: config.launcher.service) and TALKS TO over a file bridge (same
// inbox/outbox as C). The only difference from C is provenance: C is a cloud
// product we can only hold an account for (we never launch it), D is a binary
// ON THIS MACHINE whose lifecycle achat owns. The wire format is identical, so
// D reuses BridgeAdapter's file-bridge and merely wears a different type label.
// describeProbe routes binaryPath / launcher.service -> D; the launcher (M2)
// then starts/stops the binary, D's send() bridges the conversation.
export class DesktopGuiAdapter extends BridgeAdapter {
  constructor(agent) {
    super(agent);
    this.type = 'D';
  }
  meta() {
    return { adapterType: 'D', hasNativeSession: false, capabilities: ['chat'] };
  }
}

// ---------- capability probe (§6.3, minimal M1 subset) ----------
// ---------- G class: generic local CLI agent ----------
// Spawn a local command-line AI agent once per turn, feed it a constructed
// prompt and relay its stdout as the reply. Works for terminal agents that
// take a prompt as a trailing arg, or via a {prompt} placeholder in cliArgs.
//   cfg.cliCmd  : executable (PATH name or absolute path)  [required]
//   cfg.cliArgs : extra args; use {prompt} to place the prompt  [optional]
//   cfg.cwd     : working directory (defaults to process.cwd())
export class CliAdapter {
  constructor(agent) {
    this.agent = agent;
    this.type = 'G';
    const cfg = agent.config || {};
    this.cliCmd = cfg.cliCmd || '';
    this.cliArgs = Array.isArray(cfg.cliArgs)
      ? cfg.cliArgs.map(String)
      : String(cfg.cliArgs || '').trim() ? String(cfg.cliArgs).trim().split(/\s+/) : [];
    this.cwd = cfg.cwd && cfg.cwd !== '.' ? cfg.cwd : process.cwd();
    this.maxWaitMs = cfg.timeoutMs || cfg.maxWaitMs || 180000;
    // e.g. '-o' (codex exec): write the agent's FINAL reply to a temp file so
    // stream noise (session header / token stats) never leaks into the reply.
    this.outFileFlag = cfg.outFileFlag || '';
    this._child = null;
  }

  meta() {
    return { adapterType: 'G', hasNativeSession: false, capabilities: ['chat'] };
  }

  ping() {
    if (!this.cliCmd) return false;
    if (this.cliCmd === 'codex') return !!resolveCodexCli();
    if (/[\\/]/.test(this.cliCmd)) { try { return existsSync(this.cliCmd); } catch { return false; } }
    return true; // bare name -> resolve on PATH at send time
  }

  cancel() {
    if (this._child) { try { this._child.kill('SIGTERM'); } catch {} this._child = null; }
  }

  async send({ messages, peers, roster, answerTo, signal, onEvent }) {
    if (!this.cliCmd) return { text: `[${this.agent.name}] 未配置 CLI 命令（cliCmd）` };
    const userText = lastUserText(messages) || '';
    const g = guardrail(userText);
    if (!g.allowed) {
      if (onEvent) onEvent({ kind: 'step', step: '已拦截：' + g.reason });
      return { text: `[${this.agent.name}] 指令被护栏拦截，未转发。\n\n原因：${g.reason}` };
    }
    const blocks = [];
    if (this.agent.system) blocks.push(`[你的角色]\n${this.agent.system}`);
    if (roster && roster.length) blocks.push(`[群成员]\n${roster.join('、')}`);
    if (peers && peers.length) blocks.push(`[群内其他成员的发言]\n${peers.join('\n')}`);
    if (answerTo) {
      blocks.push(`[你刚才问用户的问题]\n${answerTo.question}`);
      blocks.push(`[用户的回答]\n${userText}`);
      blocks.push('请基于这个回答继续执行原来的任务。');
    } else {
      blocks.push(`[用户对你说的话]\n${userText}`);
    }
    const prompt = blocks.join('\n\n');
    const hasPlaceholder = this.cliArgs.some((a) => String(a).includes('{prompt}'));
    const args = hasPlaceholder
      ? this.cliArgs.map((a) => String(a).replace(/\{prompt\}/g, prompt))
      : [...this.cliArgs, prompt];
    // 'codex' is a dynamic alias: resolve the real exe fresh per call because
    // the desktop app rotates its bin/<hash> dir on every update.
    const cmd = this.cliCmd === 'codex' ? resolveCodexCli() : this.cliCmd;
    if (!cmd) return { text: `[${this.agent.name}] 找不到 codex.exe（OpenAI Codex 桌面版未安装？）` };
    let tmpFile = '';
    if (this.outFileFlag) {
      tmpFile = join(tmpdir(), `achat-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.out`);
      args.push(this.outFileFlag, tmpFile);
    }
    if (onEvent) onEvent({ kind: 'step', step: `CLI ${this.cliCmd} 处理中…` });

    let child;
    try {
      child = spawn(cmd, args, { cwd: this.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return { text: `[${this.agent.name}] 无法启动 CLI：${e.message}` }; }
    this._child = child;
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const done = new Promise((res, rej) => {
      const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} rej(new Error(`CLI 执行超时（${Math.round(this.maxWaitMs / 1000)}s）`)); }, this.maxWaitMs);
      child.on('error', (e) => { clearTimeout(timer); rej(e); });
      child.on('close', (code) => { clearTimeout(timer); res({ code, out, err }); });
    });
    try {
      const { code, out: stdout, err: stderr } = await done;
      if (signal && signal.aborted) throw new Error('cancelled');
      // Final-reply file wins when present; raw stdout is the fallback (and
      // the only path for CLIs without an outfile flag).
      let text = '';
      if (tmpFile) {
        try { text = readFileSync(tmpFile, 'utf8').trim(); } catch { /* no file */ }
        try { unlinkSync(tmpFile); } catch { /* already gone */ }
      }
      if (!text) text = (stdout || '').trim() || (stderr || '').trim();
      return { text: text || (code === 0 ? '(CLI 无输出)' : `CLI 异常退出 code=${code}`) };
    } finally { this._child = null; }
  }
}

// M4: capability probe — auto-select the adapter class from a connection
// description, so a user can "just connect an agent" without hand-picking a type.
// Explicit adapterType (top-level or config) always wins; otherwise classify by
// which接入面 signals are present, per architecture-design.md §6.3.
export function describeProbe(agent) {
  const cfg = agent.config || {};
  if (agent.adapterType) return { type: agent.adapterType, reason: `显式指定 adapterType=${agent.adapterType}` };
  if (cfg.adapterType) return { type: cfg.adapterType, reason: `config.adapterType=${cfg.adapterType}` };
  if (cfg.cliCmd) return { type: 'G', reason: '本地 CLI 工具（cliCmd）→ G 类' };
  if (cfg.mcpServer || cfg.mcp) return { type: 'E', reason: '声明了 MCP server → E 类（MCP Adapter，M5 落地）' };
  if (cfg.a2a || cfg.agui || cfg.protocolEndpoint) return { type: 'F', reason: '声明了 A2A/AG-UI endpoint → F 类（Protocol Adapter，M5 落地）' };
  if (cfg.ports || cfg.dsh) return { type: 'A', reason: `自带 agent API（${cfg.ports ? '端口 ' + cfg.ports.join(',') : 'dsh'}）→ A 类` };
  if (cfg.acp || cfg.wbAcp || cfg.apiKey || cfg.cliKey || cfg.cliPath || (cfg.host && cfg.port)) return { type: 'W', reason: 'WorkBuddy 接入（ACP RC 服务 或 官方 API Key CLI 通路）→ W 类' };
  if (cfg.baseURL || cfg.apiBaseUrl || cfg.model || cfg.modelProvider || cfg.apiKeyEnv) return { type: 'B', reason: '模型 API（baseURL/model/provider/key）→ B 类' };
  if (cfg.binaryPath || (cfg.launcher && cfg.launcher.service)) return { type: 'D', reason: '本地二进制（binaryPath/launcher.service）→ D 类（桌面 GUI Launch+File，M5 收尾落地）' };
  if (cfg.localDir || cfg.bridge || cfg.inbox || cfg.outbox) return { type: 'C', reason: '文件桥（localDir/inbox）→ C 类' };
  return { type: 'B', reason: '无明确接入描述，默认 B 类（模型 API 扮演）' };
}
export function probeAdapterType(agent) { return describeProbe(agent).type; }

export function createAdapter(agent) {
  const t = probeAdapterType(agent);
  if (t === 'A') return new DshAdapter(agent);
  if (t === 'W') {
    const c = (agent.config || {});
    if (c.apiKey || c.cliKey || readEnvKey('CODEBUDDY_API_KEY')) return new WbCliKeyAdapter(agent);
    return new WbAcpAdapter(agent);
  }
  if (t === 'C') return new BridgeAdapter(agent);
  if (t === 'E') return new McpAdapter(agent);
  if (t === 'G') return new CliAdapter(agent);
  if (t === 'F') return new ProtocolAdapter(agent);
  if (t === 'D') return new DesktopGuiAdapter(agent); // D 类（桌面 GUI Launch+File）复用文件桥 + 通用 launcher 拉起
  return new ModelAdapter(agent);
}
