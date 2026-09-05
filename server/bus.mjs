// Group bus: route one user message to the right agents and stream results back.
// M1 scope: broadcast + directed delivery, agents run in parallel.
// M1.5: runtime status (idle/busy/error) + abortable turns.
// Pure ESM, zero dependencies, ASCII only.
import { createAdapter } from './adapters.mjs';
import { beginTask, endTask, isRunning, getPendingAsks, setPendingAsk, clearPendingAsk } from './runtime.mjs';

// Adapter instances are cached PER (agent, conversation): any native session
// state an adapter holds (DSH mirror session, MCP transport session, bridge
// workspace, CLI cwd) is therefore conversation-scoped by construction.
// One group = one project: memory can never bleed across conversations,
// whatever adapter class the agent uses. The '' conv key is the CONTROL
// PLANE (ping / probe) - it must never create conversation sessions.
const adapters = new Map(); // `${agentId}::${convId || ''}` -> adapter instance

function adapterKey(agentId, convId) {
  return convId ? `${agentId}::${convId}` : `${agentId}::`;
}

function adapterFor(agent, convId = '') {
  const k = adapterKey(agent.id, convId);
  if (!adapters.has(k)) adapters.set(k, createAdapter(agent));
  return adapters.get(k);
}
export { adapterFor };   // exported for the isolation regression test

// Settings edits must land without a restart, or the user changes a model and
// watches nothing happen. A turn already running keeps its own adapter reference,
// so this only affects the next turn - which for DSH means a fresh session, the
// honest consequence of changing how an agent is wired up.
export function dropAdapter(agentId) {
  for (const k of [...adapters.keys()]) {
    if (k.startsWith(`${agentId}::`)) adapters.delete(k);   // every conversation + control plane
  }
}

// Peer turns must never sit in the assistant channel. Tried labelling them
// inline ([name] text) and keeping role=assistant: the model read them as its
// own words and started parroting the last peer reply verbatim. So collapse
// consecutive peer turns into user-role background blocks instead.
//
// L0 WORKING-MEMORY BUDGET: the newest turns are kept, the oldest are dropped
// once the char budget is exceeded (chars are a good-enough token proxy for a
// mixed CJK/Latin transcript; a real tokenizer would be a dependency). The
// last message — the turn being answered — is always kept. Distilled history
// lives in the knowledge base (L2) and comes back in via the recall pipe.
const CTX_BUDGET_DEFAULT = 12000;

export function buildContext(conv, agentId, agents, budget = CTX_BUDGET_DEFAULT) {
  const nameOf = (id) => (agents.find((a) => a.id === id) || { name: id }).name;
  const out = [];
  const buf = [];
  const flush = () => {
    if (!buf.length) return;
    out.push({
      role: 'user',
      content: `[群内其他成员的发言]\n${buf.map((l) => `${l.who}: ${l.text}`).join('\n')}`,
    });
    buf.length = 0;
  };
  for (const m of conv.messages) {
    const text = m.text || m.content || '';
    if (m.sender === 'user') { flush(); out.push({ role: 'user', content: text }); }
    // Consensus frames (round / conclusion banners) are system-sent but MUST
    // reach the agent as user content, otherwise a "group" negotiation has no
    // topic. They render as dividers in the UI; here they are just context.
    else if (m.sender === 'system' && m.meta && m.meta.consensus) { flush(); out.push({ role: 'user', content: text }); }
    else if (m.sender === 'agent' && m.agentId !== agentId) { buf.push({ who: nameOf(m.agentId), text }); }
    else if (m.sender === 'agent') { flush(); out.push({ role: 'assistant', content: text }); }
  }
  flush();
  let total = out.reduce((n, m) => n + (m.content || '').length, 0);
  while (out.length > 1 && total > budget) {
    total -= (out[0].content || '').length;
    out.shift();
  }
  return out;
}

// Settings may override the budget per deployment (settings.ctxBudgetChars).
function ctxBudget(settings) {
  const n = Number(settings && settings.ctxBudgetChars);
  return Number.isFinite(n) && n > 0 ? n : CTX_BUDGET_DEFAULT;
}

