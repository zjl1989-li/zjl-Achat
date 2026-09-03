import { readFileSync } from 'node:fs';
const p = process.argv[2];
const b = readFileSync(p);
const hdrStrSize = b.readUInt32LE(12);
const h = JSON.parse(b.slice(16, 16 + hdrStrSize).toString('utf8'));
const files = h.files;
// dump the cli/dist node structure
function find(node, path, depth) {
  for (const k of Object.keys(node || {})) {
    const v = node[k];
    const p2 = path ? path + '/' + k : k;
    if (v && v.files) find(v.files, p2, depth + 1);
    else if (p2.endsWith('acp.md')) {
      console.log('PATH', p2);
      console.log('NODE KEYS:', Object.keys(v));
      console.log('NODE RAW:', JSON.stringify(v).slice(0, 400));
    }
  }
}
find(files, '', 0);
