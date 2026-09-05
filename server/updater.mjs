// Self-update for a git-clone install: check GitHub releases, fast-forward
// the local clone, restart the process. Zero dependencies.
//
// Safety model (why not silent auto-update):
//   1. applyUpdate() refuses to touch a working tree with LOCAL modifications
//      (git status --porcelain -uno) - user edits are never overwritten.
//   2. The merge is --ff-only: a diverged clone is reported, never rebased
//      or force-resolved.
//   3. Restart is a detached wrapper that waits for the old process to
//      release the port; the pid lock in server.mjs absorbs any double-start
//      race with the tray watchdog.
import { execSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const REPO = 'zjl1989-li/Tmesh';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_MS = 5 * 60 * 1000;

let _cache = null;
let _cacheAt = 0;

function run(cmd, timeoutMs = 60000) {
  return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs, cwd: ROOT });
}

// Fresh read every call: after a pull the file itself changes.
export function getCurrentVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

// Numeric dotted-version compare: >0 if a newer, <0 if older, 0 equal.
// Tolerates a leading "v" and missing patch segments (1.2 == 1.2.0).
export function compareSemver(a, b) {
  const p = (s) => String(s || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [pa, pb] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Latest GitHub release vs the running build. Cached: the button may be
// clicked repeatedly and the API is rate-limited per IP.
export async function checkLatest() {
  if (_cache && Date.now() - _cacheAt < CACHE_MS) return _cache;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'Tmesh', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const j = await res.json();
  const current = getCurrentVersion();
  const out = {
    current,
    latest: j.tag_name || '',
    name: j.name || '',
    notes: j.body || '',
    url: j.html_url || '',
    publishedAt: j.published_at || '',
    isNewer: compareSemver(j.tag_name, current) > 0,
  };
  _cache = out;
  _cacheAt = Date.now();
  return out;
}

// Fast-forward the clone to origin/master. Never destructive: dirty trees
// and diverged history are refused with a code the UI can explain.
export function applyUpdate() {
  let status = '';
  try { status = run('git status --porcelain -uno').trim(); } catch (e) {
    return { ok: false, code: 'git-missing', message: String((e && e.message) || e) };
  }
  if (status) {
    return { ok: false, code: 'dirty', files: status.split('\n').map((s) => s.trim()).filter(Boolean) };
  }
  try { run('git fetch origin master'); } catch (e) {
    return { ok: false, code: 'network', message: 'git fetch failed (offline?) - manual: git pull' };
  }
  const behind = Number(run('git rev-list --count HEAD..origin/master').trim() || 0);
  if (!behind) return { ok: true, updated: false, reason: 'already-latest' };
  try { run('git merge --ff-only origin/master'); } catch {
    return { ok: false, code: 'diverged' };
  }
  return { ok: true, updated: true, version: getCurrentVersion(), needRestart: true };
}

// Detached wrapper: sleep past the old process's port release, then start a
// fresh copy. The old process exits on its own right after spawning this.
export function restartSelf() {
  const serverPath = join(__dirname, 'server.mjs');
  const boot = `setTimeout(function(){require('child_process').spawn(process.execPath,[${JSON.stringify(serverPath)}],{detached:true,stdio:'ignore',cwd:${JSON.stringify(ROOT)}}).unref()},2000)`;
  spawn(process.execPath, ['-e', boot], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  // Give the HTTP response a moment to flush, then die and free the port.
  setTimeout(() => process.exit(0), 400);
}
