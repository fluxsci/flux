#!/usr/bin/env node
// Summarize a V8 .cpuprofile taken from the PRODUCTION bundle, symbolicated through dist's hidden
// sourcemaps: self time per source function, inclusive time per source file, and the heaviest
// call paths. `owner-flow-probe.cjs --profile=open,zoomIn` writes the profiles.
//
//   node scripts/perf/profile-summary.mjs <file.cpuprofile> [--top=30] [--from=ms] [--to=ms] [--stacks=8]
//   --from/--to select a window in ms since the profile started (a long task's own window).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2), file = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
if (!file) { console.error('usage: profile-summary.mjs <file.cpuprofile> [--top=30] [--from=ms] [--to=ms]'); process.exit(2); }
const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
const top = +opt('top', 30), from = +opt('from', 0), to = +opt('to', Infinity), nStacks = +opt('stacks', 8);

const maps = new Map();
function mapFor(url) {
  if (maps.has(url)) return maps.get(url);
  let map = null;
  const m = /\/dist\/(assets\/[^/?#]+\.js)/.exec(url || '');
  if (m) { const p = path.join(repo, 'dist', m[1] + '.map'); if (fs.existsSync(p)) map = new TraceMap(fs.readFileSync(p, 'utf8')); }
  maps.set(url, map); return map;
}
const names = new Map();
function nameOf(node) {
  const cf = node.callFrame, key = node.id;
  if (names.has(key)) return names.get(key);
  let label = cf.functionName || '(anonymous)', where = cf.url ? cf.url.replace(/^.*\/dist\/assets\//, '') + ':' + cf.lineNumber : '';
  const map = mapFor(cf.url);
  if (map && cf.lineNumber >= 0) {
    const pos = originalPositionFor(map, { line: cf.lineNumber + 1, column: cf.columnNumber });
    if (pos.source) { where = pos.source.replace(/^(\.\.\/)+/, '') + ':' + pos.line; if (pos.name) label = pos.name; }
  }
  const out = { label, where, file: where.replace(/:\d+$/, '') };
  names.set(key, out); return out;
}

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
const self = new Map(), fileSelf = new Map(), stacks = new Map();
let t = 0, total = 0;
const t0 = profile.startTime;
for (let i = 0; i < profile.samples.length; i++) {
  const dt = profile.timeDeltas[i] / 1000; t += dt;
  if (t < from || t > to) continue;
  const node = byId.get(profile.samples[i]); if (!node) continue;
  const fn = node.callFrame.functionName;
  if (fn === '(idle)' || fn === '(program)' && false) continue;
  total += dt;
  const n = nameOf(node), k = `${n.label}  ${n.where}`;
  self.set(k, (self.get(k) || 0) + dt);
  fileSelf.set(n.file || '(native)', (fileSelf.get(n.file || '(native)') || 0) + dt);
  // call path: nearest 7 app frames
  const frames = []; for (let id = node.id; id != null && frames.length < 9; id = parent.get(id)) { const f = nameOf(byId.get(id)); if (f.label !== '(root)') frames.push(f.label + (f.where ? '@' + f.where.replace(/^.*\//, '') : '')); }
  const sk = frames.join(' ← ');
  stacks.set(sk, (stacks.get(sk) || 0) + dt);
}
void t0;
const show = (title, m, n) => { console.log(`\n${title}`); for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, n)) console.log(`${v.toFixed(1).padStart(9)} ms  ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`); };
console.log(`${path.basename(file)}: ${total.toFixed(0)} ms of non-idle samples${Number.isFinite(to) || from ? ` in [${from}, ${to}] ms` : ''} (profile ${((profile.endTime - profile.startTime) / 1000).toFixed(0)} ms)`);
show('self time by function', self, top);
show('self time by source file', fileSelf, Math.min(top, 20));
show('heaviest call paths (leaf ← callers)', stacks, nStacks);
