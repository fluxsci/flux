import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOMParser, parseHTML } from 'linkedom';
import { harness } from './lib/harness.mjs';
import { preparePlot, bakePlotStyles, hoistPlotClips } from '../src/lib/plot/parse';
import { plotSpineCandidates, resolveUnitSpine, planPlotSpineAlignment, type SpineContext, type SpineChoice } from '../src/lib/plot/landmarks';
import type { FluxPlotManifest } from '../src/lib/plot/types';
import type { Figure, SemanticPlotElement, Element as SceneElement } from '../src/lib/types';

Object.assign(globalThis, { DOMParser, document: parseHTML('<html><body></body></html>').document });
const h = harness('verify-plot-landmarks');
const near = (a: number | undefined, b: number, epsilon = 1e-6) => a !== undefined && Math.abs(a - b) < epsilon;
const fixture = (path: string) => preparePlot(fs.readFileSync(new URL(`./fixtures/${path}.svg`, import.meta.url), 'utf8'), JSON.parse(fs.readFileSync(new URL(`./fixtures/${path}.fluxplot.json`, import.meta.url), 'utf8')));
const box = fixture('plots/mpl_boxplot_FLUXPLOT'), multi = fixture('fluxplot03/features');
const plot = (extra: Partial<SemanticPlotElement> = {}): SemanticPlotElement => ({ id: 'p', type: 'plot', assetId: 'box', x: 10, y: 20, width: 200, height: 120, rotation: 0, ...extra });
const ctx: SpineContext = { manifest: id => id === 'multi' ? multi.manifest : box.manifest, plotRoot: id => id === 'multi' ? multi.root : box.root };
const one = (el = plot(), axis: 'x' | 'y' = 'x', context = ctx, choice: SpineChoice = {}) => resolveUnitSpine({ key: 'e:' + el.id, members: [el] }, axis, context, choice);
const baseline = box.root!.outerHTML;

h.section('real semantic fixtures and exact placement');
const x = one().landmark!, y = one(plot(), 'y').landmark!;
h.ok(x.eligible && near(x.coordinate, 122.56364444444445), 'real legacy x spine has the independently calculated canvas Y');
h.ok(y.eligible && near(y.coordinate, 44.414025555555554), 'real legacy y spine has the independently calculated canvas X');
h.ok(near(one(plot({ overrides: { 'axis.x.spine': { dy: 9 } } })).landmark?.coordinate, x.coordinate + 10), 'outward/edited spine uses actual override geometry, not pixelBox');
h.ok(near(one(plot({ overrides: { 'axis.x': { dy: 9 } } })).landmark?.coordinate, x.coordinate + 10), 'semantic parent override follows existing effective geometry');
h.ok(one(plot({ rotation: 180 })).landmark?.eligible, '180 degree plot remains horizontally alignable');
h.ok(one(plot({ flipX: true, flipY: true })).landmark?.eligible, 'both placement flips retain valid true spine geometry');
h.ok(!one(plot({ rotation: 90 })).landmark && /horizontal/.test(one(plot({ rotation: 90 })).reason!), '90 degree X spine is not a horizontal target');
h.ok(!one(plot({ rotation: 30 })).landmark, 'oblique placement is refused');
h.ok(one(plot({ crop: { x: 0, y: 0, width: 240, height: 144 } })).landmark?.eligible, 'full intrinsic-pixel crop preserves spine');
h.ok(!one(plot({ crop: { x: 60, y: 36, width: 120, height: 72 } })).landmark, 'a fully clipped spine is refused despite an existing raw outline');
h.ok(!one(plot({ crop: { x: 60, y: 0, width: 180, height: 144 } })).landmark, 'a partially clipped spine is refused');
for (const overrides of [
  { 'axis.x.spine': { hidden: true } }, { 'axis.x': { hidden: true } },
  { 'axis.x.spine': { opacity: 0 } }, { 'axis.x.spine': { stroke: 'none' } },
  { 'axis.x.spine': { stroke: '#00000000' } }, { 'axis.x.spine': { strokeWidth: 0 } },
]) h.ok(!one(plot({ overrides })).landmark, `invisible requested spine is unavailable: ${JSON.stringify(overrides)}`);
h.ok(!one(plot({ opacity: 0 })).landmark, 'transparent plot is unavailable');
h.ok(!one(plot(), 'x', { ...ctx, plotRoot: () => undefined }).landmark, 'missing root never becomes whole-plot bounds');
h.eq(box.root!.outerHTML, baseline, 'all inspections preserve pristine SVG bytes');

