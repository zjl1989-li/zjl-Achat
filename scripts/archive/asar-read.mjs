// Read a specific packed file (has offset) from app.asar given its path.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const p = process.argv[2];
const out = process.argv[3];
const want = process.argv.slice(4);
const b = readFileSync(p);
const hdrStrSize = b.readUInt32LE(12);
const h = JSON.parse(b.slice(16, 16 + hdrStrSize).toString('utf8'));
const dataStart = 16 + b.readUInt32LE(8);
let extracted = 0;
function walk(node, path) {
  for (const k of Object.keys(node || {})) {
    const v = node[k];
    const p2 = path ? path + '/' + k : k;
    if (v && v.files) walk(v.files, p2);
    else if (v && typeof v.size === 'number' && !v.unpacked) {
      if (want.some((w) => p2 === w || p2.endsWith(w))) {
        const off = Number(v.offset);
        const abs = dataStart + off;
        const buf = b.slice(abs, abs + v.size);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, buf);
        console.log('extracted', p2, '->', out, buf.length, 'bytes (abs offset', abs + ')');
        extracted++;
      }
    }
  }
}
walk(h.files, '');
console.log('extracted count:', extracted);
