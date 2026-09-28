import { readFileSync } from 'node:fs';
import { DOMParser, parseHTML } from 'linkedom';
import { harness } from './lib/harness.mjs';
import { preparePlot, buildPartIndex } from '../src/lib/plot/parse';
import { createTransform } from '../src/lib/slide/player/transform';
import { compilePlotContent, fillContent } from '../src/lib/slide/player/render';
import { BUILTIN_THEMES } from '../src/lib/slide/theme';
import { projectSeries, viewFits } from '../src/lib/plot/project';
import type { FluxPlotManifest } from '../src/lib/plot/types';
import type { SemanticPlotElement } from '../src/lib/types';
const DEFAULT_THEME = BUILTIN_THEMES["flux-dark"];
const h = harness('verify-plot-binding');
const { document } = parseHTML('<html><body></body></html>');
Object.assign(globalThis, { document, DOMParser });
const fixture = (name: string) => {
  const manifest = JSON.parse(readFileSync(new URL(`./fixtures/fluxplot03/${name}.fluxplot.json`, import.meta.url), 'utf8')) as FluxPlotManifest;
  return { manifest, root: preparePlot(readFileSync(new URL(`./fixtures/fluxplot03/${name}.svg`, import.meta.url), 'utf8'), manifest).root! };
};
const A = fixture('panels-a'), B = fixture('panels-b');
const pre: SemanticPlotElement = { id: 'p', type: 'plot', assetId: 'a', x: 0, y: 0, width: 540, height: 240, rotation: 0 };
const end = { ...pre, assetId: 'b' };
const ctx = { theme: DEFAULT_THEME, plotRoot: (id: string) => id === 'a' ? A.root : B.root, plotManifest: (id: string) => id === 'a' ? A.manifest : B.manifest };
const mount = (context = ctx) => { const host = document.createElement('div'); fillContent(host, pre, context); return host; };
const host = mount(), original = host.querySelector('[id="p__panel.small.control.line"] path');
const driver = createTransform(host, pre, end, ctx);
const opacity = (node: Element | null) => Number((node as SVGElement | null)?.style.opacity || node?.getAttribute('opacity') || 1);
for (const t of [0, .2, .8, 1, .2, 0]) {
  driver.seek(t);
  h.eq(host.querySelectorAll('svg').length, 1, `one live plot at ${t}`);
  h.ok(host.querySelector('[id="p__panel.small.control.line"] path') === original, `shared series retains identity at ${t}`);
  for (const i of [4, 5]) {
    const node = host.querySelector(`[id="p__panel.small.axis.y.tick.${i}"]`);
    h.ok(!!node, `outgoing tick ${i} retained`);
    h.ok(Math.abs(opacity(node) - Math.max(0, 1-t/.4)) < 1e-6, `outgoing tick ${i} fades at ${t}`);
  }
  // Stamped DFS ids (plot/derive.ts `n<k>`) are positional: panels-b has two
  // fewer y ticks, so every later stamp shifts. The shared line and spines bind
  // structurally inside their semantic group, never crossfade as strangers.
  const lineGroup = host.querySelector('[id="p__panel.small.control.line"]');
  h.eq(lineGroup?.querySelectorAll('path').length, 1, `shared series line keeps one path at ${t}`);
  h.eq(opacity(lineGroup?.querySelector('path') ?? null), 1, `shared series line stays opaque at ${t}`);
  h.eq(opacity(host.querySelector('[id="p__panel.small.axis.y.spine"] path')), 1, `shared spine stays opaque at ${t}`);
  const series = A.manifest.series[0], other = B.manifest.series[0];
  const points = projectSeries(series, other, viewFits(A.manifest, undefined, series.panelId)!, viewFits(B.manifest, undefined, other.panelId)!, t);
  h.ok(original!.getAttribute('d')!.includes(`${points[0].x.toFixed(6)} ${points[0].y.toFixed(6)}`), `shared series follows projection at ${t}`);
}
// Reverse direction supplies genuine B-only semantic ids (the generator uses
// stable tick indices, so panels-a → b removes two ticks, it doesn't add three).
const back = document.createElement('div'); fillContent(back, end, ctx);
const reverse = createTransform(back, end, pre, ctx);
for (const t of [0, .2, .8, 1, 0]) {
  reverse.seek(t);
  for (const i of [4, 5]) h.ok(Math.abs(opacity(back.querySelector(`[id="p__panel.small.axis.y.tick.${i}"]`)) - Math.max(0, (t-.6)/.4)) < 1e-6, `incoming tick ${i} fades at ${t}`);
}
const tiny = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement as unknown as SVGSVGElement;
const localA = tiny('<svg viewBox="0 0 100 100"><g id="shared"><path d="M 0 0 L 10 10"/></g><g id="residue"><circle r="2"/></g></svg>');
const localB = tiny('<svg viewBox="0 0 100 100"><g id="shared"><path d="M 10 0 L 20 10"/></g><g id="residue"><circle r="3"/><circle r="4"/></g><g id="added"><circle r="5"/></g></svg>');
const localCtx = { theme: DEFAULT_THEME, plotRoot: (id: string) => id === 'a' ? localA : localB };
const localHost = mount(localCtx as typeof ctx), localDriver = createTransform(localHost, pre, end, localCtx);
localDriver.seek(.2);
h.eq(localHost.querySelectorAll('svg').length, 1, 'topology mismatch crossfades only one node without a manifest');
h.eq(localHost.querySelector('[id="p__shared"] path')?.getAttribute('d'), 'M 2 0 L 12 10', 'unrelated part still interpolates');
h.eq(localHost.querySelectorAll('[id="p__residue"]').length, 1, 'fallback destination retains unique canonical id');
localDriver.seek(.8);
h.ok(Math.abs(opacity(localHost.querySelector('[id="p__residue"]'))-.5)<1e-6, 'local replacement fades in');
h.ok(Math.abs(opacity(localHost.querySelector('[id="p__added"]'))-.5)<1e-6, 'B-only node fades in');
localDriver.seek(0); h.eq(opacity(localHost.querySelector('[id="p__added"]')), 0, 'reverse seek hides appended node');
// Equal semantic parents may contain unequal anonymous subtrees and named leaves.
const nestedA = tiny('<svg><g id="part"><g><path id="leaf" d="M0 0 L1 1"/></g></g><g id="steady"><circle r="1"/></g></svg>');
const nestedB = tiny('<svg><g id="part"><g><path id="leaf" d="M0 0 L2 2"/></g><circle r="4"/></g><g id="steady"><circle r="3"/></g></svg>');
const nestedCtx = { theme: DEFAULT_THEME, plotRoot: (id: string) => id === 'a' ? nestedA : nestedB };
const nested = mount(nestedCtx as typeof ctx), nestedDriver = createTransform(nested, pre, end, nestedCtx);
nestedDriver.seek(.8);
h.eq(nested.querySelectorAll('[id="p__leaf"]').length, 1, 'local fallback keeps nested semantic ids unique');
h.ok(Math.abs(opacity(nested.querySelector('[id="p__part"]'))-.5)<1e-6, 'anonymous mismatch fades its named parent only');
h.eq(nested.querySelector('[id="p__steady"] circle')?.getAttribute('r'),'2.6','sibling of a nested mismatch still interpolates');
nestedDriver.seek(1);
const nestedBack = createTransform(nested, end, pre, nestedCtx);
nestedBack.seek(.8);
const nestedIds = Array.from(nested.querySelectorAll('[id]')).map(n=>n.id);
h.eq(new Set(nestedIds).size,nestedIds.length,'chained local crossfades use distinct residue namespaces');
const pathCtx = { theme: DEFAULT_THEME, plotRoot: (id: string) => tiny(id === 'a' ? '<svg><g id="line"><path d="M0 0 L1 1"/></g></svg>' : '<svg><g id="line"><path d="M0 0 L1 1 L2 2"/></g></svg>') };
const pathHost = mount(pathCtx as typeof ctx), pathDriver = createTransform(pathHost, pre, end, pathCtx);
pathDriver.seek(.2);
h.eq(pathHost.querySelectorAll('svg').length,1,'unsupported path topology keeps one plot');
h.eq(opacity(pathHost.querySelector('[id="p__line"]')),0,'unsupported path topology fades locally instead of stepping');

