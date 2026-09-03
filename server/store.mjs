// Tiny JSON-file store: conversations + agents. No native deps.
// Writes are atomic (tmp + rename) so a crash mid-write can't corrupt data.json.
// A revision counter + savedAt are kept so callers can detect external edits.
import { readFileSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_AGENTS } from './agents.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, 'data.json');
const TMP = DATA + '.tmp';
const AVATAR_DIR = join(__dirname, 'avatars');

// Base64 avatars lived inline in data.json: two agents' icons were ~350KB and
// every save() rewrites the whole file. Offload any data-URL avatar larger than
// 4KB to server/avatars/<id>.<ext>; the JSON keeps only the URL. Small inline
// SVG brand icons stay inline - they cost less than the file round-trip.
function persistAvatar(a) {
  const av = a && a.avatar;
  if (typeof av !== 'string' || !av.startsWith('data:image/')) return a;
  // subtype may contain a hyphen ("x-icon"), so \w alone is not enough
  const m = /^data:image\/([\w-]+);base64,(.+)$/.exec(av);
  if (!m || m[2].length < 5500) return a; // ~4KB decoded
  try {
    mkdirSync(AVATAR_DIR, { recursive: true });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1] === 'x-icon' ? 'ico' : m[1];
    writeFileSync(join(AVATAR_DIR, `${a.id}.${ext}`), Buffer.from(m[2], 'base64'));
    a.avatar = `/avatars/${a.id}.${ext}`;
  } catch { /* keep the base64 on disk failure - correctness over size */ }
  return a;
}

