// Extract specific files from app.asar by path.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const p = process.argv[2];
const outDir = process.argv[3];
const want = process.argv.slice(4);
const b = readFileSync(p);

let header = null;
let headerEnd = -1;
for (let i = 0; i < 200; i++) {
  if (b.slice(i, i + 9).toString('utf8').startsWith('{"files"')) {
    let depth = 0, start = i, end = -1;
    for (let j = i; j < b.length; j++) {
      if (b[j] === 0x7b) depth++;
      else if (b[j] === 0x7d) { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end > 0) { header = JSON.parse(b.slice(start, end + 1).toString('utf8')); headerEnd = end; break; }
  }
}
if (!header) { console.log('no header'); process.exit(1); }

// data offset = end of header + 1 (the } we found) then padded? asar: data starts right after header bytes.
// Find data offset: the header string size in bytes.
const dataOffset = b.indexOf(0, 0); // not reliable; compute below
// Actually: offset 8 = 4-byte size, then header JSON of that many bytes, then data.
const sizeAt8 = b.readUInt32LE(8);
const headerStart = 12; // 4(size@8..11) then headerString starts at 12? asar: [8]=size of pickle [12]=? 
// Simpler: we know header JSON ends at `end`. Data starts at `end+1`. Files store {size, offset} relative to data start.
const base = headerEnd + 1;

mkdirSync(outDir, { recursive: true });
let extracted = 0;
function walk(node, path) {
  if (!node) return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    const p2 = path ? path + '/' + k : k;
    if (v && v.files) walk(v.files, p2);
    else if (v && typeof v.size === 'number' && typeof v.offset === 'number') {
      const hit = want.length === 0
        ? (p2.includes('cli/dist/web-ui/docs') && /acp|permission|remote|sdk-perm/i.test(p2) && p2.endsWith('.md'))
        : want.some((w) => p2.endsWith(w));
      if (hit) {
        const buf = b.slice(base + v.offset, base + v.offset + v.size);
        const out = `${outDir}/${p2.replace(/\//g, '_')}`;
        writeFileSync(out, buf);
        console.log('extracted', p2, '->', out, buf.length, 'bytes');
        extracted++;
      }
    }
  }
}
walk(header.files || {}, '');
console.log('total extracted:', extracted);