// Regenerated points and line vertices: union by index, with no invented bridge
// across a missing datum. Exercise the exported driver, not the writer directly.
const mini = (ys: (number|null)[]) => {
  const points = ys.flatMap((y,index)=>y===null?[]:[{index,x:index+1,y,svgId:`s.point.${index}`}]);
  const root = tiny(`<svg viewBox="0 0 100 100"><g id="s.line"><path d="M10 10 L20 20" style="fill:none;stroke:#123456"/></g><g id="s.points">${points.map(p=>`<circle id="${p.svgId}" cx="${p.x*10}" cy="${p.y*10}" r="1"/>`).join('')}</g></svg>`);
  const axis={scale:'linear',supported:true,domain:[0,10],anchors:[{data:0,svg:0},{data:10,svg:100}]};
  const manifest={version:'0.3',axes:[{x:axis,y:axis}],series:[{id:'s',roles:['line','point'],svg:{line:'s.line'},data:{x:ys.map((_,i)=>i+1),y:ys},points}]} as unknown as FluxPlotManifest;
  return {root,manifest};
};
const short=mini([1,2,3]),long=mini([2,4,6,8]);
long.root.querySelector('path')!.setAttribute('style','fill:none;stroke:#abcdef');
const unequalCtx={theme:DEFAULT_THEME,plotRoot:(id:string)=>id==='a'?short.root:long.root,plotManifest:(id:string)=>id==='a'?short.manifest:long.manifest};
const unequal=mount(unequalCtx),unequalDriver=createTransform(unequal,pre,{...end,view:{x:{domain:[0,5]}}},unequalCtx);
for (const t of [0,.2,.8,1,0]) {
  unequalDriver.seek(t);
  const marker=unequal.querySelector('[id="p__s.point.3"]');
  h.ok(!!marker,'new marker installed once');
  h.ok(Math.abs(opacity(marker)-Math.max(0,(t-.6)/.4))<1e-6,`unmatched point fades at ${t}`);
  h.eq(Number(marker?.getAttribute('cx')),40*(1+t),`incoming held datum projects through changing view at ${t}`);
  h.eq(unequal.querySelectorAll('[id="p__s.point.3"]').length,1,'incoming marker identity stays unique');
}
unequalDriver.seek(.8);
const liveLine=unequal.querySelector('[id="p__s.line"] path') as SVGElement;
for(const segment of unequal.querySelectorAll('[data-projection-residue]')) h.eq((segment as SVGElement).style.stroke,liveLine.style.stroke,'residual segments share interpolated paint');
unequalDriver.seek(1);
h.ok(unequal.querySelector('[id="p__s.line"] path')!.getAttribute('d')!.endsWith('L80.000000 80.000000'),'longer line endpoint includes its new vertex');
const broken=mini([1,null,3]),gapCtx={theme:DEFAULT_THEME,plotRoot:(id:string)=>id==='a'?short.root:broken.root,plotManifest:(id:string)=>id==='a'?short.manifest:broken.manifest};
const gaps=mount(gapCtx),gapDriver=createTransform(gaps,pre,end,gapCtx);
gapDriver.seek(.2);
h.ok(Math.abs(opacity(gaps.querySelector('[id="p__s.point.1"]'))-.5)<1e-6,'null datum fades its outgoing marker');
gapDriver.seek(1);
h.eq(gaps.querySelector('[id="p__s.line"] path')!.getAttribute('d'),'M10.000000 10.000000 M30.000000 30.000000','missing datum never bridges a gap at the endpoint');
const mixedCtx = { theme: DEFAULT_THEME, plotRoot: (id: string) => id === 'b' ? localB : undefined, assetUrl: () => 'data:image/png;base64,AA==' };
const mixed = document.createElement('div'); fillContent(mixed, pre, mixedCtx);
const mixedDriver = createTransform(mixed, pre, end, mixedCtx);
mixedDriver.seek(.8);
h.eq(opacity(mixed.querySelector('img')!.parentElement),0,'raster source fades out when destination has semantic parts');
h.ok(Math.abs(opacity(mixed.querySelector('svg')!.parentElement)-.5)<1e-6,'semantic destination fades in from a raster endpoint');
mixedDriver.seek(0);h.eq(opacity(mixed.querySelector('svg')!.parentElement),0,'mixed endpoint reversal hides destination');
const noIds = { theme: DEFAULT_THEME, plotRoot: () => tiny('<svg><path d="M 0 0 L 1 1"/></svg>') };
h.eq(compilePlotContent(mount(noIds as typeof ctx), pre, end, noIds), null, 'id-less SVG retains complete crossfade fallback');

