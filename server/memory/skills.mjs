// Skill layer (三库之一: 技能库) — a declarative capability registry. Each
// skill is a small record (id / name / desc / prompt) an agent can be granted
// per conversation; a group picks what its task needs instead of every seat
// carrying every capability. Skills are DATA, not code: adding one is editing
// a JSON file, never patching the server.
//
// Storage: skills.json next to data.json, same tiny-JSON/atomic-rewrite style
// as the store. Pure ESM, zero dependencies, ASCII only.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function createSkills({ file } = {}) {
  const FILE = file || join(process.cwd(), 'skills.json');
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
      cache = Array.isArray(parsed) ? parsed.filter((s) => s && s.id) : [];
    } catch { cache = []; }   // missing/corrupt file = empty registry, never fatal
    return cache;
  }

  function save() {
    const tmp = FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    try { renameSync(tmp, FILE); } catch { writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8'); }
  }

  function list() { return load().slice(); }

  function get(id) {
    return load().find((s) => s.id === id) || null;
  }

  // Upsert by id. A skill needs at least a prompt or an explicit tool binding,
  // otherwise it is a name without a body.
  function register({ id, name, desc, prompt, tools } = {}) {
    if (!id) throw new Error('skill id required');
    if (!String(prompt || '').trim() && !(Array.isArray(tools) && tools.length)) {
      throw new Error('skill needs a prompt or tools');
    }
    const rec = {
      id: String(id),
      name: String(name || id),
      desc: String(desc || ''),
      prompt: String(prompt || ''),
      tools: Array.isArray(tools) ? tools.map(String) : [],
    };
    const all = load();
    const i = all.findIndex((s) => s.id === rec.id);
    if (i === -1) all.push(rec); else all[i] = rec;
    save();
    return rec;
  }

  function remove(id) {
    const all = load();
    const i = all.findIndex((s) => s.id === id);
    if (i === -1) return false;
    all.splice(i, 1);
    save();
    return true;
  }

  return { list, get, register, remove };
}
