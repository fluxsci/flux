'use strict';
// Observe production policy through a disposable, source-map-located probe.
// Only variable initializers are wrapped; the renderer/IPC/gesture path is real.
// No application asset is rewritten and no test handles ship in the bundle.
const fs = require('node:fs'), path = require('node:path');
const { fileURLToPath } = require('node:url');
const { parse } = require('acorn');
function simple(node, visitors) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visitors[node.type]?.(node);
  for (const value of Object.values(node)) if (Array.isArray(value)) { for (const child of value) simple(child, visitors); } else if (value && typeof value === 'object') simple(value, visitors);
}
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping');
module.exports = function install({ app, protocol, repo, scratch }) {
  const overrides = new Map(), found = new Set();
  const wanted = new Map([
    ['src/lib/figure/atlas.ts:atlasDev', 'atlas'],
    ['src/lib/figure/atlas.ts:atlasStats', 'stats'],
    ['src/lib/figure/atlas.ts:figureRasters', 'rasters'],
    ['src/lib/figure/atlas.ts:atlasRevision', 'revision'],
    ['src/lib/figure/atlasDetail.ts:figureDetails', 'details'],
    ['src/lib/store.ts:viewport', 'viewport'],
    ['src/lib/Canvas.svelte:overviewRev', 'overview'],
    ['src/lib/Canvas.svelte:snapSerial', 'snapshot'],
  ]);
  const dir = path.join(repo, 'dist/assets'), out = path.join(scratch, 'detail-observation');
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.js.map'))) {
    const map = new TraceMap(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    if (!map.sources.some(s => /(?:figure\/atlas|store\.ts|Canvas\.svelte)/.test(s))) continue;
    const file = path.join(dir, name.slice(0, -4)), source = fs.readFileSync(file, 'utf8');
    const edits = [];
    simple(parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true }), {
      VariableDeclarator(node) {
        if (!node.init || node.id.type !== 'Identifier') return;
        const pos = originalPositionFor(map, { line: node.id.loc.start.line, column: node.id.loc.start.column });
        for (const [key, label] of wanted) {
          const [suffix, originalName] = key.split(':');
          const original = map.sourcesContent?.[map.sources.indexOf(pos.source)]?.split('\n')[pos.line - 1]?.slice(pos.column).match(/^[\w$]+/)?.[0];
          if (pos.source?.endsWith(suffix) && (pos.name === originalName || original === originalName)) {
            if (found.has(label)) throw Error(`Duplicate production observation ${label}`);
            found.add(label); edits.push({ start: node.init.start, end: node.init.end, label, name: node.id.name });
          }
        }
      },
    });
    if (!edits.length) continue;
    let patched = source;
    for (const e of edits.sort((a, b) => b.start - a.start)) patched = patched.slice(0, e.start) + `(Object.defineProperty(window.__figureDetailProbe??={},${JSON.stringify(e.label)},{configurable:true,get:()=>${["overview","snapshot"].includes(e.label) ? `(${e.name}?.v??${e.name})` : e.name}}),${source.slice(e.start, e.end)})` + patched.slice(e.end);
    const target = path.join(out, path.basename(file)); fs.writeFileSync(target, patched); overrides.set(file, target);
  }
  // The base-commit control has no detail store or production atlas dev object.
  // Its existing base counters/camera still let the same native gesture prove absence.
  for (const label of wanted.values()) if (!found.has(label) && !(process.env.FLUX_DETAIL_APP_BASE && ['details','atlas'].includes(label))) throw Error(`Missing production observation ${label}; build current sources first`);
  app.whenReady().then(() => protocol.interceptFileProtocol('file', (request, callback) => {
    try { const file = fileURLToPath(request.url); callback({ path: overrides.get(file) || file }); }
    catch { callback({ error: -6 }); }
  }));
  return { found: [...found], overrides: overrides.size };
};
