// Distillation pipe (L1 -> L2): turn conversation transcripts into durable
// KB notes. Deliberately ZERO-LLM: the content worth keeping already exists
// in distilled form — consensus conclusions were written by a synthesizer,
// topic frames by the system, agent replies by the agents themselves. This
// module only formats them into a titled markdown note; the KnowledgeAdapter
// appends same-title writes as dated sections, so re-distilling a group
// accumulates readable history instead of stacking duplicates.
//
// Heuristic, not magic: it preserves what was said, it does not invent a
// summary. An LLM-assisted summarizer can replace the body builders later
// behind the same interface.
//
// Pure ESM, zero dependencies, ASCII only (note CONTENT may be any language).
const MAX_LINE = 240;      // per-message trim inside the digest
const MAX_ITEMS = 12;      // messages kept in a whole-conversation digest

const nameOf = (agents, id) => (agents.find((a) => a.id === id) || { name: id }).name;
const clip = (s, n = MAX_LINE) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Whole-conversation digest: participants, topic frames, the user's asks,
// each member's latest reply, artifacts. Everything a returning reader needs.
export function distillConv(conv, agents = []) {
  const msgs = conv.messages || [];
  const participants = [...new Set(msgs.filter((m) => m.sender === 'agent').map((m) => m.agentId))]
    .map((id) => nameOf(agents, id));

  const topics = msgs
    .filter((m) => m.sender === 'system' && m.meta && m.meta.consensus && m.meta.kind === 'round')
    .map((m) => clip(m.text));

  const asks = msgs.filter((m) => m.sender === 'user').slice(-MAX_ITEMS).map((m) => `- 用户：${clip(m.text)}`);

  // Latest reply per member: a digest wants each seat's final position, not
  // every intermediate turn.
  const lastByAgent = new Map();
  for (const m of msgs) {
    if (m.sender === 'agent' && !m.error) lastByAgent.set(m.agentId, m);
  }
  const replies = [...lastByAgent.values()].map((m) => `- ${nameOf(agents, m.agentId)}：${clip(m.text)}`);

  const artifacts = [];
  for (const m of msgs) {
    for (const a of m.artifacts || []) {
      artifacts.push(`- ${a.name || a.title || a.id}（${a.path || a.url || '已归档'}）`);
    }
  }

  const parts = [
    `[参与成员]\n${participants.join('、') || '（无）'}`,
  ];
  if (topics.length) parts.push(`[议题]\n${topics.map((t) => `- ${t}`).join('\n')}`);
  if (asks.length) parts.push(`[用户的提问]\n${asks.join('\n')}`);
  if (replies.length) parts.push(`[各成员最终立场]\n${replies.join('\n')}`);
  if (artifacts.length) parts.push(`[产物]\n${artifacts.join('\n')}`);

  return {
    title: `群档-${conv.name || conv.id}`,
    body: parts.join('\n\n'),
  };
}

// Single-message pin: keep one exact turn (a decision, a plan, an answer)
// with its speaker and timestamp. Used by the /distill endpoint and by the
// auto-distill hook on consensus conclusions.
export function distillMessage(conv, msg, agents = []) {
  const who = msg.sender === 'user' ? '用户' : nameOf(agents, msg.agentId);
  const lines = [
    `群：${conv.name || conv.id}`,
    `时间：${new Date(msg.ts || Date.now()).toISOString()}`,
    ``,
    `${who}：${clip(msg.text, 4000)}`,
  ];
  for (const a of msg.artifacts || []) lines.push(`产物：${a.name || a.id}（${a.path || a.url || '已归档'}）`);
  const kind = (msg.meta && msg.meta.consensusConclusion) ? '共识结论' : '摘录';
  return {
    title: `群档-${conv.name || conv.id}-${kind}`,
    body: lines.join('\n'),
  };
}
