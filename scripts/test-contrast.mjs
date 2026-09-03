// Zero-cost regression: can you actually SEE the traffic light?
//
// The status light is 4-5px. That is small enough that a colour choice can make
// a state invisible without any test failing and without any exception being
// thrown - which is exactly what happened: offline had no CSS rule at all, fell
// back to #2a3142, and sat at 1.47:1 against its own housing. The one state the
// user most wants to spot ("which agent dropped off?") was the one you could
// not see. Numbers catch what review does not.
//
//   node scripts/test-contrast.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', 'public', 'style.css'), 'utf8');

// WCAG 2.1 relative luminance.
const chan = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
function lum(hex) {
  const [r, g, b] = rgb(hex).map((c) => chan(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function rgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// --- pull the values straight out of the stylesheet --------------------------
const rootBlock = CSS.match(/:root\s*\{([\s\S]*?)\}/);
if (!rootBlock) throw new Error('no :root block found - did style.css change shape?');
const vars = {};
for (const m of rootBlock[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();

const resolve = (v) => (v && v.startsWith('var(') ? vars[v.slice(4, -1).trim()] : v);

// The housing is the backdrop every dot is judged against.
const housing = CSS.match(/\.traffic\s*\{[^}]*?background:\s*(#[0-9a-fA-F]{3,8}|var\(--[\w-]+\))/)?.[1];
if (!housing) throw new Error('no .traffic background found');
const HOUSE = resolve(housing);

// Each state lights one dot; find the colour it paints it with.
const STATES = ['idle', 'busy', 'error', 'offline'];
const found = {};
for (const s of STATES) {
  // .traffic[data-s="idle"] i:nth-child(3) { background: X; ... }
  const rule = CSS.match(new RegExp(`\\.traffic\\[data-s="${s}"\\][^{]*\\{[^}]*?background:\\s*(#[0-9a-fA-F]{3,8}|var\\(--[\\w-]+\\))`));
  found[s] = rule ? resolve(rule[1]) : null;
}

// 3:1 is the WCAG floor for non-text UI components. Below this a 4px dot is a
// smudge, not a signal.
const MIN_RATIO = 3;
let fail = 0;

console.log(`housing ${HOUSE}  (${Object.keys(vars).length} css vars parsed)\n`);
for (const s of STATES) {
  const c = found[s];
  if (!c) {
    // Missing rule = falls through to the unlit colour. Not necessarily wrong,
    // but it is the shape the offline bug had, so make it explicit.
    console.log(`FAIL  ${s.padEnd(8)} no rule -> falls back to unlit colour (invisible)`);
    fail++;
    continue;
  }
  const r = ratio(c, HOUSE);
  const ok = r >= MIN_RATIO;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.padEnd(8)} ${c}  ${r.toFixed(2)}:1  ${ok ? '' : `(below ${MIN_RATIO}:1)`}`);
}

// The unlit fallback should stay dark: a dot with no state must not look lit.
// Anchored to the bare ".traffic i {" rule: a looser match would grab override
// selectors like ".agent-card.off .traffic i" (deliberate offline gray) and
// misreport the true fallback as an unlit violation.
const unlit = resolve(CSS.match(/^\.traffic\s+i\s*\{[^}]*?background:\s*(#[0-9a-fA-F]{3,8}|var\(--[\w-]+\))/m)?.[1] || '');
if (unlit) {
  const r = ratio(unlit, HOUSE);
  const ok = r < MIN_RATIO;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${'unlit'.padEnd(8)} ${unlit}  ${r.toFixed(2)}:1  ${ok ? '(correctly dim)' : '(too bright - looks lit)'}`);
}

// Every lit state must also be distinguishable from the others, or red/yellow
// blur together at 4px.
const lit = STATES.map((s) => found[s]).filter(Boolean);
for (let i = 0; i < lit.length; i++) {
  for (let j = i + 1; j < lit.length; j++) {
    const r = ratio(lit[i], lit[j]);
    // Adjacent hues need less separation than dot-vs-housing, but 1.25 keeps
    // e.g. yellow and green from reading as the same blob.
    const ok = r >= 1.25;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${(STATES[i] + '/' + STATES[j]).padEnd(16)} ${r.toFixed(2)}:1 ${ok ? '' : '(too similar)'}`);
  }
}

console.log(fail ? `\n${fail} failed` : `\nall passed`);
process.exit(fail ? 1 : 0);