// What the target physically cannot already see. A DSH session only ever held
// its own turns, so anything another member said has to be handed over
// explicitly - otherwise a "group" is just a 1:1 chat wearing a group name.
function peerLines(conv, agentId, agents, limit = 10, budget = 2000) {
  const nameOf = (id) => (agents.find((a) => a.id === id) || { name: id }).name;
  const out = [];
  let used = 0;
  for (let i = conv.messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = conv.messages[i];
    if (m.sender !== 'agent' || m.agentId === agentId) continue;
    const line = `${nameOf(m.agentId)}: ${String(m.text || '').replace(/\s+/g, ' ').trim()}`;
    if (used + line.length > budget) break;
    out.unshift(line);
    used += line.length;
  }
  return out;
}

function lastUserText(ctx) {
  for (let i = ctx.length - 1; i >= 0; i--) if (ctx[i].role === 'user') return ctx[i].content;
  return '';
}

// "@北辰 帮我看看" -> ['beichen']. Candidates come from the member list only,
// so @ in an email, a decorator or prose can never invent a target.
// Exported for the regression test: a mis-parse silently sends the turn to the
// wrong member, which is the kind of bug nobody notices until it matters.
export function parseMentions(text, agents, memberIds) {
  const pool = (memberIds || []).map((id) => agents.find((a) => a.id === id)).filter(Boolean);
  const cands = [];
  for (const a of pool) {
    for (const n of new Set([a.name, a.id].filter(Boolean))) {
      cands.push({ id: a.id, n: String(n).toLowerCase() });
    }
  }
  // Longest name first, and blank out each hit as it is found: otherwise a short
  // name consumes a longer one ("@北辰" would match inside "@北辰辰").
  cands.sort((x, y) => y.n.length - x.n.length);
  let rest = String(text || '').toLowerCase();
  const hits = [];
  for (const c of cands) {
    const at = '@' + c.n;
    for (let i = rest.indexOf(at); i !== -1; i = rest.indexOf(at)) {
      hits.push(c.id);
      rest = rest.slice(0, i) + '\u0000'.repeat(at.length) + rest.slice(i + at.length);
    }
  }
  return [...new Set(hits)];
}

// An explicit target wins (UI picker, or a delegation hop). Otherwise "@name" in
// the newest message narrows the broadcast - mentioning one member is the
// cheapest way to say "just you", and it costs nothing to support.
function resolveTargets({ conv, agents, toAgentId }) {
  if (toAgentId) return agents.filter((a) => a.id === toAgentId);
  if (conv.type === 'dm') return agents.filter((a) => a.id === conv.agentId);
  // An agent that asked something owns the next message: the reply is an answer,
  // not a new topic. Broadcasting it would restart work in every other seat and
  // drown the answer it was meant for.
  const asks = getPendingAsks(conv.id);
  if (asks.length) return asks.map((x) => agents.find((a) => a.id === x.agentId)).filter(Boolean);
  const last = conv.messages[conv.messages.length - 1];
  const mentioned = last ? parseMentions(last.text, agents, conv.memberIds) : [];
  const ids = mentioned.length ? mentioned : (conv.memberIds || []);
  return ids.map((id) => agents.find((a) => a.id === id)).filter(Boolean);
}

/** Liveness probe: is this agent reachable right now? */
export async function probeAgent(agent) {
  try {
    return await adapterFor(agent).ping();
  } catch {
    return false;
  }
}

/**
 * Dispatch a user message.
 * @param {object} opts
 * @param {object} opts.conv      conversation object (mutated: replies appended)
 * @param {Array}  opts.agents    all registered agents
 * @param {string} opts.toAgentId directed target, empty = broadcast
 * @param {Function} opts.emit       (event, data) -> push to SSE
 * @param {Function} opts.persist    save store
 * @param {Function} opts.recordTool (agentId, toolName) -> tally observed capability
 * @param {number}   opts.depth      delegation hop count, 0 = the user's turn
 * @param {string}   opts.delegatedBy who @-mentioned this target (display only)
 * @param {object}   opts.settings   { delegation: bool } - auto-delegation is opt-in
 */