h.section('explicit panels, twins and old aliases');
const many = plot({ assetId: 'multi', width: 900, height: 600 });
h.ok(!one(many).landmark && /panel/.test(one(many).reason!), 'multiple main panels require a choice');
const candidates = plotSpineCandidates(many, 'x', ctx).candidates;
h.ok(candidates.some(c => c.axisKey === 'x2' && c.side === 'top' && c.eligible), 'real top twin X spine is a named eligible candidate');
h.ok(Boolean(one(many, 'x', ctx, { panelId: 'panel.fit' }).landmark), 'explicit panel resolves its default bottom spine');
h.eq(one(many, 'x', ctx, { panelId: 'panel.fit', spineId: 'panel.fit.axis.x.spine' }).landmark?.spineId, 'panel.fit.axis.x.spine.bottom', 'legacy spine alias resolves to current source leaf');
h.ok(Boolean(one(many, 'x', ctx, { panelId: 'panel.twin', spineId: 'panel.twin.axis.x2.spine.top' }).landmark), 'explicit twin is usable');
h.ok(!one(many, 'x', ctx, { panelId: 'gone' }).landmark, 'stale panel choice never silently picks another');
h.ok(!one(many, 'x', ctx, { plotId: 'gone' }).landmark, 'stale representative plot never silently picks another');