// At rest the frame IS the endpoint, in both directions: every semantic part
// the endpoint's own static render paints is painted, exactly once. Positional
// ids (stamped n<k>, matplotlib ytick_N/text_N/patch_N) shift between these
// regenerated assets: panels-a's large-panel ticks sit in ytick_6…10, panels-b's
// in ytick_4…6, so a positional pairing hides or doubles them.
const effective = (node: Element, root: Element) => {
  let o = 1;
  for (let n: Element | null = node; n && n !== root; n = n.parentElement) {
    const st = (n as SVGElement).style;
    if (st?.display === 'none') return 0;
    o *= Number(st?.opacity || n.getAttribute('opacity') || 1);
  }
  return o;
};
const painted = (el: SemanticPlotElement, m: FluxPlotManifest) => {
  const still = document.createElement('div'); fillContent(still, el, ctx);
  return Object.keys(buildPartIndex(m)).filter(id => !/^n\d+$/.test(id)).filter(id => {
    const node = still.querySelector(`[id="p__${id}"]`); return !!node && effective(node, still) > .999;
  });
};
const unpainted = (host: Element, ids: string[]) => ids.filter(id => {
  const nodes = host.querySelectorAll(`[id="p__${id}"]`);
  return nodes.length !== 1 || effective(nodes[0], host) < .999;
});
for (const [from, to, fromM, toM, label] of [[pre, end, A.manifest, B.manifest, 'panels-a → b'], [end, pre, B.manifest, A.manifest, 'panels-b → a']] as const) {
  const host = document.createElement('div'); fillContent(host, from, ctx);
  const driver = createTransform(host, from, to, ctx);
  const source = painted(from, fromM), target = painted(to, toM);
  h.ok(source.length > 40 && target.length > 40, `${label}: ${source.length} source / ${target.length} destination semantic parts under test`);
  for (const t of [1, .5, 0, 1]) {
    driver.seek(t);
    if (t === 1) h.eq(unpainted(host, target), [], `${label}: at t = 1 every destination part is painted exactly once`);
    if (t === 0) h.eq(unpainted(host, source), [], `${label}: at t = 0 every source part is painted exactly once`);
    if (t === .5) {
      const line = host.querySelector('[id="p__panel.small.control.line"]');
      h.eq(line?.querySelectorAll('path').length, 1, `${label}: the shared line keeps one path mid-flight`);
      h.ok(!!line && effective(line.querySelector('path')!, host) > .999, `${label}: the shared line stays painted mid-flight`);
      h.eq(host.querySelectorAll('[data-plot-residue]').length, 0, `${label}: no part crossfades as a stranger`);
    }
  }
}

