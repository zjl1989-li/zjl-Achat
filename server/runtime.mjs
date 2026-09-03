// Agent runtime status: offline / idle / busy / error, plus abort control.
// Status is in-memory only (a crash means every agent is offline again anyway).
// Pure ESM, zero dependencies, ASCII only.

// Light colors live in style.css (.traffic[data-s=...]) and are the source of
// truth: busy = green (running), idle/asking = yellow (free / waiting on you),
// error = red (last turn failed), offline = grey (not reachable / switched off).

const listeners = new Set();
const status = new Map();  // agentId -> { state, since, convId, preview, error }
const running = new Map(); // agentId -> AbortController (only while busy)

// convId -> Map(agentId -> { question, options, at }). Keyed by conversation so
// one group's pending question never routes another group's reply.
const pendingAsks = new Map();

const EMPTY = { state: 'offline', since: null, convId: null, preview: '', error: '' };

export function getStatus(agentId) {
  return status.get(agentId) || { ...EMPTY };
}

export function allStatus() {
  const out = {};
  for (const id of status.keys()) out[id] = getStatus(id);
  return out;
}

export function setStatus(agentId, patch) {
  const prev = getStatus(agentId);
  const next = { ...prev, ...patch };
  if (patch.state && patch.state !== prev.state) next.since = Date.now();
  if (JSON.stringify(next) === JSON.stringify(prev)) return prev; // no-op, don't spam SSE
  status.set(agentId, next);
  notify([{ agentId, status: next }]);
  return next;
}

export function onStatus(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(updates) {
  for (const cb of listeners) {
    try { cb(updates); } catch { /* a dead client must not break the bus */ }
  }
}

// ---- task lifecycle -------------------------------------------------------
// beginTask returns null when the agent is already busy: one turn at a time.
// onAbort lets the caller do adapter-specific cleanup (e.g. tell DSH to stop).
export function beginTask(agentId, { convId, text, onAbort } = {}) {
  if (running.has(agentId)) return null;
  const ac = new AbortController();
  if (onAbort) {
    ac.signal.addEventListener('abort', () => {
      try { onAbort(); } catch { /* cleanup must never throw */ }
    }, { once: true });
  }
  running.set(agentId, ac);
  setStatus(agentId, { state: 'busy', convId: convId || null, preview: String(text || '').slice(0, 120), error: '' });
  return ac;
}

export function endTask(agentId, err) {
  running.delete(agentId);
  setStatus(agentId, {
    state: err ? 'error' : 'idle',
    error: err ? String(err).slice(0, 200) : '',
    convId: null,
    preview: '',
  });
}

export function abort(agentId) {
  const ac = running.get(agentId);
  if (!ac) return false;
  ac.abort(); // adapters watch signal: fetch gets cancelled, DSH polling loop exits
  return true;
}

export function isRunning(agentId) {
  return running.has(agentId);
}

// ---- pending questions ----------------------------------------------------
// An agent that has asked the user something owns the next message in that
// conversation: the reply is an answer, not a new topic, so it must not be
// broadcast to everyone (that would restart work in the other seats).

export function setPendingAsk(convId, agentId, ask) {
  if (!convId || !agentId) return;
  if (!pendingAsks.has(convId)) pendingAsks.set(convId, new Map());
  pendingAsks.get(convId).set(agentId, { ...ask, at: Date.now() });
  setStatus(agentId, { state: 'asking', convId });
}

export function getPendingAsks(convId) {
  const m = pendingAsks.get(convId);
  if (!m) return [];
  return [...m.entries()].map(([agentId, ask]) => ({ agentId, ...ask }));
}

export function clearPendingAsk(convId, agentId) {
  const m = pendingAsks.get(convId);
  if (!m) return;
  m.delete(agentId);
  if (!m.size) pendingAsks.delete(convId);
  // Only release the light if we are the ones holding it - the agent may have
  // moved on to a new (busy/error) state in the meantime.
  if (getStatus(agentId).state === 'asking') {
    setStatus(agentId, { state: 'idle', convId: null, preview: '' });
  }
}
