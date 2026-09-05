// Tmesh desktop entry (zero-dep).
// One-click flow: ensure the achat server (incl. DSH + beichen-bridge
// launchers) is up, then open the UI in a standalone Edge "--app" window
// (native app window, NOT a browser tab). No Electron, no extra deps.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8787;
const HOST = '127.0.0.1';
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const NODE = process.execPath.replace(/\\/g, '/'); // normalize for spawn across shells

function findEdge() {
  return EDGE_CANDIDATES.find((p) => fs.existsSync(p)) || 'msedge';
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, HOST);
    s.setTimeout(800);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => { s.destroy(); resolve(false); });
  });
}

async function waitPort(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  if (!(await portOpen(PORT))) {
    const child = spawn(NODE, ['server/server.mjs'], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    });
    child.unref();
    if (!(await waitPort(PORT, 20000))) {
      console.error('[achat-desktop] server failed to start on', PORT);
      process.exit(1);
    }
  }
  spawn(findEdge(), [`--app=http://${HOST}:${PORT}`, '--new-window'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  }).unref();
  process.exit(0);
}
main();