// The shared attribute compiler: a static frame performs no DOM writes.
// Counted on the updater the transform driver calls, with every attribute and
// style write in the document instrumented.
const counted = { n: 0 };
const elementProto = Object.getPrototypeOf(Object.getPrototypeOf(document.createElementNS('http://www.w3.org/2000/svg', 'path')));
const styleProto = Object.getPrototypeOf((document.createElement('div') as HTMLElement).style);
const hooks: [object, string][] = [];
for (const [proto, names] of [[elementProto, ['setAttribute', 'removeAttribute']], [styleProto, ['setProperty', 'removeProperty']]] as const) {
  for (const name of names) {
    let owner: any = proto; while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
    if (!owner) continue;
    const original = owner[name];
    owner[name] = function (this: unknown, ...args: unknown[]) { counted.n++; return original.apply(this, args); };
    hooks.push([owner, name]); (owner as any)[`__orig_${name}`] = original;
  }
}
const writesDuring = (fn: () => void) => { const before = counted.n; fn(); return counted.n - before; };
const still = mount(), stillUpdate = compilePlotContent(still, pre, { ...pre }, ctx)!;
h.ok(!!stillUpdate, 'identical endpoints compile an updater');
h.eq(writesDuring(() => { stillUpdate(pre, .3); stillUpdate(pre, .7); }), 0, 'identical endpoints: frames write nothing (endpoint-constant values compile to no binding)');
const moving = mount(), movingUpdate = compilePlotContent(moving, pre, end, ctx)!;
movingUpdate(end, .5);
h.eq(writesDuring(() => movingUpdate(end, .5)), 0, 'panels-a → b: repeating a frame writes nothing');
h.ok(writesDuring(() => movingUpdate(end, .55)) > 0, 'panels-a → b: a new frame still writes');
for (const [owner, name] of hooks) (owner as any)[name] = (owner as any)[`__orig_${name}`];
await h.done();
