// zjl-Achat backend: static server + REST + SSE + group coordinator.
// Zero dependencies, pure Node ESM. ASCII only.
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, renameSync, unlinkSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, relative, isAbsolute } from 'node:path';
import os from 'node:os';
import { store } from './store.mjs';
import { dispatch, probeAgent, isRunning, dropAdapter, runConsensus } from './bus.mjs';
import { getStatus, allStatus, onStatus, setStatus, abort } from './runtime.mjs';
import { describeProbe } from './adapters.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- single-instance lock (zero-dep) ---
// Tray launcher + a manual `node server/server.mjs` (or two launches with
// different PORT env values) could otherwise run concurrently and race on
// data.json writes. A pid lockfile makes the second instance exit early.
// Best-effort: if the lock cannot be written we still start (never brick).
const LOCK_FILE = join(__dirname, '.achat.lock');
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const prev = parseInt(readFileSync(LOCK_FILE, 'utf8'), 10);
      if (prev && prev !== process.pid) {
        try {
          process.kill(prev, 0);   // throws if the pid is not alive
          return false;            // another instance is truly running
        } catch { /* stale lock from a crashed process: take over */ }
      }
    }
    writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch { return true; }
}
function releaseLock() {
  try {
    if (parseInt(readFileSync(LOCK_FILE, 'utf8'), 10) === process.pid) unlinkSync(LOCK_FILE);
  } catch { /* ignore */ }
}
if (!acquireLock()) {
  console.error(`zjl-Achat is already running (pid lock: ${LOCK_FILE}). Exiting.`);
  process.exit(1);
}
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { releaseLock(); process.exit(0); });
}

// Load .env (optional, git-ignored) so CODEBUDDY_API_KEY etc. can live in a file
// instead of shell env. Zero-dep; never overrides an existing process.env value.
// ---------------- local agent discovery ----------------
// We cannot know what AI clients the user has installed, so we sniff common
// install locations + listening ports and return candidates they can onboard
// with one click. No external network calls; safe to run on every open.
async function portOpen(port, timeout = 350) {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(`http://127.0.0.1:${port}`, { method: 'GET', signal: ctrl.signal });
    clearTimeout(tid);
    return r.status < 600;
  } catch { return false; }
}
function homeDir() { return os.homedir(); }
function localAppData() { return process.env.LOCALAPPDATA || join(homeDir(), 'AppData', 'Local'); }
function programDirs() {
  return [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], join(localAppData(), 'Programs')].filter(Boolean);
}