export async function dispatch({
  conv, agents, toAgentId, emit, persist, recordTool,
  depth = 0, delegatedBy = '', settings, recall,
}) {
  const targets = resolveTargets({ conv, agents, toAgentId });
  if (!targets.length) return;

  const nameOf = (id) => (agents.find((a) => a.id === id) || { name: id }).name;
  // Mark the target's own seat: given a plain name list, agents counted
  // themselves twice ("北辰、DSH、投资研究，加上我共四位").
  const rosterFor = (agentId) => (conv.memberIds || []).map((id) => nameOf(id) + (id === agentId ? '（你）' : ''));
  const prompt = lastUserText(buildContext(conv, '', agents, ctxBudget(settings)));
  // RETRIEVAL PIPE (L2 -> L0): knowledge-base hits relevant to this turn,
  // fetched BEFORE dispatch and handed to every adapter as `recall`. Adapters
  // that fold blocks (DSH) or prepend context (model API) use it; the rest
  // ignore it. Failure to recall must never fail the turn.
  let recalled = [];
  if (typeof recall === 'function' && prompt) {
    try { recalled = (await recall(prompt) || []).slice(0, 3); } catch { recalled = []; }
  }
  const produced = [];
  // agentId -> the question this reply answers, if any. Read before dispatch so
  // a concurrent answer cannot move the target list halfway through the turn.
  const asks = new Map(getPendingAsks(conv.id).map((x) => [x.agentId, x]));

  await Promise.all(targets.map(async (agent) => {
    const ac = beginTask(agent.id, {
      convId: conv.id,
      text: prompt,
      onAbort: () => {
        const ad = adapterFor(agent, conv.id);
        if (typeof ad.cancel === 'function') ad.cancel();
      },
    });
    if (!ac) {
      emit('message', { convId: conv.id, message: {
        id: mid(), sender: 'system', text: `[${agent.name}] 正忙，本条已跳过`, ts: Date.now(),
      } });
      return;
    }
    emit('typing', { convId: conv.id, agentId: agent.id });
    const started = Date.now();
    try {
      // Collect the live trace (tool calls / steps) into the final message so
      // the history document can reproduce what the agent actually did, not
      // just the finished answer. Kept deliberately small (no raw tool output).
      const think = [];
      const adapter = adapterFor(agent, conv.id);
      const { text, nativeSessionId, contextLost, ask: newAsk, artifacts } = await adapter.send({
        agent,
        convId: conv.id,
        messages: buildContext(conv, agent.id, agents, ctxBudget(settings)),
        peers: peerLines(conv, agent.id, agents),
        roster: rosterFor(agent.id),
        // Knowledge-base hits for this turn (L2 -> L0 pipe). Empty = nothing
        // matched, adapters just skip the block.
        ...(recalled.length ? { recall: recalled } : {}),
        // The question this turn answers, if the user was replying to one. The
        // adapter folds it back in, because from the agent's side this is a
        // brand new turn that has no idea it ever asked.
        answerTo: asks.get(agent.id),
        // Only teach the gesture to someone whose @ will actually be honoured -
        // the last hop must not learn a move that does nothing.
        allowDelegate: !!settings?.delegation && depth < MAX_DELEGATION_DEPTH,
        signal: ac.signal,
        onEvent: (ev) => {
          if (ev.kind === 'tool_call' && recordTool) recordTool(agent.id, ev.name);
          if (ev.kind === 'tool_call') think.push({ kind: 'tool_call', name: ev.name, detail: String(ev.detail || '').slice(0, 200) });
          else if (ev.kind === 'step') think.push({ kind: 'step', step: ev.step });
          emit('tool', { convId: conv.id, agentId: agent.id, ...ev });
        },
      });
      if (contextLost) {
        emit('message', { convId: conv.id, message: {
          id: mid(), sender: 'system',
          text: `[${agent.name}] 会话已重建，之前的上下文丢失`, ts: Date.now(),
        } });
      }
      const msg = {
        id: mid(),
        sender: 'agent',
        agentId: agent.id,
        text,
        ts: Date.now(),
        ms: Date.now() - started,
        ...(nativeSessionId ? { nativeSessionId } : {}),
        ...(delegatedBy ? { delegatedBy } : {}),
        // Carries the question to the UI: same shape whether it came from DSH's
        // ask tool or was recognised in plain model output.
        ...(newAsk ? { ask: newAsk } : {}),
        // Bridge (C class) products return deliverables on disk; relay them so
        // the UI can surface them in the group space (§8.2). Other adapters
        // simply omit this field.
        ...(artifacts?.length ? { artifacts } : {}),
        // The agent's own work trace, folded into the history document.
        ...(think.length ? { thinking: think } : {}),
      };
      conv.messages.push(msg);
      persist();
      emit('message', { convId: conv.id, message: msg });
      endTask(agent.id);
      // The question is answered, so release the router. Order matters: endTask
      // just painted this agent idle, and the ask state has to land after it.
      clearPendingAsk(conv.id, agent.id);
      if (newAsk) setPendingAsk(conv.id, agent.id, newAsk);
      produced.push(msg);
    } catch (e) {
      const aborted = ac.signal.aborted;
      const msg = {
        id: mid(),
        sender: 'agent',
        agentId: agent.id,
        text: aborted ? `[${agent.name}] 已中断` : `[${agent.name}] 调用失败：${e.message}`,
        ts: Date.now(),
        ms: Date.now() - started,
        error: !aborted,
      };
      conv.messages.push(msg);
      persist();
      emit('message', { convId: conv.id, message: msg });
      endTask(agent.id, aborted ? '' : e.message);
      // A failed turn is not an answer, but leaving the ask pending would pin
      // every later message to this agent. Drop it and let the group breathe.
      clearPendingAsk(conv.id, agent.id);
    } finally {
      emit('typing', { convId: conv.id, agentId: agent.id, done: true });
    }
  }));

  await delegate({ conv, agents, produced, emit, persist, recordTool, depth, settings });
}

