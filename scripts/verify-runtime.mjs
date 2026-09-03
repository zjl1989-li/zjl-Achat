// Regression check for the M1.5 runtime: tool event stream + real abort.
// Proves the abort actually stops the agent by watching DSH's own `running` flag,
// not just our side of the connection.
//
//   node scripts/verify-runtime.mjs [agentId] [abortAfterMs]
//
// Requires: achat server on 8787, DSH on 3080 (or whatever the adapter resolves).
import http from 'node:http';

const ACHAT = process.env.ACHAT || 'http://127.0.0.1:8787';
const DSH = process.env.DSH || 'http://127.0.0.1:3080';
const AGENT = process.argv[2] || 'dsh';
const ABORT_AFTER = Number(process.argv[3] || 6000);

const T0 = Date.now();
const at = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(5) + 's';
const log = (...a) => console.log(at(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const req = (method, path, body) => new Promise((resolve, reject) => {
  const d = body ? Buffer.from(JSON.stringify(body)) : null;
  const r = http.request(ACHAT + path, { method, headers: d ? { 'content-type': 'application/json', 'content-length': d.length } : {} },
    (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(s); } }); });
  r.on('error', reject); if (d) r.write(d); r.end();
});

async function rpc(method, payload) {
  const r = await fetch(`${DSH}/api/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'v' + Date.now(), method, payload }),
  });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { return null; }
  return j.result && j.result.ok === false ? null : (j.result ? j.result.value : j);
}
// Only sessions DSH itself reports as running - that is the ground truth we check.
async function busySessions() {
  const l = await rpc('session.list', {});
  return ((l && l.items) || []).filter((s) => s.running).map((s) => s.sessionId);
}

function stream(path, h) {
  http.get(ACHAT + path, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c.toString(); const p = buf.split('\n\n'); buf = p.pop();
      for (const x of p) {
        const ev = /^event: (.+)$/m.exec(x), dt = /^data: (.+)$/m.exec(x);
        if (!ev || !dt) continue;
        let d; try { d = JSON.parse(dt[1]); } catch { continue; }
        if (h[ev[1]]) h[ev[1]](d);
      }
    });
  }).on('error', () => {});
}

const convs = await req('GET', '/api/conversations');
// Prefer a solo conversation for the agent; otherwise any group that has it.
// Either way the prompt is sent with toAgentId so only that agent replies.
const conv = convs.find((c) => (c.memberIds || []).length === 1 && c.memberIds[0] === AGENT)
  || convs.find((c) => (c.memberIds || []).includes(AGENT));
if (!conv) { console.error(`no conversation has member "${AGENT}"`); process.exit(1); }
log('conversation:', conv.id, '| members:', (conv.memberIds || []).join(','), '| target:', AGENT);

let toolCalls = 0;
stream(`/api/conversations/${conv.id}/stream`, {
  message: (d) => d.message && log(`[msg] ${String(d.message.text).slice(0, 80).replace(/\n/g, ' ')}`),
  tool: (d) => { if (d.kind === 'tool_call') { toolCalls++; log(`[tool] CALL ${d.name} :: ${String(d.detail).slice(0, 55)}`); } },
});
stream('/api/agent-status', { agent_status: (u) => u.forEach((x) => log(`[status] ${x.agentId} -> ${x.status.state}`)) });

log('baseline busy:', JSON.stringify(await busySessions()));
log(`--- long task, abort after ${ABORT_AFTER}ms ---`);
await req('POST', `/api/conversations/${conv.id}/messages`, {
  toAgentId: AGENT,
  text: 'Run this command and wait for it to finish before reporting: ping -n 60 127.0.0.1 . Report the packet loss when done.',
});

const samples = Math.max(1, Math.floor(ABORT_AFTER / 3000));
for (let i = 0; i < samples; i++) { await sleep(3000); log('running ->', JSON.stringify(await busySessions())); }

log('--- ABORT ---');
log('abort ->', JSON.stringify(await req('POST', `/api/agents/${AGENT}/abort`, {})));
for (const t of [1500, 3000, 5000]) { await sleep(t); log('after abort ->', JSON.stringify(await busySessions())); }

const after = toolCalls;
await sleep(4000);
log('states:', (await req('GET', '/api/agents')).map((a) => `${a.id}=${a.runtime}`).join(' '));
log(`RESULT tool_events=${toolCalls} (frozen_after_abort=${after === toolCalls})`);
process.exit(0);