// Codex desktop app (OpenAI 官方 Windows 版，微软商店分发) has no fixed install
// path and the store-apps dir is versioned, so resolve candidates dynamically.
// Stable anchors: the version-independent MSIX package dir + roaming config.
function codexInstallPaths() {
  const base = localAppData();
  const out = [];
  const pkg = join(base, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0');
  if (existsSync(pkg)) out.push(pkg);
  const storeApps = join(base, 'codex-plusplus', 'store-apps');
  try {
    for (const e of readdirSync(storeApps)) {
      if (e.startsWith('OpenAI.Codex_')) out.push(join(storeApps, e));
    }
  } catch { /* no store-apps dir */ }
  const roam = join(homeDir(), 'AppData', 'Roaming', 'Codex');
  if (existsSync(roam)) out.push(roam);
  return out;
}

// Known products: install paths + a prefill config builder. detection = running/installed/none.
const KNOWN_AGENTS = [
  {
    key: 'dsh', name: 'DeepSeek Harness (DSH)', brand: 'deepseek', suggestedType: 'A',
    paths: [
      'D:/Tools/DSHDesktop/app', 'D:/Projects/dsh-deploy', 'D:/DSHHome',
      join(localAppData(), 'Programs', 'DSHDesktop', 'app'), join(localAppData(), 'DSHDesktop'),
    ],
    ports: [3080],
    prefill: () => ({ ports: [3080] }),
    notes: '自带 HTTP RPC 的本地 agent（工具+技能），接入即用。',
  },
  {
    key: 'workbuddy', name: 'WorkBuddy / CodeBuddy', brand: 'workbuddy', suggestedType: 'W',
    paths: [join(localAppData(), 'Programs', 'WorkBuddy'), 'C:/Program Files/WorkBuddy', join(localAppData(), 'Programs', 'CodeBuddy')],
    ports: [],
    prefill: (found) => {
      let cliPath = '';
      for (const base of found.paths) {
        const cli = join(base, 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy');
        if (existsSync(cli)) { cliPath = cli; break; }
      }
      return { cliPath, apiKeyEnv: 'CODEBUDDY_API_KEY' };
    },
    notes: '闭源桌面 AI。有官方 API Key 走稳定 CLI 通路；没有则自动探测 ACP 端口。',
  },
  {
    key: 'ollama', name: 'Ollama', brand: 'ollama', suggestedType: 'B',
    paths: [join(localAppData(), 'Ollama'), 'C:/Program Files/Ollama'],
    ports: [11434],
    prefill: () => ({ model: 'ollama', baseURL: 'http://127.0.0.1:11434', apiKey: 'ollama' }),
    notes: '本地模型服务（OpenAI 兼容 API），可作为群内模型成员。',
  },
  {
    key: 'lmstudio', name: 'LM Studio', brand: 'lmstudio', suggestedType: 'B',
    paths: [join(localAppData(), 'LM Studio'), 'C:/Program Files/LM Studio'],
    ports: [1234],
    prefill: () => ({ model: 'local-model', baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'lmstudio' }),
    notes: '本地模型服务（OpenAI 兼容 /v1）。',
  },
  {
    key: 'doubao', name: '豆包 (Doubao)', brand: 'doubao', suggestedType: 'D',
    paths: [join(localAppData(), 'Doubao'), join(localAppData(), 'Programs', 'Doubao'), 'C:/Program Files/Doubao'],
    ports: [],
    prefill: (found) => ({ bridge: 'doubao', launcherExe: findMainExe(found.paths, 'doubao') }),
    notes: '闭源桌面 AI，无入站 API；启动器开关直接拉起/关闭桌面程序本身。',
  },
  {
    key: 'qwen', name: '通义千问 / 通义灵码', brand: 'qwen', suggestedType: 'D',
    paths: [join(localAppData(), 'Programs', 'Tongyi'), join(localAppData(), 'qwen'), 'C:/Program Files/Qwen'],
    ports: [],
    prefill: (found) => ({ bridge: 'qwen', launcherExe: findMainExe(found.paths, 'qwen') }),
    notes: '闭源桌面 AI，无入站 API；启动器开关直接拉起/关闭桌面程序本身。',
  },
  {
    key: 'kuaishou', name: '夸克 AI', brand: 'kuaishou', suggestedType: 'D',
    paths: [join(localAppData(), 'Programs', 'Kuake'), join(localAppData(), 'Kuake'), 'C:/Program Files/Kuake'],
    ports: [],
    prefill: (found) => ({ bridge: 'kuaishou', launcherExe: findMainExe(found.paths, 'kuaishou|quark|kuake') }),
    notes: '闭源桌面 AI，无入站 API；启动器开关直接拉起/关闭桌面程序本身。',
  },
  {
    key: 'codex', name: 'Codex (OpenAI)', brand: 'codex', suggestedType: 'D',
    paths: codexInstallPaths(),
    ports: [],
    prefill: (found) => ({ bridge: 'codex', launcherExe: findMainExe(found.paths, 'codex') }),
    // Foreign agents must choose how they reach a model; the three answers spawn
    // different chains (see autoLauncher / launchAgent):
    //   cli      -> per-turn `codex exec` (G class), model/proxy from ~/.codex/config.toml
    //   official -> straight to the app's own service (user's own account)
    //   proxy    -> chosen proxy software first (see PROXY_APPS), app after ready
    connect: {
      port: 57321,
      modes: [
        { key: 'cli', label: 'CLI 直连（codex exec）', desc: '每条消息跑一轮 codex exec，模型与代理由 ~/.codex/config.toml 决定（codex++ 本地代理）' },
        { key: 'official', label: '官方账号直连', desc: '用你自己的官方账号，直接拉起 Codex 主程序静默运行' },
        { key: 'proxy', label: '国内代理接入', desc: '先拉起选定的代理软件，就绪后再静默运行 Codex' },
      ],
    },
    notes: 'OpenAI Codex 桌面版。推荐 CLI 直连（走 ~/.codex/config.toml 配好的模型与代理）；也可官方直连或经代理拉起主程序。',
  },
];

// Keyword scan of install dirs to catch AI clients we did not hard-code.
const SCAN_KEYWORDS = {
  dsh: 'dsh', workbuddy: 'workbuddy', codebuddy: 'codebuddy', doubao: 'doubao',
  ollama: 'ollama', 'lm studio': 'lmstudio', qwen: 'qwen', tongyi: 'tongyi',
  kuaishou: 'kuaishou', kuake: 'kuake', deepseek: 'dsh', codex: 'codex',
};

// Brand fallback avatars (small inline SVGs) for local agents whose install
// dir exposes no usable icon file. The real app icon wins whenever we can read
// one; this only kicks in for e.g. DSH (icon lives inside the exe) or Codex
// (only an Electron default_app icon is present).
const BRAND_ICONS = {
  dsh: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#4D6BFE"/><path d="M21 45c1-9 6-15 14-15 4 0 8 2 10 5-1-6-5-10-11-10-8 0-14 7-14 14v6z" fill="#fff"/><circle cx="26" cy="40" r="2.4" fill="#4D6BFE"/><path d="M36 30l9-7-3 10z" fill="#fff"/></svg>'),
  deepseek: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#4D6BFE"/><path d="M21 45c1-9 6-15 14-15 4 0 8 2 10 5-1-6-5-10-11-10-8 0-14 7-14 14v6z" fill="#fff"/><circle cx="26" cy="40" r="2.4" fill="#4D6BFE"/><path d="M36 30l9-7-3 10z" fill="#fff"/></svg>'),
  codex: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#111827"/><path d="M32 15l5 12 12 5-12 5-5 12-5-12-12-5 12-5z" fill="#fff"/></svg>'),
};

// ---- desktop-shortcut icon extraction (Windows) ----
// The most faithful "its own avatar" for a local agent is the icon of the app
// it launches. Install dirs don't always contain a usable icon file (DSH keeps
// its icon inside the exe; Codex ships only an Electron default_app icon), but
// the desktop/start-menu shortcuts always point at the real binary, so we
// resolve the shortcut target and pull the icon out of it via PowerShell.
let shortcutCache = null;
const iconCache = new Map(); // exe path -> data url (kept for the process lifetime)
function psCmd(cmd) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(out.trim()));
    setTimeout(() => { try { p.kill(); } catch { /* done */ } }, 9000);
  });
}
async function allShortcuts() {
  if (shortcutCache) return shortcutCache;
  const script = `
$ErrorActionPreference='SilentlyContinue'
$sh=New-Object -ComObject WScript.Shell
$dirs=@([Environment]::GetFolderPath('Desktop'),"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs","$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")
$out=@()
foreach($d in $dirs){ Get-ChildItem $d -Filter *.lnk -Recurse | ForEach-Object { try { $l=$sh.CreateShortcut($_.FullName); if($l.TargetPath){ $out += [pscustomobject]@{N=$_.BaseName; T=$l.TargetPath; I=$l.IconLocation} } } catch {} } }
$out | ConvertTo-Json -Compress`;
  const json = await psCmd(script);
  shortcutCache = (() => { try { return JSON.parse(json); } catch { return []; } })();
  return shortcutCache;
}
function readImageDataUrl(full) {
  try {
    const st = statSync(full);
    if (!st.isFile() || st.size < 50 || st.size > 250000) return null;
    const buf = readFileSync(full);
    const mime = /\.png$/i.test(full) ? 'image/png' : /\.webp$/i.test(full) ? 'image/webp' : 'image/x-icon';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch { return null; }
}
async function extractExeIcon(exePath) {
  if (iconCache.has(exePath)) return iconCache.get(exePath);
  const esc = String(exePath).replace(/'/g, "''");
  const script = `Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Icon]::ExtractAssociatedIcon('${esc}'); if($i){$ms=New-Object System.IO.MemoryStream; $i.ToBitmap().Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray())}`;
  const b64 = await psCmd(script);
  const url = b64 ? 'data:image/png;base64,' + b64 : null;
  iconCache.set(exePath, url);
  return url;
}
const BRAND_KEYWORDS = {
  dsh: ['dsh', 'deepseek'], deepseek: ['dsh', 'deepseek'], codex: ['codex'], workbuddy: ['workbuddy', 'codebuddy'],
  doubao: ['doubao', '豆包'], ollama: ['ollama'], qwen: ['qwen', 'tongyi', '通义'],
  kuaishou: ['kuaishou', '夸克'], lmstudio: ['lm studio'],
};
async function shortcutIconFor(brand) {
  const kws = BRAND_KEYWORDS[brand] || [brand];
  const list = await allShortcuts();
  const hits = list.filter((s) => {
    const clean = String(s.N || '').toLowerCase().replace(/卸载|uninstall|管理|manager|helper/g, '');
    return kws.some((k) => clean.includes(String(k).toLowerCase()));
  }).sort((a, b) => String(a.N).length - String(b.N).length);
  for (const h of hits) {
    const raw = String(h.I || h.T || '').split(',')[0].trim();
    if (!raw || !existsSync(raw)) continue;
    if (/\.(ico|png|webp)$/i.test(raw)) { const hit = readImageDataUrl(raw); if (hit) return hit; }
    if (/\.exe$/i.test(raw)) { const hit = await extractExeIcon(raw); if (hit) return hit; }
  }
  return null;
}

// Recover the agent's OWN app icon from its install dir, so an onboarded agent
// starts with its real avatar instead of a colored initial. Depth-limited walk,
// only small icon-looking image files, capped size so the base64 stored in
// data.json stays sane. Returns a data: URL or null.
function findAppIcon(paths) {
  const isIcon = (n) => {
    const low = n.toLowerCase();
    if (!/\.(png|webp|ico)$/.test(low)) return false;
    return low.startsWith('icon') || low.startsWith('logo') || low.startsWith('app') || low.includes('favicon');
  };
  const walk = (dir, depth) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return null; }
    for (const n of names) {
      if (!isIcon(n)) continue;
      const full = join(dir, n);
      try {
        const st = statSync(full);
        if (!st.isFile() || st.size < 50) continue;
        // skip the tiny tray glyphs and the Electron placeholder icon
        if (/\.ico$/i.test(n) && st.size < 30000) continue;
        if (st.size > 250000) continue;
        const buf = readFileSync(full);
        const mime = /\.png$/i.test(n) ? 'image/png' : /\.webp$/i.test(n) ? 'image/webp' : 'image/x-icon';
        return 'data:' + mime + ';base64,' + buf.toString('base64');
      } catch {}
    }
    if (depth <= 0) return null;
    for (const n of names) {
      if (n.startsWith('.') || /node_modules/i.test(n) || /default_app/i.test(n)) continue;
      const full = join(dir, n);
      try { if (statSync(full).isDirectory()) { const hit = walk(full, depth - 1); if (hit) return hit; } } catch {}
    }
    return null;
  };
  for (const base of paths) { const hit = walk(base, 4); if (hit) return hit; }
  return null;
}

// Find the agent's main desktop exe - the thing the launcher switch should
// start. Depth-limited walk; helper/proxy/uninstall exes are excluded and a
// brand-name match wins, so "Doubao.exe" beats "Doubao_proxy.exe".
function findMainExe(paths, brand) {
  const BAD = /uninstall|unins|proxy|helper|crash|setup|update|squirrel|elevation|tracing|notification|pwa/i;
  const NAME = new RegExp(brand, 'i');
  let best = null;
  const walk = (dir, depth) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (!/\.exe$/i.test(n) || BAD.test(n)) continue;
      const full = join(dir, n);
      let size = 0;
      try { size = statSync(full).size; } catch { continue; }
      if (size < 500000) continue; // the real app is megabytes; glue exes are tiny
      const score = (NAME.test(n) ? 4 : 0) + (depth === 0 ? 2 : depth === 1 ? 1 : 0);
      if (!best || score > best.score) best = { full, score };
    }
    if (depth <= 0) return;
    for (const n of names) {
      if (/^(resources|node_modules|locales|bin)$/i.test(n)) continue;
      const full = join(dir, n);
      try { if (statSync(full).isDirectory()) walk(full, depth - 1); } catch { /* ignore */ }
    }
  };
  for (const p of paths) walk(p, 2);
  return best && best.score > 0 ? best.full : null;
}

