// Stop the Tmesh server (the desktop entry only starts it; the Edge
// window is closed by the user). Zero-dep.
import { execSync } from 'node:child_process';

function killPort(port) {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  const lines = out.split('\n').filter((l) => l.includes(`:${port}`) && l.includes('LISTENING'));
  const pids = new Set(lines.map((l) => l.trim().split(/\s+/).pop()));
  let n = 0;
  for (const p of pids) {
    try { execSync(`taskkill /PID ${p} /F`); n++; } catch { /* already gone */ }
  }
  return n;
}

const killed = killPort(8787);
console.log(killed ? `[achat-desktop] stopped ${killed} server process(es) on 8787` : '[achat-desktop] no server running on 8787');
console.log('请手动关闭 Edge 应用窗口（如已打开）。');
process.exit(0);
