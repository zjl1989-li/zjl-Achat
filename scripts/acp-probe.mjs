// Minimal ACP client probe against the running WorkBuddy Remote Control service.
// Goal: prove we can drive the REAL WorkBuddy via ACP (port auto-discovered).
import http from "node:http";
import fs from "node:fs";
import { execSync } from "node:child_process";

const HOST = "127.0.0.1";

// The Remote Control (ACP) service uses a DYNAMIC port assigned at WorkBuddy
// startup. Discover it by scanning local LISTENING ports for the known title.
async function discoverPort() {
  const out = execSync("netstat -ano", { encoding: "utf8" });
  const ports = [];
  for (const line of out.split("\n")) {
    const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m) ports.push(Number(m[1]));
  }
  for (const port of ports) {
    const title = await new Promise((resolve) => {
      const req = http.get({ host: HOST, port, path: "/", timeout: 600 }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b));
      });
      req.on("error", () => resolve(""));
      req.on("timeout", () => { req.destroy(); resolve(""); });
    });
    if (title.includes("Remote Control") || title.toLowerCase().includes("codebuddy")) return port;
  }
  return null;
}

const PORT = Number(process.env.PORT) || (await discoverPort());
if (!PORT) { console.error("NO Remote Control service found (is WorkBuddy running?)"); process.exit(3); }
const BASE = `http://${HOST}:${PORT}`;
console.log("Using Remote Control port:", PORT);

function post(path, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const req = http.request(
      { host: HOST, port: PORT, path, method: "POST",
        headers: { ...headers, "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: buf })
        );
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Streaming POST for SSE responses: resolve as soon as `doneWhen(events)` is true,
// OR after maxWaitMs (best-effort) so we never hang on a slow/keep-alive stream.
function postSse(path, headers, bodyObj, doneWhen, maxWaitMs = 120000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    let settled = false;
    let buf = "";
    const finish = (status, headers, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, headers, body });
    };
    const req = http.request(
      { host: HOST, port: PORT, path, method: "POST",
        headers: { ...headers, "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        res.on("data", (c) => {
          buf += c;
          const evs = parseSse(buf);
          if (doneWhen && doneWhen(evs)) finish(res.statusCode, res.headers, buf);
        });
        res.on("end", () => finish(res.statusCode, res.headers, buf));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
    const timer = setTimeout(() => finish(0, {}, buf), maxWaitMs);
  });
}

// parse SSE "data: {...}\n" lines -> array of JSON objects
function parseSse(body) {
  const out = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t.startsWith("data:")) {
      const j = t.slice(5).trim();
      if (j) { try { out.push(JSON.parse(j)); } catch {} }
    } else if (t.startsWith("{")) {
      try { out.push(JSON.parse(t)); } catch {}
    }
  }
  return out;
}

// ACP streams assistant text in `agent_message_chunk` events:
//   params.update.content.text  (concatenate all chunks)
function extractText(events) {
  let txt = "";
  for (const e of events) {
    const upd = e.params && e.params.update;
    if (upd && upd.sessionUpdate === "agent_message_chunk"
        && upd.content && typeof upd.content.text === "string") {
      txt += upd.content.text;
    }
  }
  return txt;
}

// final result event: result.stopReason / result._meta.outcome
function extractOutcome(events) {
  const last = events[events.length - 1];
  if (last && last.result) {
    return { stopReason: last.result.stopReason, outcome: last.result._meta && last.result._meta.outcome };
  }
  return null;
}

(async () => {
  console.log("=== 1) connect ===");
  const conn = await post("/api/v1/acp/connect", {}, {});
  console.log("status:", conn.status);
  console.log("raw:", conn.body.slice(0, 400));
  let cj;
  try { cj = JSON.parse(conn.body); } catch { cj = parseSse(conn.body).find(e=>e.connectionId)||{}; }
  const connectionId = cj.connectionId;
  const sessionToken = cj.sessionToken;
  console.log("connectionId:", connectionId, "| sessionToken?", !!sessionToken);
  if (!connectionId) { console.log("NO CONNECTION -> abort"); process.exit(1); }

  const H = { "acp-connection-id": connectionId };
  if (sessionToken) H["acp-session-token"] = sessionToken;

  console.log("\n=== 1.5) initialize ===");
  const init = await post("/api/v1/acp", H, {
    jsonrpc: "2.0", id: 0, method: "initialize",
    params: {
      protocolVersion: 1,
      clientInfo: { name: "achat-bridge", version: "1.0.0" },
      clientCapabilities: { _meta: { "codebuddy.ai": { question: true, promptSuggestion: true, terminalOutput: true } } },
    },
  });
  console.log("status:", init.status);
  console.log("raw:", init.body.slice(0, 400));

  console.log("\n=== 2) session/new ===");
  const sn = await post("/api/v1/acp", H, {
    jsonrpc: "2.0", id: 1, method: "session/new",
    params: { cwd: ".", mcpServers: [] },
  });
  console.log("status:", sn.status);
  console.log("raw:", sn.body.slice(0, 400));
  const snEvents = parseSse(sn.body);
  const sessionId = snEvents.find(e=>e.result?.sessionId)?.result?.sessionId
                 || snEvents.find(e=>e.sessionId)?.sessionId;
  console.log("sessionId:", sessionId);
  if (!sessionId) { console.log("NO SESSION -> abort"); process.exit(1); }

  console.log("\n=== 3) session/prompt (REAL WorkBuddy does the work) ===");
  const sp = await postSse("/api/v1/acp", H, {
    jsonrpc: "2.0", id: 2, method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "Reply with exactly the single word: PONG and nothing else." }] },
  }, (evs) => evs.some((e) => e.result && e.result.stopReason));
  console.log("status:", sp.status);
  const spEvents = parseSse(sp.body);
  console.log("event count:", spEvents.length);

  console.log("\n=== event skeleton (method | update type | top keys) ===");
  for (const e of spEvents) {
    const upd = e.params && e.params.update;
    const sk = (upd && upd.sessionUpdate) || "(none)";
    const keys = Object.keys(e).join(",");
    console.log(`  ${e.method || "?"} | update=${sk} | keys=[${keys}]`);
  }

  const txt = extractText(spEvents);
  console.log("\n=== EXTRACTED REPLY ===");
  console.log(JSON.stringify(txt) || "(empty)");

  const oc = extractOutcome(spEvents);
  if (oc) console.log("outcome:", JSON.stringify(oc));

  fs.writeFileSync("D:/Projects/zjl-achat/_probe/acp_last_events.json",
    JSON.stringify(spEvents, null, 1));
  console.log("\n(saved full events -> _probe/acp_last_events.json)");
})().catch((e) => { console.error("PROBE ERROR:", e.message); process.exit(2); });