// ---------- multi-agent negotiation / consensus (bus strategy #3) ----------
// Unlike broadcast (everyone answers the user independently) or directed
// delivery (@one peer), consensus runs N DELIBERATION ROUNDS: each round every
// participant sees all prior rounds' positions and reacts, so stances actually
// evolve toward agreement instead of being N parallel monologues. A synthesizer
// agent then reads the whole transcript and emits the final consensus.
//
// Reuses dispatch() per participant (single-target), so every adapter class
// (DSH / WorkBuddy / Model / Bridge / ...) works unchanged - achat still owns
// context assembly, the participants just see richer history each round.
const MAX_ROUNDS = 6;

export async function runConsensus({
  conv, agents, topic, participantIds, rounds, synthesizerId,
  emit, persist, recordTool, settings, recall, onConclusion,
}) {
  if (conv.negotiation && conv.negotiation.active) {
    throw new Error('该群已有协商进行中');
  }
  const parts = (participantIds && participantIds.length
    ? participantIds
    : (conv.memberIds || [])).map((id) => agents.find((a) => a.id === id)).filter(Boolean);
  if (parts.length < 2) throw new Error('协商至少需要 2 个参与 agent');

  // Prefer an explicit synthesizer, else a model-backed (B-class) agent, else
  // the first participant. The synthesizer only reads + writes up a conclusion.
  const synth = (synthesizerId && agents.find((a) => a.id === synthesizerId))
    || parts.find((a) => (a.config && a.config.model) || (a.adapterType === 'B'))
    || parts[0];

  rounds = Math.max(1, Math.min(rounds || 3, MAX_ROUNDS));
  const negotiation = {
    active: true, phase: 'deliberation', round: 0, rounds,
    topic, participants: parts.map((a) => a.id), synthesizer: synth.id,
    status: 'running', startedAt: Date.now(), errors: [],
  };
  conv.negotiation = negotiation;
  persist();
  emit('negotiation', { convId: conv.id, negotiation });

  // One consensus frame (round banner / conclusion banner). It is a real message
  // so it lands in history AND reaches the agents as user content (see buildContext).
  const frame = (kind, text, extra = {}) => {
    const msg = { id: mid(), sender: 'system', text, ts: Date.now(), meta: { consensus: true, kind, ...extra } };
    conv.messages.push(msg);
    persist();
    emit('message', { convId: conv.id, message: msg });
    return msg;
  };

  for (let r = 1; r <= rounds; r++) {
    const instruction = r === 1
      ? `议题：${topic}\n你是本次多 agent 协商的参与者之一。请先发表你的**独立立场**与核心论点（不必急于妥协，先把话说清楚）。`
      : `这是第 ${r}/${rounds} 轮协商。请基于各方前几轮的立场，进一步论证、补充证据，或调整 / 收敛你的观点。仍保留你不同意的合理异议，但尽量朝可执行的共识靠拢。`;
    frame('round', instruction, { round: r, rounds });
    negotiation.round = r;
    emit('negotiation', { convId: conv.id, negotiation });
    // Parallel within the round: each participant starts from the SAME context
    // snapshot (frames + all PRIOR rounds; same-round siblings are not visible
    // to each other, which keeps a clean "round" boundary).
    await Promise.all(parts.map(async (a) => {
      try {
        await dispatch({
          conv, agents, toAgentId: a.id, emit, persist, recordTool,
          settings: { ...settings, delegation: false }, recall,
        });
      } catch (e) {
        negotiation.errors.push({ round: r, agent: a.id, error: String((e && e.message) || e) });
        console.error(`[consensus] ${a.id} round ${r} failed:`, e && e.message);
      }
    }));
  }

  // Conclusion: one synthesizer reads the full transcript and writes it up.
  negotiation.phase = 'conclusion';
  emit('negotiation', { convId: conv.id, negotiation });
  frame('conclusion', `协商已进行 ${rounds} 轮。请综合上述各方立场，输出**最终共识结论**：\n① 一致同意的要点；\n② 主要分歧（如有，谁持什么异议）；\n③ 可执行的下一步建议。`);
  try {
    await dispatch({
      conv, agents, toAgentId: synth.id, emit, persist, recordTool,
      settings: { ...settings, delegation: false }, recall,
    });
  } catch (e) {
    negotiation.errors.push({ round: 'conclusion', agent: synth.id, error: String((e && e.message) || e) });
    console.error(`[consensus] synthesizer ${synth.id} failed:`, e && e.message);
  }
  // Mark the synthesizer's last reply as the consensus conclusion (for UI).
  const last = [...conv.messages].reverse().find((m) => m.sender === 'agent' && m.agentId === synth.id);
  if (last) {
    last.meta = { ...(last.meta || {}), consensusConclusion: true };
    persist();
    emit('message', { convId: conv.id, message: last, update: true });
  }
  // DISTILL PIPE (L1 -> L2), auto path: a consensus conclusion is already
  // distilled content — hand it to the caller's sink so it lands in the
  // knowledge base without anyone remembering to do it. Never fatal.
  if (last && typeof onConclusion === 'function') {
    try { onConclusion(conv, last, agents); } catch (e) {
      console.error('[consensus] conclusion distill failed:', e && e.message);
    }
  }

  negotiation.phase = 'concluded';
  negotiation.status = 'done';
  negotiation.active = false;
  negotiation.finishedAt = Date.now();
  emit('negotiation', { convId: conv.id, negotiation });
  persist();
}

// Delegation: an agent that @names a peer pulls that peer into the same turn.
// Two guards, both non-negotiable - this feature spends money on its own:
//   1. OPT-IN. Off unless settings.delegation is true; a chatty model otherwise
//      escalates every reply into a group conference.
//   2. DEPTH CAP. A->B->A is an infinite bill otherwise. One hop means the
//      summoned member may answer, but may not summon again.
// Self-mentions are dropped too, so nobody can summon themselves.
const MAX_DELEGATION_DEPTH = 1;

async function delegate({ conv, agents, produced, emit, persist, recordTool, depth, settings }) {
  if (!settings?.delegation) return;
  if (depth >= MAX_DELEGATION_DEPTH) return;
  const next = [];
  for (const m of produced) {
    for (const id of parseMentions(m.text, agents, conv.memberIds)) {
      if (id === m.agentId) continue;
      if (!next.some((x) => x.to === id)) next.push({ to: id, by: m.agentId });
    }
  }
  for (const hop of next) {
    await dispatch({
      conv, agents, emit, persist, recordTool,
      toAgentId: hop.to, depth: depth + 1, delegatedBy: hop.by, settings,
    });
  }
}

export { isRunning };

function mid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
