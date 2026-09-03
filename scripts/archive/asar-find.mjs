// Find exact paths + offsets of acp/permission docs, and validate a few.
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
const base = he + 1;
let found = [];
function walk(node, path) {
  for (const k of Object.keys(node || {})) {
    const v = node[k];
    const p2 = path ? path + '/' + k : k;
    if (v && v.files) walk(v.files, p2);
    else if (v && typeof v.size === 'number') {
      if (p2.includes('cli/dist/web-ui/docs') && /acp|permission-modes|permissions|remote-control|sdk-permissions/i.test(p2)) {
        const off = Number(v.offset);
        found.push({ p2, size: v.size, offset: off, abs: base + off });
      }
    }
  }
}
walk(h.files, '');
console.log('found', found.length);
found.forEach((f) => console.log(`  ${f.p2}  size=${f.size} absOffset=${f.abs}`));
// validate: read first file
if (found[0]) {
  const f = found[0];
  const buf = b.slice(f.abs, f.abs + f.size);
  console.log('--- preview', f.p2, '---');
  console.log(buf.slice(0, 800).toString('utf8'));
}
