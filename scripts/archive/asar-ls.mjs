// Parse app.asar header and list files matching acp / remote control / approval.
import { readFileSync } from 'node:fs';

const p = process.argv[2];
const b = readFileSync(p);

// asar format:
//  8 bytes: 4-byte pickled header-size placeholder (4 bytes) + 4-byte size
// Actually: bytes 0-7 pickle header, then offset 8 = 4-byte header size (bytes 8-11? no)
// Standard: [4] size of following header pickle (at offset 4), header string at offset 8
// Let's do robust scan: find "{\"files\"" start near beginning.
let header = null;
for (let i = 0; i < 200; i++) {
  const chunk = b.slice(i, i + 30).toString('utf8');
  if (chunk.startsWith('{"files"')) {
    // find matching close brace - scan
    let depth = 0, start = i, end = -1;
    for (let j = i; j < b.length; j++) {
      if (b[j] === 0x7b) depth++;        // {
      else if (b[j] === 0x7d) { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end > 0) {
      try { header = JSON.parse(b.slice(start, end + 1).toString('utf8')); console.log('header parsed at', i, 'len', end - i); } catch (e) { console.log('parse fail at', i, e.message); }
      break;
    }
  }
}
if (!header) { console.log('could not find asar header'); process.exit(1); }

const matches = [];
function walk(node, path) {
  if (!node) return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    const p2 = path ? path + '/' + k : k;
    if (v && v.files) walk(v.files, p2);
    else {
      const lk = k.toLowerCase();
      if (lk.includes('acp') || lk.includes('remote') || lk.includes('control') || lk.includes('permission') || lk.includes('approval')) {
        matches.push(p2);
      }
    }
  }
}
walk(header.files || {}, '');
console.log('matches:', matches.length);
matches.slice(0, 80).forEach((m) => console.log('  ' + m));
