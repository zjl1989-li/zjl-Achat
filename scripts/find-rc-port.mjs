// Discover the current WorkBuddy "Remote Control" (ACP) service port by
// probing local LISTENING ports for the known service title.
import { execSync } from "node:child_process";
import http from "node:http";

function getListenPorts() {
  const out = execSync("netstat -ano", { encoding: "utf8" });
  const ports = new Map(); // port -> pid
  for (const line of out.split("\n")) {
    const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m) ports.set(Number(m[1]), Number(m[2]));
  }
  return ports;
}

function getTitle(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: 800 },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve(buf));
      }
    );
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
  });
}

(async () => {
  const ports = getListenPorts();
  console.log("scanning", ports.size, "listening ports...");
  const hits = [];
  for (const port of ports.keys()) {
    const html = await getTitle(port);
    if (html.includes("Remote Control") || html.toLowerCase().includes("codebuddy")) {
      hits.push({ port, pid: ports.get(port) });
    }
  }
  if (hits.length) {
    console.log("FOUND Remote Control service:");
    for (const h of hits) console.log(`  port=${h.port} pid=${h.pid}`);
  } else {
    console.log("NOT FOUND — Remote Control service not currently listening.");
  }
})();
