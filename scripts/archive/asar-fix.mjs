// Fix asar extraction: proper header structure.
// asar format: 
//   offset 0..3: "p" pickle prefix? Actually:
//   [0..7]  pickle: first 4 bytes = 4 (header size field), 
//   [4..7]  = size of following pickle (header JSON)
//   [8..]   = header JSON
// Standard electron asar: bytes 0-7 are header, then pickled. Header string size stored.
// Let's read the well-known format properly and also dump raw values.
import { readFileSync } from 'node:fs';
const p = process.argv[2];
const b = readFileSync(p);
console.log('file size', b.length);
// bytes 0-15
console.log('bytes 0-16:', [...b.slice(0,16)].join(','));
const hdrSize = b.readUInt32LE(8);
console.log('hdrSize @8 =', hdrSize);
const hdrStrSize = b.readUInt32LE(12);
console.log('hdrStrSize @12 =', hdrStrSize);
// header JSON starts at 16
const headerJson = b.slice(16, 16 + hdrStrSize).toString('utf8');
let h;
try { h = JSON.parse(headerJson); console.log('header parsed via offset 16, ok'); }
catch (e) { console.log('parse@16 failed', e.message); }
// data base = 16 + hdrStrSize, but aligned? Usually base = 16 + hdrSize (hdrSize includes the string? )
// In asar, offset stored is relative to data start = 8 + 4 + hdrSize? Let's compute.
// Actually the file node offset is relative to the start of the data section.
// dataStart = 16 + hdrSize  (hdrSize is size of the header pickle block including padding)
const dataStart = 16 + hdrSize;
console.log('computed dataStart =', dataStart);
if (h) {
  const files = h.files || {};
  // find acp.md
  function walk(node, path, acc) {
    for (const k of Object.keys(node || {})) {
      const v = node[k];
      const p2 = path ? path + '/' + k : k;
      if (v && v.files) walk(v.files, p2, acc);
      else if (v && typeof v.size === 'number' && p2.endsWith('acp.md') && p2.includes('docs')) acc.push({ p2, size: v.size, offset: Number(v.offset), rawOffset: v.offset });
    }
    return acc;
  }
  const found = walk(files, '', []);
  console.log('found', found.length);
  found.forEach((f) => {
    const abs = dataStart + f.offset;
    console.log(`  ${f.p2} size=${f.size} offset=${f.offset} abs=${abs}`);
    if (f.p2.includes('/cn/')) {
      console.log('  content head:', b.slice(abs, abs + 500).toString('utf8').split('\n').slice(0, 8).join('\n'));
    }
  });
}
