// Diagnostic: check asar header structure and whether the file offsets are valid.
import { readFileSync } from 'node:fs';
const p = process.argv[2];
const b = readFileSync(p);
let h = null, he = -1;
for (let i = 0; i < 300; i++) {
  if (b.slice(i, i + 9).toString('utf8').startsWith('{"files"')) {
    let d = 0, s = i, e = -1;
    for (let j = i; j < b.length; j++) {
      if (b[j] === 0x7b) d++;
      else if (b[j] === 0x7d) { d--; if (d === 0) { e = j; break; } }
    }
    if (e > 0) { h = JSON.parse(b.slice(s, e + 1).toString('utf8')); he = e; break; }
  }
}
console.log('header found at', he);
if (!h) { console.log('NO HEADER'); process.exit(1); }
console.log('top-level keys:', Object.keys(h));
const files = h.files || {};
console.log('files count:', Object.keys(files).length);
console.log('first-level keys:', Object.keys(files).slice(0, 40).join(', '));
const base = he + 1;
// check a sample file's offset validity
let sampleCount = 0;
function sample(node, path, depth) {
  if (sampleCount > 10 || depth > 6) return;
  for (const k of Object.keys(node || {})) {
    const v = node[k];
    const p2 = path ? path + '/' + k : k;
    if (v && v.files) { sample(v.files, p2, depth + 1); }
    else if (v && typeof v.size === 'number' && typeof v.offset === 'number') {
      console.log(`sample ${p2} size=${v.size} offset=${v.offset} -> base+offset=${base + v.offset} (buf len ${b.length})`);
      sampleCount++;
    }
  }
}
sample(files, '', 0);
