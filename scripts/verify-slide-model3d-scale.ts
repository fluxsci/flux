import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installSlideModelScaleProbe } from './lib/slideModel3dScaleProbe.mjs';
import { harness } from './lib/harness.mjs';
import { slideModel3dScaleFixture } from './lib/slideModel3dScaleFixture';
import { slideModelFrameMetrics, positiveSlideModelHardware, slideModelCohortTiming } from './lib/slideModel3dScaleMetrics.mjs';
import { inspectGlb } from '../src/lib/model3d/glbCore.mjs';
import { morphCompatible } from '../src/lib/model3d/morphPair';
import { compileSlide } from '../src/lib/slide/compile';
const h = harness('verify-slide-model3d-scale');
h.ok(positiveSlideModelHardware('ANGLE (NVIDIA, NVIDIA RTX GPU, OpenGL)', { webgl2: 'enabled' }), 'native enabled WebGL2 and actual device identity qualify hardware');
for (const [renderer, features] of [['ANGLE (Google, SwiftShader)', { webgl2: 'enabled' }], ['Generic OpenGL renderer', { webgl2: 'enabled' }], ['Unknown', { webgl2: 'enabled' }], ['NVIDIA RTX', { webgl2: 'disabled_software' }], ['NVIDIA RTX', {}]] as const) h.ok(!positiveSlideModelHardware(renderer, features), 'software, generic, unknown or disabled hardware reports cannot qualify');
const fixture = await slideModel3dScaleFixture(), { deck } = fixture;
h.eq(fixture.receipt.triangles, [250000, 250000], 'both real stored meshes retain 250,000 triangles');
const binary = fixture.files.filter(f => f.base64).map(f => Buffer.from(f.base64!, 'base64'));
const infos = binary.map(inspectGlb);
h.ok(morphCompatible(infos[0], infos[1]).ok && !binary[0].equals(binary[1]), 'different GLB bytes actually share compatible topology');
h.ok(infos[1].bounds.max[0] > infos[0].bounds.max[0] * 1.3, 'morph geometry changes substantially at tile size');
const single = compileSlide(deck.slides[0], deck.stage, deck), multi = compileSlide(deck.slides[1], deck.stage, deck);
h.eq([single.issues, multi.issues], [[], []], 'the authored single and ghost/morph slides compile without fallback issues');
h.eq(multi.sample(0).presentation.unbornElementIds?.length, 8, 'eight actual born copies start hidden');
h.eq(multi.sample(1).presentation.unbornElementIds?.length ?? 0, 0, 'birth beat makes all eight copies available');
h.eq(multi.sample(2).elements.filter(e => e.type === 'model3d').map(e => e.assetId), Array(9).fill(fixture.assetIds[1]), 'source and every ghost reach the real destination asset');
h.eq(new Set(fixture.ghostIds).size, 8, 'copies have independent identities');
h.ok(deck.slides[1].beats[2].tracks.every(t => t.duration === 2400 && t.easing === 'linear'), 'all nine morphs run together on a real linear 2.4-second beat');
const ids = ['source', ...Array.from({ length: 8 }, (_, i) => `ghost-${i}`)];
const frames = (dt: number) => Array.from({ length: 100 }, (_, i) => ({ stamp: i * dt, ids, visible: 'visible', focused: true }));
h.ok(slideModelFrameMetrics(frames(17), ids, { hardware: true }).withinBudget, 'raw p95 exactly17ms meets the unchanged budget');
h.ok(!slideModelFrameMetrics(frames(17.00000001), ids, { hardware: true }).withinBudget, 'just-over17ms raw p95 fails without rounding');
for (const [name, mutate] of [
  ['duplicate stamps', (f: any[]) => { f[40].stamp = f[39].stamp; }],
  ['missing model publication', (f: any[]) => { f[40].ids = ids.slice(1); }],
  ['focus loss', (f: any[]) => { f[40].focused = false; }],
  ['invisible frame', (f: any[]) => { f[40].visible = 'hidden'; }],
  ['nonfinite stamp', (f: any[]) => { f[40].stamp = NaN; }],
] as const) { const values = frames(16.7); mutate(values); assert.throws(() => slideModelFrameMetrics(values, ids, { hardware: true })); h.ok(true, `${name} cannot qualify hardware playback`); }
assert.throws(() => slideModelFrameMetrics(frames(16.7).slice(0, 70), ids, { hardware: true }));
assert.throws(() => slideModelFrameMetrics(frames(16.7), ids, { hardware: true, minimumFrames: 3 }));
h.ok(true, 'short or weakened hardware cohorts are refused');
const timed = (offset = 0) => Array.from({ length: 145 }, (_, i) => ({ stamp: 16.7 + i * 16.7 + offset, started: 17 + i * 16.7 + offset, finished: 18 + i * 16.7 + offset }));
const cue = [{ key: 'ArrowRight', stamp: 0 }];
h.ok(slideModelCohortTiming(timed(), cue, [], 2400).complete, 'raw final publication covers the authored2.4seconds');
h.ok(!slideModelCohortTiming(timed(1000), cue, [], 2400).responsive, 'one-second cold stall cannot hide behind smooth frame gaps');
h.ok(!slideModelCohortTiming(timed().slice(0, 80), cue, [], 2400).complete, 'eighty smooth frames cannot qualify a shortened animation clock');
h.ok(!slideModelCohortTiming(timed(), cue, [{ event: 'blur', visible: 'visible', focused: false }, { event: 'focus', visible: 'visible', focused: true }], 2400).uninterrupted, 'transient blur then refocus between publications is refused');
h.ok(!slideModelCohortTiming(timed(), cue, [{ event: 'visibilitychange', visible: 'hidden', focused: true }], 2400).uninterrupted, 'transient hidden state is refused');
const delayed = timed(); delayed[0].finished = 100.00000001;
h.ok(!slideModelCohortTiming(delayed, cue, [], 2400).responsive, 'just-over100ms first publication fails without rounding');
assert.throws(() => slideModelCohortTiming([{ stamp: 3, started: 2, finished: 4 }], cue, [], 2400));
h.ok(true, 'unordered publication timing cannot qualify');
// Execute the actual installed observer: it must observe app frames without
// creating a heartbeat and preserve sub-microsecond raw timestamp precision.
const queued = new Map<number, (stamp: number) => void>(); let next = 0;
class Canvas { dataset: Record<string, string> = {}; getContext() { return null; } }
class Context { canvas: any; drawImage() {} constructor(id: string) { this.canvas = { dataset: { slideModel3d: id }, closest: () => true }; } }
const document = { addEventListener() {}, hasFocus: () => true, visibilityState: 'visible', querySelectorAll: () => [] };
const window = { requestAnimationFrame: (fn: (stamp: number) => void) => { queued.set(++next, fn); return next; }, cancelAnimationFrame: (id: number) => queued.delete(id), addEventListener() {} } as any;
vm.runInNewContext(`(${installSlideModelScaleProbe.toString()})()`, { window, document, CanvasRenderingContext2D: Context, HTMLCanvasElement: Canvas, innerWidth: 800, innerHeight: 600, performance: { now: () => 100 }, structuredClone, Set, Symbol });
const observer = window.__slideModelScaleProbe;
h.eq(queued.size, 0, 'installing the actual observer schedules no animation heartbeat');
observer.start(); const contextA = new Context('a'), contextB = new Context('b');
contextA.drawImage();
h.eq(observer.progress().frames, 0, 'out-of-frame publication is not invented as an animation frame');
for (const stamp of [100.123456789, 117.123456799]) {
  const id = window.requestAnimationFrame(() => { contextA.drawImage(); contextB.drawImage(); });
  queued.get(id)!(stamp); queued.delete(id);
}
const observed = observer.stop();
h.eq(observed.map((f: any) => f.ids), [['a', 'b'], ['a', 'b']], 'all same-frame model publications are grouped by actual app RAF stamp');
h.eq(observed[1].stamp, 117.123456799, 'actual installed observer retains unrounded frame stamp');
h.ok(!slideModelFrameMetrics(observed, ['a', 'b'], { minimumFrames: 2 }).withinBudget, 'actual observer-to-metrics path rejects just-over17ms');
const cancelId = window.requestAnimationFrame(() => {}); window.cancelAnimationFrame(cancelId);
h.eq(observer.progress().pending, 0, 'completed and cancelled application callbacks leave no false pending work');
await h.done();