h.section('strict visibility and source geometry without a CSS renderer');
const manifest = (): FluxPlotManifest => ({ spec: 'fluxplot/manifest', schemaVersion: '0.2.0', axes: [{ id: 'plot-area', x: { scale: 'linear', domain: [0, 1], anchors: [{ data: 0, svg: 10 }, { data: 1, svg: 90 }] }, y: { scale: 'linear', domain: [0, 1], anchors: [{ data: 0, svg: 80 }, { data: 1, svg: 10 }] } }], series: [], size: { width: 100, height: 100, unit: 'px' }, parts: { id: 'figure', role: 'figure', children: [{ id: 'axis.x', role: 'axis', axis: 'x', children: [{ ref: 'axis.x.spine', role: 'spine' }] }] } } as FluxPlotManifest);
function synthetic(options: { root?: string; parent?: string; path?: string; style?: string; d?: string; metadata?: FluxPlotManifest | null } = {}) {
  const prepared = preparePlot(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" ${options.root ?? ''}>${options.style ?? ''}<g ${options.parent ?? ''}><path id="axis.x.spine" d="${options.d ?? 'M10 80L90 80'}" stroke="#000000" ${options.path ?? ''}/></g></svg>`, options.metadata === null ? undefined : options.metadata ?? manifest());
  const context: SpineContext = { manifest: () => prepared.manifest, plotRoot: () => prepared.root };
  return { prepared, context, result: one(plot({ x: 0, y: 0, width: 100, height: 100 }), 'x', context) };
}
h.ok(synthetic().result.landmark?.coordinate === 80, 'synthetic hand-computed segment matches');
h.ok(synthetic({ parent: 'transform="translate(0 -5)"' }).result.landmark?.coordinate === 75, 'nested SVG attribute transform matches');
h.ok(synthetic({ d: 'M0 100L100 100' }).result.landmark?.eligible, 'centerlines on viewport boundaries are allowed');
h.ok(synthetic({ style: '<style>* { stroke-linecap: butt; stroke-linejoin: round }</style>' }).result.landmark?.eligible, 'normal matplotlib cap/join stylesheet is allowed');
for (const options of [
  { parent: 'visibility="hidden"' }, { parent: 'style="opacity:0"' }, { path: 'style="stroke-opacity:0"' },
  { path: 'style="stroke:red;stroke-opacity:0"' },
  { parent: 'clip-path="url(#clip)"' }, { parent: 'mask="url(#mask)"' }, { parent: 'filter="url(#filter)"' },
  { parent: 'style="transform:translateY(10px)"' }, { parent: 'transform="translate(nope)"' },
  { root: 'transform="translate(0 10)"' }, { style: '<style>path { opacity: 0 }</style>' },
  { path: 'style="stroke:currentColor"' }, { d: 'M10 80C20 0 40 0 90 80' },
  { d: 'M10 80L30 80M50 80L90 80' }, { d: 'M10 80L10 80' }, { metadata: null },
]) h.ok(!synthetic(options).result.landmark, `unsupported/invisible geometry refuses: ${JSON.stringify(options)}`);
const polar = manifest(); polar.axes[0].projection = 'polar';
h.ok(!synthetic({ metadata: polar }).result.landmark, 'polar metadata is refused even if a path appears horizontal');
const inset = manifest(); inset.axes[0].panelId = 'inset'; inset.panels = [{ id: 'inset', svgId: 'plot-area', insetOf: 'main' }];
h.ok(!synthetic({ metadata: inset }).result.landmark, 'an inset is never silently chosen as main');
const cache = synthetic();
const modifiedResult = plotSpineCandidates(plot({ x: 0, y: 0, width: 100, height: 100 }), 'x', cache.context);
modifiedResult.candidates[0].coordinate = -999;
h.eq(one(plot({ x: 0, y: 0, width: 100, height: 100 }), 'x', cache.context).landmark?.coordinate, 80, 'callers cannot corrupt cached candidate values');
const updated = synthetic({ parent: 'transform="translate(0 -6)"' });
h.eq(updated.result.landmark?.coordinate, 74, 'replacement source root invalidates numeric candidates');

h.section('atomic plans and complete rigid groups');
const first = plot({ id: 'a', y: 100 }), second = plot({ id: 'b', x: 300, y: 20 });
const label = { id: 'label', type: 'text', x: 280, y: 10, width: 20, height: 20, rotation: 0, text: 'B', groupId: 'g' } as SceneElement;
second.groupId = 'g';
const fig = { id: 'f', elements: [first, second, label], groups: { g: { id: 'g', name: 'B' } } } as unknown as Figure;
const units = [{ key: 'e:a', members: [first] }, { key: 'g:g', members: [second, label] }];
const owned = { ...ctx, figure: fig };
const snapshot = JSON.stringify(fig);
const plan = planPlotSpineAlignment(units, 'x', 'e:a', owned);
h.eq(plan.issues, [], 'both complete plot units preflight successfully');
h.ok(plan.translations.length === 3 && plan.translations.every((p, i) => p.id === ['a', 'b', 'label'][i] && p.dx === 0 && near(p.dy, i ? 80 : 0)) && plan.translations[1].dy === plan.translations[2].dy, 'reference fixed, second plot and grouped annotation translate rigidly');
h.eq(JSON.stringify(fig), snapshot, 'planning is read-only');
h.eq(planPlotSpineAlignment([units[0], { key: 'g:g', members: [second] }], 'x', 'e:a', owned).translations, [], 'partial group fails atomically');
label.locked = true;
h.eq(planPlotSpineAlignment(units, 'x', 'e:a', owned).translations, [], 'locked annotation refuses complete operation');
delete label.locked;
fig.groups!.g.locked = true;
h.eq(planPlotSpineAlignment(units, 'x', 'e:a', owned).translations, [], 'inherited group lock is honored');
delete fig.groups!.g.locked;
h.eq(planPlotSpineAlignment(units, 'x', 'e:a', { ...owned, excluded: new Set(['label']) }).translations, [], 'stashed/excluded member refuses complete operation');
h.eq(planPlotSpineAlignment(units, 'x', 'missing', owned).translations, [], 'missing reference refuses complete operation');
h.eq(planPlotSpineAlignment([units[0], units[0]], 'x', 'e:a', owned).translations, [], 'overlapping units refuse complete operation');
h.eq(planPlotSpineAlignment([units[0], { key: 'loose', members: [label] }], 'x', 'e:a', ctx).translations, [], 'nonplot mixed selection does not silently disappear');
h.ok(!resolveUnitSpine({ key: 'two', members: [first, second] }, 'x', ctx).landmark, 'two plots in one unit require representative choice');
h.ok(resolveUnitSpine({ key: 'two', members: [first, second] }, 'x', ctx, { plotId: 'a' }).landmark?.eligible, 'explicit representative plot resolves multi-plot unit');

h.section('same accepted SVG under editor optimizations and Node preparation');
const guiRoot = box.root!.cloneNode(true) as unknown as SVGSVGElement;
bakePlotStyles(guiRoot); hoistPlotClips(guiRoot);
const guiPlan = planPlotSpineAlignment(units, 'y', 'e:a', { ...owned, plotRoot: () => guiRoot });
const nodePlan = planPlotSpineAlignment(units, 'y', 'e:a', owned);
h.eq(guiPlan, nodePlan, 'editor baked/hoisted root and pristine Node root produce identical plans');
h.eq(box.root!.outerHTML, baseline, 'all parity/eligibility tests leave accepted root unchanged');

h.section('file engine saves/reopens and refuses atomically');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-spine-core-'));
process.env.HOME = path.join(scratch, 'home');
process.env.XDG_CONFIG_HOME = path.join(scratch, 'home', '.config');
process.env.FLUX_NO_MIGRATE = '1';
fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
const { alignPlotSpines, PlotSpineAlignmentError } = await import('../flux-core/plotAlignment');
const { loadFigModel, mutateFigModel } = await import('../flux-core/model');
const projectRoot = path.join(scratch, 'project');
for (const dir of ['fig/assets', 'fig/canvases', 'fig/captions']) fs.mkdirSync(path.join(projectRoot, dir), { recursive: true });
const write = (file: string, value: unknown) => fs.writeFileSync(path.join(projectRoot, file), JSON.stringify(value, null, 2));
write('project.json', { schemaVersion: '0.1.0', id: 'spine-test', title: 'Spine test', manuscript: { path: 'paper/main.qmd' }, references: { library: 'references/library.bib' }, figures: [] });
write('fig/index.json', { schemaVersion: '0.1.0', canvases: [{ id: 'canvas', name: 'Canvas', order: 1 }], figures: [{ id: 'figure', name: 'Figure', label: 'fig-spine', order: 1, kind: 'main', canvas: 'canvas', caption: '' }], assets: [{ id: 'box', name: 'Box', kind: 'svg', path: 'assets/box.svg', naturalWidth: 240, naturalHeight: 144 }], palette: [], colorGroups: [] });
const annotation = { id: 'letter', type: 'text', text: 'B', x: 280, y: 10, width: 16, height: 22, rotation: 0, fontFamily: 'Arial', fontSize: 18, fontWeight: 700, fontStyle: 'normal', align: 'left', color: '#111111', groupId: 'g' };
write('fig/canvases/canvas.json', { schemaVersion: '0.1.0', id: 'canvas', name: 'Canvas', figures: [{ id: 'figure', name: 'Figure', canvasId: 'canvas', x: 0, y: 0, width: 700, height: 400, background: '#ffffff', elements: [first, second, annotation], groups: { g: { id: 'g', name: 'B' } } }] });
const sourceSvg = fs.readFileSync(new URL('./fixtures/plots/mpl_boxplot_FLUXPLOT.svg', import.meta.url), 'utf8');
const sourceManifest = fs.readFileSync(new URL('./fixtures/plots/mpl_boxplot_FLUXPLOT.fluxplot.json', import.meta.url), 'utf8');
fs.writeFileSync(path.join(projectRoot, 'fig/assets/box.svg'), sourceSvg);
fs.writeFileSync(path.join(projectRoot, 'fig/assets/box.fluxplot.json'), sourceManifest);
const coreResult = await alignPlotSpines(projectRoot, 'figure', { ids: ['a', 'b'], axis: 'x', referenceKey: 'e:a' });
h.eq(coreResult.moved, ['b', 'letter'], 'file operation expands plot group and reports annotation movement');
const reopened = (await loadFigModel(projectRoot)).project.figures[0];
h.ok(near(reopened.elements.find(e => e.id === 'b')!.y, 100) && near(reopened.elements.find(e => e.id === 'letter')!.y, 90), 'saved/reopened model retains the exact planned plot and annotation positions');
h.eq(fs.readFileSync(path.join(projectRoot, 'fig/assets/box.svg'), 'utf8'), sourceSvg, 'SVG source bytes remain untouched');
h.eq(fs.readFileSync(path.join(projectRoot, 'fig/assets/box.fluxplot.json'), 'utf8'), sourceManifest, 'semantic source sidecar bytes remain untouched');
const savedCanvas = fs.readFileSync(path.join(projectRoot, 'fig/canvases/canvas.json'), 'utf8');
const identity = await alignPlotSpines(projectRoot, 'figure', { ids: ['a', 'b'], axis: 'x', referenceKey: 'e:a' });
h.eq(identity.moved, [], 'repeated alignment is a no-op');
h.eq(fs.readFileSync(path.join(projectRoot, 'fig/canvases/canvas.json'), 'utf8'), savedCanvas, 'no-op alignment writes no new canvas generation');
await mutateFigModel(projectRoot, 'lock-fixture', ({ project }) => { project.figures[0].elements.find(e => e.id === 'letter')!.locked = true; });
const lockedCanvas = fs.readFileSync(path.join(projectRoot, 'fig/canvases/canvas.json'), 'utf8');
let blocked = false;
try { await alignPlotSpines(projectRoot, 'figure', { ids: ['a', 'b'], axis: 'y', referenceKey: 'e:a' }); }
catch (error) { blocked = error instanceof PlotSpineAlignmentError && error.issues.some(issue => /locked/.test(issue.reason)); }
h.ok(blocked, 'file API reports structured eligibility issues for a locked annotation');
h.eq(fs.readFileSync(path.join(projectRoot, 'fig/canvases/canvas.json'), 'utf8'), lockedCanvas, 'refused operation leaves saved canvas byte-identical');
await h.done(() => { fs.rmSync(scratch, { recursive: true, force: true }); });