// DSH ships its real service as a node CLI inside the desktop install. When it
// exists the launcher can run the agent headless instead of popping a window.
function findDshBin() {
  const dsh = KNOWN_AGENTS.find((k) => k.key === 'dsh');
  for (const base of (dsh ? dsh.paths : [])) {
    const p = join(base, 'resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (existsSync(p)) return p;
  }
  return null;
}

// CC Switch hosts a local model proxy that codex/claude configs can point at
// for domestic-model access. One of several proxy software candidates.
function findCcSwitchExe() {
  const p = join(localAppData(), 'Programs', 'CC Switch', 'cc-switch.exe');
  return existsSync(p) ? p : null;
}
// Codex++ = the MSIX Codex desktop app itself; its domestic-model proxy lives
// INSIDE the app (57321 opens only while the app runs), so the proxy launch
// target and the agent main program are the same exe.
function codexAppExe() {
  const tpl = KNOWN_AGENTS.find((k) => k.key === 'codex');
  const paths = (tpl ? tpl.paths : []).filter((p) => existsSync(p));
  return findMainExe(paths, 'codex');
}
// Proxy software registry: what can carry a foreign agent to a domestic model.
// Discovered at onboarding; when several are installed the wizard asks which
// one to use, and the choice is stored in agent config (config.proxyApp) so
// later launches follow the same chain without asking again.
const PROXY_APPS = [
  {
    key: 'codexpp', name: 'Codex++（商店版自带代理）', brands: ['codex'], port: 57321,
    exe: codexAppExe, selfHosted: true, // proxy lives inside the agent app
  },
  {
    key: 'cc-switch', name: 'CC Switch（独立代理）', brands: ['codex', 'claude'], port: 57321,
    exe: findCcSwitchExe, selfHosted: false,
  },
];
function proxyAppsFor(brand) {
  return PROXY_APPS
    .filter((p) => p.brands.includes(brand) && p.exe())
    .map((p) => ({ key: p.key, name: p.name, port: p.port, selfHosted: !!p.selfHosted, exe: p.exe() }));
}
function resolveProxyApp(brand, preferred) {
  const cands = proxyAppsFor(brand);
  if (preferred) return cands.find((p) => p.key === preferred) || cands[0] || null;
  return cands[0] || null;
}
// Launch a GUI app minimized (taskbar only, no main window pops up). cmd's
// start needs an empty quoted title before the exe; node quotes each array
// element, so the '' element becomes "" and paths with spaces stay intact.
// Deliberately NOT powershell: sandbox/host environments may kill node
// process trees that shell out to powershell.
function spawnDetachedMin(exe, args, opts = {}) {
  return spawn('cmd.exe', ['/d', '/c', 'start', '/min', '', exe, ...args], {
    detached: true, stdio: 'ignore', windowsHide: true, ...opts,
  });
}

// Auto-select the launcher at onboarding time, so the settings switch always
// has something real to start/stop (no dead controls):
//   A (local agent service) -> DSH's own node service, headless
//   C (file bridge)         -> bridge monitor + per-task agent entry
//   D (desktop app)         -> the app's own exe; the "service" IS the app
//   B / W / E (cloud/API/CLI/MCP) -> no local process to own, no launcher.
function autoLauncher(a) {
  const t = a.adapterType || (a.config && a.config.adapterType);
  const cfg = a.config || {};
  if (t === 'A') {
    const bin = findDshBin();
    if (!bin) return null;
    // bin.js sits at <install>/resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js;
    // four dirnames up from lib/ is node_modules - the NODE_PATH the service needs.
    const nm = dirname(dirname(dirname(dirname(bin))));
    const env = { NODE_PATH: nm };
    if (existsSync('D:/DSHHome')) env.DSH_HOME = 'D:/DSHHome';
    return {
      enabled: false, service: process.execPath,
      serviceArgs: [bin, '--profile', 'web'],
      cwd: 'D:/Projects', env, monitor: null,
    };
  }
  if (t === 'C') {
    if (!cfg.localDir) return null;
    return {
      enabled: false, transport: 'file-pipe', service: null, serviceArgs: [],
      headless: true, monitor: 'scripts/bridge-monitor.mjs', agentEntry: 'scripts/demo-agent.mjs',
    };
  }
  if (t === 'D') {
    // Agents onboarded before exe auto-detection have no launcherExe stored;
    // re-resolve it from the discovery template matching config.bridge.
    let exe = cfg.launcherExe;
    if (!exe) {
      const tpl = KNOWN_AGENTS.find((k) => k.key === cfg.bridge);
      if (tpl) exe = findMainExe(tpl.paths.filter((p) => existsSync(p)), tpl.brand);
    }
    if (!exe) return null;
    const la = { enabled: false, service: exe, serviceArgs: [], headless: false, monitor: null };
    // Foreign agent via domestic proxy: the proxy must be up BEFORE the app,
    // or the app starts against a dead endpoint. The proxy software is whatever
    // the user picked at onboarding (config.proxyApp); no stored pick means the
    // first detected candidate (pre-wizard agents keep working as configured).
    const tpl = KNOWN_AGENTS.find((k) => k.key === cfg.bridge);
    const mode = cfg.connectMode || (tpl && tpl.connect ? 'proxy' : null);
    if (mode === 'proxy' && tpl && tpl.connect) {
      const papp = resolveProxyApp(cfg.bridge, cfg.proxyApp);
      if (papp) {
        la.proxy = {
          key: papp.key, service: papp.exe, serviceArgs: [],
          port: papp.port, selfHosted: papp.selfHosted,
        };
      }
    }
    return la;
  }
  return null;
}

// Fill in a launcher for local-capable agents that lack one. Runs at boot and
// after every create, so a fresh onboarded agent gets its switch for free and
// the fill survives restarts. D-class launchers are regenerated when the proxy
// chain changed after they were first generated (missing proxy, or the user
// picked a different proxy software at onboarding — config.proxyApp).
function ensureLauncher(a) {
  if (!a || !a.config) return a;
  const have = a.config.launcher;
  if (have) {
    const t = a.adapterType || a.config.adapterType;
    const tpl = KNOWN_AGENTS.find((k) => k.key === a.config.bridge);
    const wantsProxy = t === 'D' && tpl && tpl.connect && a.config.connectMode !== 'official';
    const proxyMissing = wantsProxy && !have.proxy;
    // Old-format proxy blocks (pre-registry) lack a key — regenerate so the
    // stored pick (or the first detected candidate) takes over.
    const proxyStale = wantsProxy && have.proxy
      && (!have.proxy.key || (a.config.proxyApp && have.proxy.key !== a.config.proxyApp));
    if (!proxyMissing && !proxyStale) return a;
  }
  const la = autoLauncher(a);
  if (!la) return a;
  a.config.launcher = la;
  store.upsertAgent(a);
  console.log(`[launcher] ${have ? 'upgraded' : 'auto-configured'} for ${a.id} (${a.adapterType})`);
  return a;
}

async function discoverLocalAgents() {
  const results = [];
  for (const tpl of KNOWN_AGENTS) {
    const foundPaths = tpl.paths.filter((p) => existsSync(p));
    let running = false;
    if (tpl.ports.length) {
      for (const port of tpl.ports) { if (await portOpen(port)) { running = true; break; } }
    }
    const detection = running ? 'running' : (foundPaths.length ? 'installed' : 'none');
    if (detection === 'none') continue;
    results.push({
      key: tpl.key, name: tpl.name, brand: tpl.brand,
      suggestedType: tpl.suggestedType, detection, running,
      avatar: findAppIcon(foundPaths) || await shortcutIconFor(tpl.brand) || BRAND_ICONS[tpl.brand] || null,
      paths: foundPaths, prefill: tpl.prefill({ paths: foundPaths }), notes: tpl.notes,
      // connect-mode question for foreign agents (null for the rest); the
      // proxyApps list is what the wizard offers when several are installed
      connect: tpl.connect
        ? {
            port: tpl.connect.port,
            modes: tpl.connect.modes.map((m) => ({ key: m.key, label: m.label, desc: m.desc })),
            proxyApps: proxyAppsFor(tpl.key),
          }
        : null,
    });
  }
  const seenKeys = new Set(results.map((r) => r.key));
  for (const base of programDirs()) {
    let entries = [];
    try { entries = readdirSync(base); } catch { continue; }
    for (const name of entries) {
      const lower = name.toLowerCase();
      let matched = null;
      for (const [kw, key] of Object.entries(SCAN_KEYWORDS)) {
        if (lower.includes(kw)) { matched = key; break; }
      }
      if (matched && !seenKeys.has(matched)) {
        results.push({
          key: 'scan-' + matched + '-' + results.length, name, brand: matched,
          suggestedType: matched === 'dsh' ? 'A' : (matched === 'ollama' || matched === 'lmstudio') ? 'B' : 'D',
          detection: 'installed', running: false, avatar: findAppIcon([join(base, name)]) || await shortcutIconFor(matched) || BRAND_ICONS[matched] || null,
          paths: [join(base, name)],
          prefill: {}, notes: `在 ${base} 发现，建议按对应类型接入。`,
        });
        seenKeys.add(matched);
      }
    }
  }
  return results;
}

function loadDotEnv() {
  const p = join(__dirname, '..', '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const k = m[1], v = m[2].replace(/^["']|["']$/g, '');
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();

const PUBLIC = join(__dirname, '..', 'public');
const SPACE_DIR = join(__dirname, 'space');
mkdirSync(SPACE_DIR, { recursive: true });
// 全局归档目录：完结归档的群会把历史记录快照到这里，群列表的归档文件夹
// 按钮一键打开它。
const ARCHIVE_DIR = join(__dirname, 'archive');
mkdirSync(ARCHIVE_DIR, { recursive: true });
const PORT = process.env.PORT || 8787;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};

// ---- SSE clients: convId -> Set(res) ----
const clients = new Map();

// ---- launched local agents: agentId -> { monitor, service, startedAt } ----
// Populated by POST /api/agents/:id/launch (the in-group "启动" switch). The
// bridge here is a DUMB shuttle: achat owns the process lifecycle, the agent
// owns the brain. No LLM is ever spent on achat's side.
const launched = new Map();
const ROOT = join(__dirname, '..');
function killPidIfAlive(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

// Spawn the dumb monitor as a detached, silent, headless child. If it dies
// unexpectedly (crash, not an explicit stop), relaunch it after a short delay
// so the agent keeps serving in the background without human babysitting.
// This is what makes the "后台静默运行" promise actually hold.
function spawnMonitor(agent, cfg) {
  const mon = spawn(process.execPath, [join(ROOT, cfg.monitor || 'scripts/bridge-monitor.mjs'), '--agent', agent.id], {
    detached: true, stdio: 'ignore', cwd: ROOT, env: process.env, windowsHide: true,
  });
  mon.on('exit', (code, sig) => {
    const rec = launched.get(agent.id);
    if (!rec || rec.monitor !== mon || rec.stopping) return; // stopped on purpose, ignore
    console.log(`[launcher] monitor for ${agent.id} exited (code=${code} sig=${sig}); relaunching in 2s`);
    setTimeout(() => {
      const r = launched.get(agent.id);
      if (r && !r.stopping) r.monitor = spawnMonitor(agent, cfg);
    }, 2000);
  });
  return mon;
}

// ---- generic launcher switch (M2): one on/off per agent, lifecycle-owned ----
// Driven by config.launcher.enabled. "on" => spawn the agent's own service
// headless + optional monitor; "off" => kill both. This is the ONLY place that
// spawns local agent processes; adapters only probe, they never spawn.
async function launchAgent(agent) {
  if (launched.has(agent.id)) {
    return { launched: true, note: '已在运行', monitorPid: launched.get(agent.id).monitor?.pid ?? null };
  }
  const cfg = agent.config && agent.config.launcher;
  // `enabled` only gates the boot-time autostart. An explicit click is the user
  // asking for it right now, so don't let the persisted flag block it.
  if (!cfg) {
    return { launched: false, note: '云端/CLI/MCP 类 agent 没有本地服务可拉起，探活照常' };
  }
  // Port-based agents (A class) may already be running because the user started
  // them by hand. Adopt instead of spawning a duplicate against a busy port.
  if (Array.isArray(agent.config.ports) && agent.config.ports.length) {
    for (const p of agent.config.ports) {
      if (!(await portOpen(p))) continue;
      launched.set(agent.id, { monitor: null, service: null, startedAt: Date.now(), adopted: true, stopping: false });
      setStatus(agent.id, { state: 'idle' });
      return { launched: true, name: agent.name, adopted: true, note: '服务已在运行（外部启动），已接管状态；关闭开关只解除接管，不会杀外部进程' };
    }
  }
  // Kill any orphaned monitor from a previous server boot (pidfile guard).
  try {
    const pidPath = join(ROOT, agent.config.localDir, 'monitor.pid');
    if (existsSync(pidPath)) killPidIfAlive(Number(readFileSync(pidPath, 'utf8').trim()));
  } catch { /* ignore */ }
  // Proxy-mode launch chain (foreign agent via domestic model proxy): start the
  // proxy first and wait for its port, so the app never boots against a dead
  // endpoint. selfHosted proxies (e.g. Codex++: the proxy lives inside the app)
  // make the proxy spawn BE the main program — no second spawn. If the port is
  // already open we adopt instead of duplicating anything.
  let proxyProc = null;
  let serviceProc = null;
  let adopted = false;
  const notes = [];
  // GUI apps (D class, headless:false) start minimized so they run silently;
  // console services (node etc.) keep the plain headless spawn.
  const spawnApp = cfg.headless === false ? spawnDetachedMin : spawn;
  if (cfg.proxy && cfg.proxy.service) {
    const port = cfg.proxy.port;
    const selfHosted = !!cfg.proxy.selfHosted;
    if (await portOpen(port)) {
      if (selfHosted) {
        // The app itself is already running (port open) — take over, spawn nothing.
        launched.set(agent.id, { monitor: null, service: null, proxy: null, startedAt: Date.now(), adopted: true, stopping: false });
        setStatus(agent.id, { state: 'idle' });
        return { launched: true, name: agent.name, adopted: true, note: `${cfg.proxy.key} 已在运行（端口 ${port} 就绪），已接管；关闭开关只解除接管，不杀外部进程` };
      }
      notes.push('代理已在运行（外部启动），直接复用');
    } else {
      proxyProc = spawnApp(cfg.proxy.service, cfg.proxy.serviceArgs || [], { windowsHide: true });
      const deadline = Date.now() + 15000;
      let ready = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (await portOpen(port)) { ready = true; break; }
      }
      notes.push(ready ? `代理（${cfg.proxy.key}）已就绪（端口 ${port}）` : `代理端口 ${port} 15 秒内未就绪，仍继续拉起主程序`);
      if (selfHosted) serviceProc = proxyProc; // the app IS the proxy; no second spawn
    }
  }
  // Optional: the agent's OWN long-running service, launched headless.
  // cfg.env (if any) is merged in so services like DSH can find their module
  // path / home without a login shell.
  if (cfg.service && !serviceProc) {
    serviceProc = spawnApp(cfg.service, cfg.serviceArgs || [], {
      cwd: cfg.cwd || ROOT,
      env: { ...process.env, ...(cfg.env || {}) }, windowsHide: true,
    });
  }
  // The dumb shuttle (file-bridge monitor) is only for C-class agents that
  // need inbox/outbox polling. A-class HTTP agents (DSH) have no monitor.
  const monitor = cfg.monitor ? spawnMonitor(agent, cfg) : null;
  launched.set(agent.id, { monitor, service: serviceProc, proxy: selfProxyOnly(cfg, proxyProc, serviceProc), startedAt: Date.now(), adopted, stopping: false });
  setStatus(agent.id, { state: 'idle' }); // online + running
  const base = cfg.proxy
    ? (cfg.proxy.selfHosted
        ? '已按「国内代理」链路静默拉起（代理内置于主程序，主窗口已隐藏）'
        : '已按「国内代理」链路静默拉起：代理 -> 主程序，主窗口已隐藏')
    : '已静默拉起本地 agent 服务（无主窗口、零 LLM 成本）';
  return {
    launched: true, name: agent.name,
    monitorPid: monitor ? monitor.pid : null,
    servicePid: serviceProc ? serviceProc.pid : null,
    note: [base, ...notes].filter(Boolean).join('；'),
  };
}
// stopAgent must kill the proxy process only when it is a SEPARATE program.
// For selfHosted chains the proxy process IS the service, already recorded in
// rec.service — recording it again would double-kill the same pid (harmless but
// confusing), so park null here.
function selfProxyOnly(cfg, proxyProc, serviceProc) {
  return cfg.proxy && !cfg.proxy.selfHosted ? proxyProc : null;
}
async function stopAgent(agent) {
  const rec = launched.get(agent.id);
  if (!rec) return { stopped: false, note: '未在运行' };
  rec.stopping = true; // tell the self-heal handler not to relaunch
  if (rec.monitor) try { rec.monitor.kill('SIGKILL'); } catch { /* ignore */ }
  if (rec.service) try { rec.service.kill('SIGKILL'); } catch { /* ignore */ }
  // Only kill the proxy if we spawned it; an externally started one is not ours.
  if (rec.proxy) try { rec.proxy.kill('SIGKILL'); } catch { /* ignore */ }
  launched.delete(agent.id);
  setStatus(agent.id, { state: 'offline' });
  return { stopped: true, name: agent.name, note: rec.adopted ? '已解除接管（外部启动的进程保持原样）' : '' };
}
// Bring up every agent whose launcher switch is ON on server boot, so the group
// is ready without manual clicks. Fire-and-forget: failures are logged, never fatal.
async function autoLaunchEnabled() {
  for (const a of store.getAgents()) {
    const cfg = a.config && a.config.launcher;
    if (!cfg || !cfg.enabled || launched.has(a.id)) continue;
    try {
      const r = await launchAgent(a);
      console.log(`[launcher] auto-started ${a.id}: ${r.note || 'ok'}`);
    } catch (e) {
      console.error(`[launcher] auto-start ${a.id} failed: ${e.message}`);
    }
  }
}
function subscribe(convId, res) {
  if (!clients.has(convId)) clients.set(convId, new Set());
  clients.get(convId).add(res);
  res.on('close', () => clients.get(convId)?.delete(res));
}
function broadcast(convId, event, data) {
  const set = clients.get(convId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
}

// ---- helpers ----
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
  });
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function findArtifact(c, aid) {
  return (c.artifacts || []).find((a) => a.id === aid);
}
// 在系统文件管理器里打开文件或文件夹（Windows 用 explorer，其他用 xdg-open）。
// Returns false when the spawn itself failed so the API can surface it instead
// of toasting success while nothing opened.
function revealPath(p) {
  if (!p) return false;
  try {
    if (process.platform === 'win32') {
      if (existsSync(p) && statSync(p).isFile()) spawn('explorer', ['/select,', p], { windowsHide: true });
      else { mkdirSync(p, { recursive: true }); spawn('explorer', [p], { windowsHide: true }); }
      return true;
    }
    spawn('xdg-open', [p], { detached: true, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// ---- 群聊历史（上下文） ----
// 把群内从建群到现在的全部对话 + 产物，按日期生成为 markdown 历史文件，
// 落在 <space>/<groupId>/history/YYYY-MM-DD.md。agent 失忆或中途新入群时
// 可以直接在这里通读全程。内容变化才重写，避免每次打开都刷盘。
function localDateKey(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function localTimeKey(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function agentName(id) {
  const a = store.getAgents().find((x) => x.id === id);
  return a ? (a.name || id) : id;
}
function buildHistoryMd(c) {
  const byDay = new Map();
  for (const m of c.messages || []) {
    const k = localDateKey(m.ts); if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(m);
  }
  const artByDay = new Map();
  for (const a of c.artifacts || []) {
    const k = localDateKey(a.ts); if (!artByDay.has(k)) artByDay.set(k, []);
    artByDay.get(k).push(a);
  }
  const days = [...new Set([...byDay.keys(), ...artByDay.keys()])].sort();
  const dir = join(SPACE_DIR, c.id, 'history');
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const day of days) {
    const msgs = byDay.get(day) || [];
    const arts = artByDay.get(day) || [];
    const L = [];
    L.push(`# 群聊历史 · ${day}`);
    L.push('');
    L.push(`> 群：${c.name || '(未命名)'} · 消息 ${msgs.length} 条 · 产物 ${arts.length} 个`);
    L.push('');
    for (const m of msgs) {
      const t = localTimeKey(m.ts);
      const body = (m.text || '').trim() || '（空消息）';
      if (m.sender === 'user') {
        L.push(`## ${t} · 我`); L.push(''); L.push(body); L.push('');
      } else if (m.sender === 'system') {
        const k = m.meta && m.meta.consensus ? (m.meta.kind === 'round' ? '协商' : '协商结论') : '系统';
        L.push(`### ${t} · ${k}`); L.push(''); L.push(body); L.push('');
      } else {
        L.push(`### ${t} · ${agentName(m.agentId)}`); L.push(''); L.push(body); L.push('');
        if (m.thinking && m.thinking.length) {
          L.push('**思考 / 工具调用：**'); L.push('');
          for (const ev of m.thinking) {
            if (ev.kind === 'step') L.push(`- 步骤 ${ev.step}`);
            else if (ev.kind === 'tool_call') L.push(`- 工具 \`${ev.name}\`${ev.detail ? `：${ev.detail}` : ''}`);
          }
          L.push('');
        }
      }
    }
    if (arts.length) {
      L.push('---'); L.push('');
      L.push('### 当日产物'); L.push('');
      for (const a of arts) {
        const ow = a.ownerId === 'user' ? '我' : agentName(a.ownerId);
        L.push(`- **${a.name}**（${a.kind} · ${ow}）${a.src ? ` \`${a.src}\`` : ''}`);
      }
      L.push('');
    }
    const md = L.join('\n').trimEnd() + '\n';
    const f = join(dir, day + '.md');
    if (!existsSync(f) || readFileSync(f, 'utf8') !== md) writeFileSync(f, md);
    files.push({ date: day, msgs: msgs.length, arts: arts.length, size: md.length, path: f });
  }
  return files;
}

// Image / video extensions -> canonical kind. Uploads and auto-captured paths
// used to trust whatever kind the caller claimed, so a .png uploaded through
// the "file" menu landed in the file tab and its preview hit the unsupported
// branch. The extension is ground truth; the claimed kind is only a fallback.
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
const VID_RE = /\.(mp4|webm|mov|mkv|avi)$/i;
const AUD_RE = /\.(mp3|wav|m4a|ogg|flac|aac)$/i;
function normalizeKind(name, claimed) {
  if (IMG_RE.test(name)) return 'image';
  if (VID_RE.test(name)) return 'video';
  if (AUD_RE.test(name)) return 'audio';
  return claimed || 'file';
}

// ---- agent liveness: heartbeat probe every 20s ----
const PROBE_MS = 20000;
let probing = false;
async function probeAll() {
  if (probing) return;          // keep probes serial, DSH scans cost seconds
  probing = true;
  try {
    for (const a of store.getAgents()) {
      if (isRunning(a.id)) continue;         // busy agents stay red
      const alive = await probeAgent(a);
      if (!alive) { setStatus(a.id, { state: 'offline' }); continue; }
      // A failed turn has to stay visible: without this the 20s heartbeat
      // repaints a yellow light green before anyone has noticed it. Offline
      // still wins - being unreachable matters more than the last error.
      if (getStatus(a.id).state === 'error') continue;
      // Same reason as error, and more so: an unanswered question is the one
      // state the user is meant to act on. Clearing it every 20s would make the
      // light - and the routing that depends on it - useless.
      if (getStatus(a.id).state === 'asking') continue;
      // NOTE: launched agents are probed too. The launcher only OWNS the light
      // at the moment of launch/stop (optimistic idle / explicit offline); every
      // other tick the probe tells the truth, so a crashed service shows offline
      // and a slow-starting one flips to idle once it is actually reachable.
      setStatus(a.id, { state: 'idle' });
    }
  } finally {
    probing = false;
  }
}

// ---- API router ----
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (method === 'GET' && url.pathname === '/api/agents/discover') {
    return sendJson(res, 200, await discoverLocalAgents());
  }
  if (method === 'GET' && url.pathname === '/api/agents') {
    return sendJson(res, 200, store.getAgents().map((a) => ({
      ...a, runtime: getStatus(a.id).state, launched: launched.has(a.id), observed: store.toolStatsOf(a.id),
    })));
  }
  // global status stream: snapshot + push on every change
  if (method === 'GET' && url.pathname === '/api/agent-status') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(allStatus())}\n\n`);
    const off = onStatus((updates) => {
      try { res.write(`event: agent_status\ndata: ${JSON.stringify(updates)}\n\n`); } catch { /* gone */ }
    });
    res.on('close', off);
    return;
  }
  if (method === 'POST' && url.pathname === '/api/agents') {
    const b = await readBody(req);
    // M4: auto-select adapter class from the connection description unless the
    // caller pins one explicitly. config is preserved (was dropped before).
    const probe = describeProbe(b);
    const type = b.adapterType || probe.type;
    const a = {
      id: b.id || uid(), name: b.name || 'agent', role: b.role || '',
      color: b.color || '#888888', system: b.system || '',
      model: b.model || (b.config && b.config.model) || 'deepseek-chat',
      adapterType: type,
      avatar: b.avatar || '',
      config: { ...(b.config || {}), adapterType: type },
    };
    store.upsertAgent(a);
    // Onboarding rule: the launcher is auto-selected here, so the settings
    // switch for this agent works the moment it is created.
    ensureLauncher(a);
    return sendJson(res, 200, a);
  }
  // M4 capability probe: given a connection description, report the adapter
  // class achat would auto-select (so the UI can suggest it before saving).
  if (method === 'POST' && url.pathname === '/api/agents/probe') {
    const b = await readBody(req);
    return sendJson(res, 200, describeProbe(b));
  }
  if (method === 'PATCH' && parts[1] === 'agents' && parts[2]) {
    const b = await readBody(req);
    const a = store.upsertAgent({ id: parts[2], ...b });
    // The cached adapter froze model/adapterType at construction time. Without
    // this, editing them in the UI does nothing until the server restarts.
    dropAdapter(parts[2]);
    return sendJson(res, 200, a);
  }
  if (method === 'DELETE' && parts[1] === 'agents' && parts[2]) {
    store.deleteAgent(parts[2]);
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'GET' && parts[1] === 'settings') {
    return sendJson(res, 200, store.getSettings());
  }
  // Null unless this process booted off a corrupt data.json. The UI shows a
  // banner, because an empty conversation list on its own looks like a bug
  // rather than a recovered crash.
  if (method === 'GET' && parts[1] === 'notice') {
    return sendJson(res, 200, { recovery: store.getRecovery() });
  }
  if (method === 'PATCH' && parts[1] === 'settings') {
    return sendJson(res, 200, store.setSettings(await readBody(req)));
  }
  if (method === 'POST' && parts[1] === 'agents' && parts[2] && parts[3] === 'abort') {
    const ok = abort(parts[2]);
    return sendJson(res, 200, { ok, note: ok ? '已发送中断信号' : '该 agent 当前不在执行' });
  }
  if (method === 'POST' && parts[1] === 'agents' && parts[2] && (parts[3] === 'launch' || parts[3] === 'stop')) {
    const agent = store.getAgents().find((a) => a.id === parts[2]);
    if (!agent) return sendJson(res, 404, { error: 'not found' });
    const r = parts[3] === 'stop' ? await stopAgent(agent) : await launchAgent(agent);
    return sendJson(res, 200, r);
  }

  if (method === 'GET' && url.pathname === '/api/conversations') {
    const list = store.getConversations().map((c) => ({
      id: c.id, type: c.type, name: c.name, agentId: c.agentId,
      memberIds: c.memberIds || [], status: c.status || 'active', count: c.messages.length,
    }));
    return sendJson(res, 200, list);
  }
  if (method === 'POST' && url.pathname === '/api/groups') {
    const b = await readBody(req);
    const c = { id: uid(), type: 'group', name: b.name || '新群', memberIds: b.memberIds || [], messages: [], artifacts: [] };
    return sendJson(res, 200, store.upsertConversation(c));
  }
  if (method === 'PATCH' && parts[1] === 'conversations' && parts[2]) {
    const c = store.getConversation(parts[2]);
    if (!c) return sendJson(res, 404, { error: 'not found' });
    const b = await readBody(req);
    if (b.name !== undefined) c.name = b.name;
    if (b.memberIds !== undefined) c.memberIds = b.memberIds;
    if (b.status !== undefined) {
      const wasArchived = c.status === 'archived';
      c.status = b.status;
      // 完结归档：把历史 + 产物快照进全局归档目录，让归档有实体去处，
      // 并从主群列表隐藏（前端只显示 active 群）。
      if (b.status === 'archived' && !wasArchived) {
        try {
          const safe = String(c.name || 'group').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'group';
          const adir = join(ARCHIVE_DIR, `${safe}-${c.id.slice(0, 6)}`);
          mkdirSync(adir, { recursive: true });
          const histFiles = buildHistoryMd(c); // 先生成 space/<id>/history/ 下按日期的 md
          // 1) 历史 md
          const hsrc = join(SPACE_DIR, c.id, 'history');
          if (existsSync(hsrc)) {
            mkdirSync(join(adir, 'history'), { recursive: true });
            for (const e of readdirSync(hsrc)) {
              const p = join(hsrc, e);
              if (statSync(p).isFile()) writeFileSync(join(adir, 'history', e), readFileSync(p));
            }
          }
          // 2) 产物文件（本地文件才复制；纯链接产物记入 README 即可）
          const fdir = join(adir, 'files');
          const filesCopied = [];
          for (const a of c.artifacts || []) {
            if (a.src && /^https?:\/\//i.test(a.src)) continue;
            if (a.src && existsSync(a.src) && statSync(a.src).isFile()) {
              mkdirSync(fdir, { recursive: true });
              const safeName = String(a.name || 'file').replace(/[\\/:*?"<>|]/g, '_') || 'file';
              writeFileSync(join(fdir, safeName), readFileSync(a.src));
              filesCopied.push(safeName);
            }
          }
          // 3) README 说明
          const now = new Date();
          const R = [];
          R.push(`# 归档群：${c.name || '(未命名)'}`);
          R.push('');
          R.push(`- 归档时间：${now.toLocaleString('zh-CN')}`);
          R.push(`- 群 ID：${c.id}`);
          R.push(`- 成员：${(c.memberIds || []).map((m) => agentName(m)).join('、') || '（无）'}`);
          R.push(`- 消息 ${(c.messages || []).length} 条 · 产物 ${(c.artifacts || []).length} 个`);
          R.push('');
          R.push('## 历史记录');
          R.push('');
          if (histFiles.length) for (const f of histFiles) R.push(`- \`history/${f.date}.md\`（${f.msgs} 条消息 · ${f.arts} 个产物）`);
          else R.push('（无历史记录）');
          R.push('');
          R.push('## 产物');
          R.push('');
          if (filesCopied.length) for (const f of filesCopied) R.push(`- \`files/${f}\``);
          else R.push('（无产物文件）');
          R.push('');
          writeFileSync(join(adir, 'README.md'), R.join('\n'));
          console.log(`[archive] 群已归档 -> ${adir}（历史 ${histFiles.length} 天，产物 ${filesCopied.length} 个）`);
        } catch (e) { console.warn('[archive] 归档快照失败:', e.message); }
      }
    }
    store.upsertConversation(c);
    return sendJson(res, 200, c);
  }
  if (method === 'DELETE' && parts[1] === 'conversations' && parts[2]) {
    store.deleteConversation(parts[2]);
    // 删群时连同产物目录一起清掉，避免 space/ 下堆积孤儿文件。
    try { rmSync(join(SPACE_DIR, parts[2]), { recursive: true, force: true }); }
    catch (e) { console.warn('[space] 删除群产物目录失败:', e.message); }
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'POST' && url.pathname === '/api/dm') {
    const b = await readBody(req);
    const existing = store.getConversations().find((c) => c.type === 'dm' && c.agentId === b.agentId);
    if (existing) return sendJson(res, 200, existing);
    const c = { id: uid(), type: 'dm', agentId: b.agentId, name: `💬 ${b.agentId}`, memberIds: [b.agentId], messages: [], artifacts: [], status: 'active' };
    return sendJson(res, 200, store.upsertConversation(c));
  }
  // /stream must be matched before the generic /:id route (which would swallow it).
  if (method === 'GET' && parts[1] === 'conversations' && parts[2] && parts[3] === 'stream') {
    const c = store.getConversation(parts[2]);
    if (!c) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(c)}\n\n`);
    subscribe(c.id, res);
    return;
  }
  if (method === 'GET' && parts[1] === 'conversations' && parts[2] && !parts[3]) {
    const c = store.getConversation(parts[2]);
    if (!c) return sendJson(res, 404, { error: 'not found' });
    return sendJson(res, 200, c);
  }
  if (method === 'POST' && parts[1] === 'conversations' && parts[2] && parts[3] === 'messages') {
    const c = store.getConversation(parts[2]);
    if (!c) return sendJson(res, 404, { error: 'not found' });
    const b = await readBody(req);
    const text = b.text || b.content || '';
    // Slash command: start a multi-agent negotiation in this group. The raw
    // "/consensus ..." line is NOT pushed as a chat message.
    if (text.startsWith('/consensus')) {
      const topic = text.slice('/consensus'.length).trim() || '（未指定议题，请自行拟定一个协商主题展开讨论）';
      const emit = (event, data) => broadcast(c.id, event, data);
      runConsensus({
        conv: c, agents: store.getAgents(), topic,
        participantIds: b.participantIds || c.memberIds,
        rounds: b.rounds || 3, synthesizerId: b.synthesizerId,
        emit, persist: () => store.save(),
        recordTool: (agentId, tool) => store.recordTool(agentId, tool),
        settings: store.getSettings(),
      }).catch((e) => console.error('consensus error', e.message));
      return sendJson(res, 200, { ok: true, note: '协商已启动', topic });
    }
    const msg = { id: uid(), sender: 'user', text, ts: Date.now() };
    c.messages.push(msg);
    store.save();
    broadcast(c.id, 'message', msg);
    const emit = (event, data) => broadcast(c.id, event, data);
    dispatch({
      conv: c,
      agents: store.getAgents(),
      toAgentId: b.toAgentId,
      emit,
      persist: () => store.save(),
      recordTool: (agentId, tool) => store.recordTool(agentId, tool),
      settings: store.getSettings(),
    }).catch((e) => console.error('bus error', e.message));
    return sendJson(res, 200, msg);
  }
  // Dedicated consensus endpoint (used by the UI "发起协商" panel): lets the
  // caller pick participants / rounds / synthesizer explicitly.
  if (method === 'POST' && parts[1] === 'conversations' && parts[2] && parts[3] === 'consensus') {
    const c = store.getConversation(parts[2]);
    if (!c) return sendJson(res, 404, { error: 'not found' });
    const b = await readBody(req);
    const emit = (event, data) => broadcast(c.id, event, data);
    runConsensus({
      conv: c, agents: store.getAgents(), topic: b.topic || '（未指定议题）',
      participantIds: b.participantIds, rounds: b.rounds || 3, synthesizerId: b.synthesizerId,
      emit, persist: () => store.save(),
      recordTool: (agentId, tool) => store.recordTool(agentId, tool),
      settings: store.getSettings(),
    }).catch((e) => console.error('consensus error', e.message));
    return sendJson(res, 200, { ok: true, note: '协商已启动' });
  }
  if (method === 'POST' && parts[1] === 'conversations' && parts[2] && parts[3] === 'space') {
    const c = store.getConversation(parts[2]);
    if (!c) return sendJson(res, 404, { error: 'not found' });
    const b = await readBody(req);
    const dir = join(SPACE_DIR, c.id);
    mkdirSync(dir, { recursive: true });
    const fname = b.name || b.filename || 'file';
    let src = b.src || null, stored = false;
    if (b.content_base64) {
      writeFileSync(join(dir, fname), Buffer.from(b.content_base64, 'base64'));
      src = join(dir, fname); stored = true;
    }
    // Only artefacts that can actually be opened get registered. The front end
    // regex-scrapes paths out of agent output, and those scrapes are frequently
    // junk ("file", "path", a path that never existed). Registering them yields
    // a list of entries that look real but 404 on click -- worse than nothing.
    if (!stored && !src) return sendJson(res, 422, { error: 'empty artifact' });
    if (!stored && !/^(https?:\/\/|[A-Za-z]:[\\/]|\/)/.test(src)) {
      return sendJson(res, 422, { error: 'unusable src' });
    }
    if (!stored && !/^https?:\/\//i.test(src) && !existsSync(src)) {
      return sendJson(res, 422, { error: 'file not found' });
    }
    // Dedupe server-side. The front end also dedupes, but its set lives in
    // memory and is wiped on reload, so every refresh re-registered the whole
    // history. The server is the only place that sees every registration.
    c.artifacts = c.artifacts || [];
    const dup = c.artifacts.find((a) => a.src && a.src === src);
    if (dup) return sendJson(res, 200, dup);
    const item = {
      id: uid(), name: fname, kind: normalizeKind(fname, b.kind),
      ownerId: b.ownerId || 'user', colorTag: b.colorTag || b.color || '#3b6fd4',
      src, stored, ts: Date.now(),
    };
    c.artifacts.push(item);
    store.upsertConversation(c);
    broadcast(c.id, 'message', { convId: c.id, artifact: item });
    return sendJson(res, 200, item);
  }

  // GET /api/conversations/:id/tree -> the real file tree of the group's
  // artefact folder. The tab used to render a hardcoded fake project layout,
  // which made the pane look broken the moment a group had different files.
  if (method === 'GET' && parts[1] === 'conversations' && parts[2] && parts[3] === 'tree') {
    const c = store.getConversation(parts[2]);
    if (!c) return sendJson(res, 404, { error: 'not found' });
    const dir = join(SPACE_DIR, c.id);
    const SKIP = new Set(['node_modules', '.git', '.DS_Store', 'Thumbs.db']);
    const walk = (p, depth) => {
      if (depth > 4) return [];
      let list; try { list = readdirSync(p, { withFileTypes: true }); } catch { return []; }
      return list
        .filter((d) => !SKIP.has(d.name))
        .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
        .map((d) => {
          const full = join(p, d.name);
          if (d.isDirectory()) return { name: d.name, type: 'dir', path: full, children: walk(full, depth + 1) };
          let size = 0, mtime = 0;
          try { const s = statSync(full); size = s.size; mtime = s.mtimeMs; } catch { /* ignore */ }
          return { name: d.name, type: 'file', path: full, size, mtime, ext: extname(d.name).toLowerCase() };
        });
    };
    return sendJson(res, 200, { dir, exists: existsSync(dir), entries: walk(dir, 0) });
  }

  // 群历史（上下文）：把对话 + 产物按日期生成 markdown，供 agent 失忆 /
  // 中途新入群时通读全程。带日期 → 返回/下载当日 md；不带日期 → 生成并列出。
  if (method === 'GET' && parts[1] === 'conversations' && parts[2] && parts[3] === 'history' && parts[4]) {
    const c = store.getConversation(parts[2]);
    if (!c) return sendJson(res, 404, { error: 'not found' });
    const f = join(SPACE_DIR, c.id, 'history', parts[4] + '.md');
    if (!existsSync(f)) return sendJson(res, 404, { error: 'not found' });
    const download = url.searchParams.get('download') === '1';
    const name = `${String(c.name || 'group').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}-${parts[4]}.md`;
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': (download ? 'attachment' : 'inline') + `; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    return res.end(readFileSync(f));
  }
  if (method === 'GET' && parts[1] === 'conversations' && parts[2] && parts[3] === 'history') {
    const c = store.getConversation(parts[2]);
    if (!c) return sendJson(res, 404, { error: 'not found' });
    try {
      const files = buildHistoryMd(c);
      return sendJson(res, 200, { group: { id: c.id, name: c.name, status: c.status || 'active' }, files });
    } catch (e) { return sendJson(res, 500, { error: String(e.message || e) }); }
  }
  // 一键打开全局归档文件夹（群列表的文件夹按钮）
  if (method === 'POST' && url.pathname === '/api/archive/open') {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    const opened = revealPath(ARCHIVE_DIR);
    return sendJson(res, opened ? 200 : 500, { ok: opened, dir: ARCHIVE_DIR });
  }

  // GET /api/fetch?url=... -> server-side text fetch. Fallback for the space
  // browser when a site refuses to be framed (X-Frame-Options / CSP).
  // SSRF guard: block loopback / RFC1918 / link-local / dot-local hosts so the
  // endpoint cannot be used as an intranet scanner proxy. Hostname-level check
  // only (no DNS resolution) - adequate for a localhost-bound single-user tool.
  if (method === 'GET' && parts[1] === 'fetch') {
    const target = String(url.searchParams.get('url') || '');
    if (!/^https?:\/\//i.test(target)) return sendJson(res, 400, { error: 'only http/https allowed' });
    let host = '';
    try { host = new URL(target).hostname.toLowerCase(); } catch { return sendJson(res, 400, { error: 'bad url' }); }
    const bare = host.replace(/^\[|\]$/g, '');
    const privateHost =
      bare === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
      bare === '::1' || /^127\./.test(bare) || /^10\./.test(bare) || /^192\.168\./.test(bare) ||
      /^169\.254\./.test(bare) || /^0\./.test(bare) || /^172\.(1[6-9]|2\d|3[01])\./.test(bare) ||
      /^fe80:/i.test(bare) || /^fc|fd/i.test(bare);
    if (privateHost) return sendJson(res, 403, { error: 'private/intranet targets are not allowed' });
    try {
      const r = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
      const body = await r.text();
      return sendJson(res, 200, { status: r.status, finalUrl: r.url, contentType: r.headers.get('content-type') || '', body: body.slice(0, 300000) });
    } catch (e) { return sendJson(res, 502, { error: String(e.message || e) }); }
  }

  // 产物文件操作：/api/conversations/:id/artifacts/:aid[/file|reveal|rename]
  if (method === 'POST' && parts[1] === 'conversations' && parts[2] && parts[3] === 'space' && parts[4] === 'folder' && parts[5] === 'reveal') {
    const c = store.getConversation(parts[2]);
    if (!c) return sendJson(res, 404, { error: 'not found' });
    const dir = join(SPACE_DIR, c.id); mkdirSync(dir, { recursive: true });
    const opened = revealPath(dir);
    return sendJson(res, opened ? 200 : 500, { ok: opened, dir });
  }
  if (parts[1] === 'conversations' && parts[2] && parts[3] === 'artifacts' && parts[4]) {
    const c = store.getConversation(parts[2]);
    if (!c) return sendJson(res, 404, { error: 'not found' });
    const a = findArtifact(c, parts[4]);
    // GET .../file -> 流式返回文件（用于前端「查看」），URL 类产物 302 跳转
    if (method === 'GET' && parts[5] === 'file') {
      if (!a) return sendJson(res, 404, { error: 'artifact not found' });
      if (a.src && /^https?:\/\//i.test(a.src)) { res.writeHead(302, { Location: a.src }); return res.end(); }
      const fpath = a.stored ? a.src : (a.src && (a.src.startsWith('/') || /^[A-Za-z]:[\\/]/i.test(a.src)) ? a.src : null);
      if (!fpath || !existsSync(fpath) || !statSync(fpath).isFile()) return sendJson(res, 404, { error: 'file not found' });
      const ct = MIME[extname(fpath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.name)}` });
      return res.end(readFileSync(fpath));
    }
    if (!a) return sendJson(res, 404, { error: 'artifact not found' });
    if (method === 'POST' && parts[5] === 'reveal') {
      const opened = revealPath(a.src || join(SPACE_DIR, c.id));
      return sendJson(res, opened ? 200 : 500, { ok: opened });
    }
    if (method === 'POST' && parts[5] === 'rename') {
      const b = await readBody(req);
      const newName = String(b.name || '').trim();
      if (!newName) return sendJson(res, 400, { error: 'empty name' });
      if (a.stored && a.src && existsSync(a.src)) {
        const dir = dirname(a.src); const oldExt = extname(a.src);
        const base = newName.toLowerCase().endsWith(oldExt.toLowerCase()) ? newName : newName + oldExt;
        const newPath = join(dir, base);
        if (!existsSync(newPath)) { try { renameSync(a.src, newPath); a.src = newPath; } catch { /* keep old */ } }
      }
      a.name = newName;
      store.upsertConversation(c);
      broadcast(c.id, 'message', { convId: c.id, artifact: a });
      return sendJson(res, 200, a);
    }
    if (method === 'DELETE' && !parts[5]) {
      // 删记录时同步删磁盘文件；失败不能静默吞掉，要在服务端日志里留痕，
      // 否则会变成「记录没了、文件还在」的孤儿文件。
      if (a.stored && a.src) {
        try {
          if (existsSync(a.src) && statSync(a.src).isFile()) unlinkSync(a.src);
        } catch (e) { console.warn('[space] 删除产物文件失败:', a.src, '->', e.message); }
      }
      c.artifacts = (c.artifacts || []).filter((x) => x.id !== a.id);
      store.upsertConversation(c);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'no route' });
  }

  return sendJson(res, 404, { error: 'no route' });
}

// ---- avatars ----
// Base64 agent avatars are offloaded to server/avatars/ by store.mjs; serve
// them back same-origin. Filename is whitelisted instead of path-escaped.
const AVATARS = join(__dirname, 'avatars');
function serveAvatar(res, url) {
  const name = url.pathname.slice('/avatars/'.length);
  if (!/^[\w.-]+\.(png|jpg|jpeg|gif|webp|svg|ico)$/i.test(name)) {
    res.writeHead(404);
    return res.end('not found');
  }
  const fpath = join(AVATARS, name);
  if (!existsSync(fpath)) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(fpath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(readFileSync(fpath));
}

// ---- static files ----
function serveStatic(req, res, url) {
  const p = url.pathname === '/' ? '/index.html' : url.pathname;
  const fpath = join(PUBLIC, p);
  // relative()-based containment: a plain startsWith() would let sibling dirs
  // like "..\public2\x" through (string prefix of PUBLIC). Works across
  // Windows path separators; the join() above already normalizes "..".
  const rel = relative(PUBLIC, fpath);
  if (!existsSync(fpath) || rel.startsWith('..') || isAbsolute(rel)) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(fpath)] || 'application/octet-stream',
    'Cache-Control': 'no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(readFileSync(fpath));
}

// ---- local image proxy ----
// The page runs on http://localhost:8787, so an <img> pointing at a local disk
// path (D:\...\x.png) can never load directly: browsers refuse file:// inside
// http pages. Agents often reply with screenshot paths, so the front end
// rewrites those to /files?path=... and we stream the bytes here.
// Guards: absolute path only, image extensions only, size capped.
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const IMG_MAX_BYTES = 25 * 1024 * 1024;

function serveLocalImage(res, url) {
  const p = (url.searchParams.get('path') || '').trim();
  const abs = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('//') || p.startsWith('\\\\');
  if (!abs || !IMG_EXT.has(extname(p).toLowerCase())) {
    res.writeHead(400);
    return res.end('bad path');
  }
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > IMG_MAX_BYTES) {
      res.writeHead(400);
      return res.end('not a file or too large');
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(p).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(readFileSync(p));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

// Only accept requests whose Host header names this machine's loopback.
// A malicious page in the user's browser could otherwise reach the API via
// DNS rebinding (attacker-domain -> 127.0.0.1) and browsers would not count
// it as cross-origin. Cheap one-line guard for a localhost-only service.
function hostAllowed(h) {
  if (!h) return false;
  const bare = String(h).toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

const server = http.createServer((req, res) => {
  if (!hostAllowed(req.headers.host)) {
    res.writeHead(403);
    return res.end('forbidden host');
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/avatars/')) return serveAvatar(res, url);
  if (url.pathname === '/files') return serveLocalImage(res, url);
  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url).catch((e) => sendJson(res, 500, { error: e.message }));
  }
  return serveStatic(req, res, url);
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`zjl-Achat on http://localhost:${PORT}`);
  // Fill in launchers the stored agents are missing (legacy agents onboarded
  // before auto-selection existed), then bring up whichever switches are ON.
  store.getAgents().forEach(ensureLauncher);
  await autoLaunchEnabled();         // bring up enabled local agents BEFORE first probe
  probeAll();                        // first liveness pass (sees launched agents)
  setInterval(probeAll, PROBE_MS);   // then keep the traffic lights honest
});
