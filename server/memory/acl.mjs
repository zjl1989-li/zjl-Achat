// Permission layer (三库之一: 权限库) — fail-closed, conversation-scoped ACL.
// Ported from the Mnemo write-governance moat: every capability grant answers
// WHO (agentId) may do WHAT (cap) in WHICH conversation (convId), everything
// not explicitly granted is denied, and grants are auditable (each record
// carries a requester + timestamp - the AuditEvent idea, minimised).
//
// Storage: acl.json next to data.json, same tiny-JSON style as the store.
// Pure ESM, zero dependencies, ASCII only.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function createAcl({ file } = {}) {
  const FILE = file || join(process.cwd(), 'acl.json');
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
      cache = Array.isArray(parsed) ? parsed.filter((g) => g && g.convId && g.agentId && g.cap) : [];
    } catch { cache = []; }
    return cache;
  }

  function save() {
    const tmp = FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    try { renameSync(tmp, FILE); } catch { writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8'); }
  }

  // FAIL-CLOSED: no grant on file = deny. A wildcard agentId ('*') or cap
  // ('*') is allowed for coarse grants, but a missing record is never one.
  function can({ convId, agentId, cap }) {
    if (!convId || !agentId || !cap) return false;
    return load().some((g) =>
      (g.convId === convId || g.convId === '*')
      && (g.agentId === agentId || g.agentId === '*')
      && (g.cap === cap || g.cap === '*'));
  }

  function grant({ convId, agentId, cap, grantedBy } = {}) {
    if (!convId || !agentId || !cap) throw new Error('convId, agentId and cap are required');
    const all = load();
    if (all.some((g) => g.convId === convId && g.agentId === agentId && g.cap === cap)) return false;
    all.push({ convId, agentId, cap, grantedBy: grantedBy || '', ts: Date.now() });
    save();
    return true;
  }

  function revoke({ convId, agentId, cap } = {}) {
    const all = load();
    const keep = all.filter((g) => !(g.convId === convId && g.agentId === agentId && g.cap === cap));
    if (keep.length === all.length) return false;
    cache = keep;
    save();
    return true;
  }

  // Every grant ever made, newest first - the audit trail.
  function audit() {
    return load().slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  return { can, grant, revoke, audit };
}
