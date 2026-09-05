// Knowledge layer (三库之一: 资料库) — the "semantic memory" sink of the
// memory architecture: conversation value gets DISTILLED into durable notes,
// never mindlessly appended and never hard-deleted. Backends are pluggable;
// v1 ships the default one: an Obsidian vault = a plain folder of .md files.
//
// Why a folder of markdown: zero dependencies, human-readable outside achat,
// syncable by the user's own tools, and the data never leaves the machine.
// A cloud backend (e.g. ima) implements the same interface later.
//
// Pure ESM, zero dependencies, ASCII only (note CONTENT may be any language).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve, basename, extname, sep } from 'node:path';

const MD = '.md';
const FRONT = '---\n';

// Filenames must survive Windows/macOS/Linux and stay inside the vault.
// Everything outside [A-Za-z0-9\u4e00-\u9fff _-] is dropped; a title that
// sanitizes to nothing falls back to a timestamped name.
function sanitizeTitle(t) {
  const s = String(t || '').replace(/[^\w\u4e00-\u9fff -]+/g, '').replace(/\s+/g, ' ').trim();
  return (s || `note-${Date.now().toString(36)}`).slice(0, 80);
}

function frontmatter(note) {
  const tags = (note.tags || []).map((t) => String(t).trim()).filter(Boolean);
  return FRONT
    + `created: ${new Date().toISOString()}\n`
    + `source: ${note.source || 'achat'}\n`
    + (tags.length ? `tags: [${tags.join(', ')}]\n` : '')
    + FRONT;
}

// Parse a minimal YAML-ish frontmatter block. Only what we write ourselves -
// tolerant, never throws on user-edited files.
function parseFrontmatter(body) {
  if (!body.startsWith(FRONT)) return {};
  const end = body.indexOf('\n---\n', FRONT.length);
  if (end === -1) return {};
  const out = {};
  for (const line of body.slice(FRONT.length, end).split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function createKnowledge({ dir } = {}) {
  const vault = resolve(dir || join(process.cwd(), 'kb'));
  mkdirSync(vault, { recursive: true });

  // Resolve a title to a path STRICTLY inside the vault. resolve() + prefix
  // check is the belt; sanitizeTitle() removed the traversal characters, this
  // is the suspenders - and it also guards hand-crafted paths from the API.
  // Prefix uses the platform separator: resolve() output matches it on every OS.
  function pathFor(title) {
    const p = resolve(vault, sanitizeTitle(title) + MD);
    const pre = vault.endsWith(sep) ? vault : vault + sep;
    if (!p.startsWith(pre)) throw new Error('path escapes vault');
    return p;
  }

  function read(title) {
    const p = pathFor(title);
    if (!existsSync(p)) return null;
    const body = readFileSync(p, 'utf8');
    return { title: basename(p, MD), body, meta: parseFrontmatter(body), mtime: statSync(p).mtimeMs };
  }

  // Distill-then-store: a NEW title creates a fresh note; the SAME title gets
  // a dated section appended, so revisions accumulate as readable history
  // instead of either being lost (overwrite) or spammed as new notes (append).
  function write({ title, body, tags, source } = {}) {
    if (!String(body || '').trim()) throw new Error('empty note body');
    const p = pathFor(title);
    const header = frontmatter({ tags, source });
    let text = header + String(body).trim() + '\n';
    if (existsSync(p)) {
      const prev = readFileSync(p, 'utf8');
      text = prev.replace(/\n*$/, '\n')
        + `\n## ${new Date().toISOString()}\n\n${String(body).trim()}\n`;
    }
    const tmp = p + '.tmp';
    writeFileSync(tmp, text, 'utf8');
    try { renameSync(tmp, p); } catch { writeFileSync(p, text, 'utf8'); }
    return { path: p, title: basename(p, MD), appended: existsSync(p) && text.length > header.length + body.length + 20 };
  }

  // Keyword search over the vault. Fine for a few thousand notes; a semantic
  // index would break the zero-dependency rule, so it stays out until there
  // is a real need (and then arrives as another backend, not a rewrite).
  function search(q, { limit = 8 } = {}) {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const out = [];
    for (const f of readdirSync(vault)) {
      if (extname(f).toLowerCase() !== MD) continue;
      let body = '';
      try { body = readFileSync(join(vault, f), 'utf8'); } catch { continue; }
      const lower = body.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (f.toLowerCase().includes(t)) score += 3;      // title hit weighs most
        const hits = lower.split(t).length - 1;
        score += hits;
      }
      if (!score) continue;
      // Snippet: first line containing any term, trimmed to a readable width.
      let snippet = '';
      for (const line of body.split('\n')) {
        const ll = line.toLowerCase();
        if (terms.some((t) => ll.includes(t))) { snippet = line.trim().slice(0, 160); break; }
      }
      out.push({ title: basename(f, MD), score, snippet, mtime: statSync(join(vault, f)).mtimeMs });
    }
    return out.sort((a, b) => b.score - a.score || b.mtime - a.mtime).slice(0, limit);
  }

  function recent(n = 10) {
    return readdirSync(vault)
      .filter((f) => extname(f).toLowerCase() === MD)
      .map((f) => {
        const p = join(vault, f);
        let title = basename(f, MD);
        try { title = parseFrontmatter(readFileSync(p, 'utf8')).title || title; } catch { /* keep filename */ }
        return { title, path: p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(1, Math.min(n, 100)));
  }

  // Deliberate deletion is an explicit, single-note operation - never a bulk
  // purge. The memory architecture forbids silent data loss.
  function remove(title) {
    const p = pathFor(title);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    return true;
  }

  return { backend: 'obsidian', vault, write, read, search, recent, remove };
}