// Recursive merge: objects recurse, everything else (incl. arrays) replaces.
// Used by upsertAgent so a partial PATCH can't wipe sibling config fields.
function deepMerge(target, patch) {
  const out = { ...target };
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    const t = target ? target[k] : undefined;
    if (v && typeof v === 'object' && !Array.isArray(v) && t && typeof t === 'object' && !Array.isArray(t)) {
      out[k] = deepMerge(t, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Delegation costs extra LLM turns, and A->B->A is an infinite bill, so it is
// opt-in. See MAX_DELEGATION_DEPTH in bus.mjs for the loop guard.
const DEFAULT_SETTINGS = { delegation: false };

function defaults() {
  return {
    conversations: {}, agents: DEFAULT_AGENTS, toolStats: {},
    settings: { ...DEFAULT_SETTINGS }, revision: 0, savedAt: null,
  };
}

// Set when data.json was unreadable and we fell back to a clean slate. Silent
// recovery looked like a working app: the user came back to an empty conversation
// list with no explanation, and the only clue was the .corrupt file nobody opens.
// Surfacing it turns "my data vanished" into "here is where the broken copy is".
let recovered = null;

function load() {
  if (existsSync(DATA)) {
    try {
      const parsed = JSON.parse(readFileSync(DATA, 'utf8'));
      if (parsed && typeof parsed === 'object') return { ...defaults(), ...parsed };
    } catch {
      // corrupt file: start clean but keep the broken copy for recovery
      const kept = DATA + '.corrupt';
      let keptOk = false;
      try { renameSync(DATA, kept); keptOk = true; } catch { /* ignore */ }
      recovered = {
        at: new Date().toISOString(),
        path: keptOk ? kept : null,
        hint: keptOk
          ? '损坏的副本已保留为 server/data.json.corrupt，可以手工从中恢复。'
          : '损坏文件无法改名保留，原文件仍在原位置，请手工处理。',
      };
    }
  }
  return defaults();
}

// Snapshot before this process can write anything. Once an in-memory state
// overwrites data.json there is no undo (no commits, no history), so the last
// known-good copy is kept here.
// The copy is parsed BEFORE it replaces the old backup: a file being written
// by another process can be read half-done, and a truncated .bak is worse than
// a stale one because it looks like a recovery option until you open it.
function snapshot() {
  try {
    if (!existsSync(DATA)) return;
    const raw = readFileSync(DATA);
    JSON.parse(raw.toString('utf8'));
    writeFileSync(DATA + '.bak', raw);
  } catch { /* unreadable or racy copy - keep the previous backup */ }
}
snapshot();

const state = load();

// True when the file on disk still holds conversations. Used by save() to
// refuse a write that would erase them.
function hasConversationsOnDisk() {
  try {
    if (!existsSync(DATA)) return false;
    const p = JSON.parse(readFileSync(DATA, 'utf8'));
    return Object.keys((p && p.conversations) || {}).length > 0;
  } catch { return false; }
}
if (!state.agents || !state.agents.length) state.agents = DEFAULT_AGENTS;
if (!state.conversations) state.conversations = {};
if (!state.toolStats) state.toolStats = {};
if (!state.settings) state.settings = { ...DEFAULT_SETTINGS };
if (typeof state.revision !== 'number') state.revision = 0;

let lastMtime = mtimeOf(DATA);

// One-time boot migration for agents saved before avatars were offloaded.
// Must run after lastMtime is set: save() compares against it.
let avatarsMigrated = false;
for (const a of state.agents) {
  const before = a.avatar;
  persistAvatar(a);
  if (a.avatar !== before) { avatarsMigrated = true; console.log(`[store] avatar offloaded: ${a.name || a.id}`); }
}
if (avatarsMigrated) save();

function mtimeOf(path) {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

// Merge in anything another process wrote since our last save.
function mergeExternal() {
  const external = load();
  for (const [id, conv] of Object.entries(external.conversations || {})) {
    const mine = state.conversations[id];
    // keep whichever side has more messages; they are append-only logs
    if (!mine || (conv.messages?.length || 0) > (mine.messages?.length || 0)) {
      state.conversations[id] = conv;
    }
  }
  for (const a of external.agents || []) {
    if (!state.agents.some((x) => x.id === a.id)) state.agents.push(a);
  }
}

function save() {
  try {
    const m = mtimeOf(DATA);
    if (lastMtime !== null && m !== null && m !== lastMtime) {
      console.warn('[store] data.json changed on disk, merging external edits');
      mergeExternal();
    }
    // Refuse to let an empty in-memory state wipe a non-empty file. This is the
    // exact shape of the 2026-09-02 data loss: a state with no conversations
    // reached save() and every conversation on disk was gone, unrecoverable.
    if (!Object.keys(state.conversations).length && hasConversationsOnDisk()) {
      console.error('[store] REFUSING to save: memory has no conversations but disk does');
      return;
    }
    state.revision += 1;
    state.savedAt = new Date().toISOString();
    writeFileSync(TMP, JSON.stringify(state, null, 2));
    renameSync(TMP, DATA); // atomic within the same directory
    lastMtime = mtimeOf(DATA);
  } catch (e) {
    console.error('save fail', e.message);
    try { unlinkSync(TMP); } catch { /* ignore */ }
  }
}

export const store = {
  getRevision: () => state.revision,
  // Non-null only when this process started from an unreadable data.json.
  getRecovery: () => recovered,
  getAgents: () => state.agents,
  deleteAgent: (id) => {
    state.agents = state.agents.filter((x) => x.id !== id);
    // Drop the removed agent from every group's member list so no stale ids linger.
    for (const c of Object.values(state.conversations)) {
      if (Array.isArray(c.memberIds)) c.memberIds = c.memberIds.filter((m) => m !== id);
    }
    delete state.toolStats[id];
    save();
  },
  upsertAgent: (a) => {
    const i = state.agents.findIndex((x) => x.id === a.id);
    if (i >= 0) {
      const merged = { ...state.agents[i], ...a };
      // Deep-merge config so a partial PATCH (e.g. {config:{launcher:{enabled}}})
      // updates only the touched leaf and keeps the rest (ports/service/env/...).
      if (a.config && state.agents[i].config) merged.config = deepMerge(state.agents[i].config, a.config);
      state.agents[i] = persistAvatar(merged);
    } else state.agents.push(persistAvatar(a));
    save();
    return a;
  },
  getConversations: () => Object.values(state.conversations),
  getConversation: (id) => state.conversations[id],
  upsertConversation: (c) => {
    state.conversations[c.id] = c;
    save();
    return c;
  },
  deleteConversation: (id) => {
    delete state.conversations[id];
    save();
  },
  // Observed capabilities: which tools an agent has actually called, and how often.
  // DSH exposes no capability-listing RPC, so we measure instead of asking - this
  // turns the hand-written `skills` tag into evidence.
  recordTool: (agentId, tool) => {
    if (!agentId || !tool) return;
    const by = (state.toolStats[agentId] ||= {});
    by[tool] = (by[tool] || 0) + 1;
    save();
  },
  toolStatsOf: (agentId) => state.toolStats[agentId] || {},
  getSettings: () => state.settings,
  setSettings: (patch) => {
    state.settings = { ...state.settings, ...(patch || {}) };
    save();
    return state.settings;
  },
  save,
};
