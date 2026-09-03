// Minimal MCP stdio mock server for M5 adapter tests.
// Speaks just enough JSON-RPC to prove McpAdapter end-to-end:
//   initialize / notifications/initialized / tools/list / tools/call
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
function send(m) { process.stdout.write(JSON.stringify(m) + '\n'); }
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0' } } });
  } else if (msg.method === 'notifications/initialized') {
    // no response for notifications
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'chat', description: 'echo chat tool', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] } });
  } else if (msg.method === 'tools/call') {
    const text = msg.params?.arguments?.message || '(empty)';
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '[mock-mcp] ' + text }] } });
  }
}
