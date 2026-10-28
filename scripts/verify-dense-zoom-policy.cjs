#!/usr/bin/env node
'use strict';
const { evaluateDenseZoom } = require('./lib/denseZoomPolicy.cjs');
async function main() {
  const { harness } = await import('./lib/harness.mjs'); const h = harness('verify-dense-zoom-policy');
  const make = () => {
    const fixture = { densePrimitiveNodes: 72000, clippedWrappers: 18000, maxSceneNodes: 150000, frameIDs: ['f0', 'f1'], modelIDs: ['a', 'b', 's0', 's1'], supplementIDs: ['s0', 's1'], markerColor: [240, 0, 192] };
    const sample = ids => ({ ids, frames: ['f0', 'f1'], changedInitial: [], removals: [], additions: [], nodes: 72400, canvasCount: 2, canvasPixels: 3996000, canvasSizes: [[2000, 1499], [1000, 998]] });
    const batch = n => ({ sent: n, delivered: n, complete: true });
    const phase = { preciseWheel: false, wheels: 189, zoomTicks: 189, proxyTicks: 189, proxyAbort: null,
      deepZoom: { target: 16, cycles: [15, 33, 33].map(n => ({ afterIn: { zoom: 18 }, inBatches: [batch(n)], out: batch(36) })) },
      rawTimings: { frameGaps: [16.6, 16.7], wheelEntryPaint: Array(189).fill(25), wheelPaint: Array(189).fill(28), wheelQueueDelay: Array(189).fill(3) }, longtasks: [] };
    const presentation = marker => ({ budgetMs: 100, presentedInBudget: true, elapsedMs: 45, delivered: { entry: 10 },
      attempts: [{ elapsedMs: 45, marker: { present: marker }, layer: { present: marker }, focused: true, visible: 'visible' }],
      window: { id: 1, webContentsID: 1, url: 'file:///test/dist/index.html', visible: true, focused: true },
      expectedWindow: { id: 1, webContentsID: 1, url: 'file:///test/dist/index.html' } });
    const receipt = { fixture, initial: sample(['a', 'b']), stages: Array.from({ length: 6 }, (_, i) => ({ ...sample(fixture.modelIDs), label: i % 2 ? 'wide-fold' : 'deep-fold', cycle: Math.floor(i / 2) + 1 })),
      mutation: { ...sample(fixture.modelIDs), additions: [{ id: 's0' }, { id: 's1' }] }, widePixel: fixture.markerColor, beforeEditPixel: fixture.markerColor,
      setupKeyPaint: [20, 24],
      edit: { deleted: { live: false, liveOpacity: '1' }, deletedPixel: [255, 255, 255], restoredPixel: fixture.markerColor,
        deletePresentation: presentation(false), undoPresentation: presentation(true), keyPaint: [20, 24] } };
    const runtime = { wheelCadenceMs: 16, qualification: { mode: 'qualified', productBackgroundThrottlingPreserved: true } };
    return { phase, receipt, runtime };
  };
  const evaluate = value => evaluateDenseZoom(value.phase, value.receipt, value.runtime);
  h.ok(evaluate(make()).ok, 'complete native delivery, stable dense membership, bounded planes, correct edit pixels and ≤100ms metrics pass');
  const failures = [
    ['dropped delivered native wheel', x => x.phase.wheels--],
    ['one live fallback event', x => x.phase.proxyTicks--],
    ['missing zoom observation', x => x.phase.zoomTicks--],
    ['recorded membership abort', x => { x.phase.proxyAbort = ['a']; }],
    ['accidental 256x overshoot', x => { x.phase.deepZoom.cycles[0].afterIn.zoom = 256; }],
    ['shortened deep sequence', x => x.phase.deepZoom.cycles.pop()],
    ['small fixture accidentally substituted', x => { x.receipt.initial.nodes = 4000; }],
    ['neighboring frame never mounted', x => x.receipt.initial.frames.pop()],
    ['supplement was already live initially', x => x.receipt.initial.ids.push('s0')],
    ['one omitted fold inspection', x => x.receipt.stages.pop()],
    ['removed then remounted initial wrapper', x => x.receipt.stages[0].removals.push({ id: 'a' })],
    ['same IDs with changed node identity', x => x.receipt.stages[2].changedInitial.push('a')],
    ['unmount after the final inspected fold', x => x.receipt.mutation.removals.push({ id: 'a' })],
    ['newly visible supplemented plot missing', x => { x.receipt.stages[1].ids = ['a', 'b', 's0']; }],
    ['supplement never actually displayed', x => { x.receipt.stages[5].ids = x.receipt.stages[5].ids.filter(id => id !== 's1'); }],
    ['SVG duplication below global admission cap', x => { x.receipt.stages[4].nodes += 7000; }],
    ['unbounded SVG scene', x => { x.receipt.stages[4].nodes = 150001; }],
    ['extra raster plane', x => { x.receipt.stages[2].canvasCount = 3; }],
    ['oversized raster backing', x => { x.receipt.stages[2].canvasPixels = 6000001; }],
    ['oversized raster side', x => { x.receipt.stages[2].canvasSizes = [[4097, 100]]; }],
    ['blank final wide native frame', x => { x.receipt.widePixel = [255, 255, 255]; }],
    ['stale pixels after native Delete', x => { x.receipt.edit.deletedPixel = [240, 0, 192]; }],
    ['undo restores model but leaves blank pixels', x => { x.receipt.edit.restoredPixel = [255, 255, 255]; }],
    ['stale active raster after edit', x => { x.receipt.edit.deleted.live = true; }],
    ['hidden live SVG after edit', x => { x.receipt.edit.deleted.liveOpacity = '0'; }],
    ['diagnostic background throttling override', x => { x.runtime.qualification.productBackgroundThrottlingPreserved = false; }],
    ['missing native qualification', x => { x.runtime.qualification.mode = 'diagnostic'; }],
    ['unphased stress presented as display-paced qualification', x => { x.runtime.wheelCadenceMs = 8; }],
    ['one omitted native latency observation', x => x.phase.rawTimings.wheelPaint.pop()],
    ['late native presentation despite fast double-rAF', x => { x.receipt.edit.deletePresentation.elapsedMs = 100.001; }],
    ['native capture never receives fresh pixels', x => { x.receipt.edit.deletePresentation.presentedInBudget = false; }],
    ['Delete pixels disagree with Layers DOM', x => { x.receipt.edit.deletePresentation.attempts[0].layer.present = true; }],
    ['Undo pixels disagree with live SVG', x => { x.receipt.edit.undoPresentation.attempts[0].marker.present = false; }],
    ['capture comes from a different native window', x => { x.receipt.edit.deletePresentation.window.id = 2; }],
    ['capture comes from an unexpected renderer URL', x => { x.receipt.edit.deletePresentation.window.url = 'file:///other.html'; }],
    ['presentation loses renderer focus', x => { x.receipt.edit.deletePresentation.attempts[0].focused = false; }],
  ];
  for (const metric of ['frameGaps', 'wheelEntryPaint', 'wheelPaint', 'wheelQueueDelay']) {
    failures.push([`${metric} exceeds unchanged 100ms budget`, x => { x.phase.rawTimings[metric] = Array(189).fill(100.001); }]);
    failures.push([`${metric} lacks samples`, x => { x.phase.rawTimings[metric] = []; }]);
    failures.push([`${metric} contains NaN`, x => { x.phase.rawTimings[metric] = Array(189).fill(NaN); }]);
  }
  failures.push(['native edit exceeds unchanged 100ms budget', x => { x.receipt.edit.keyPaint = [100.001]; }]);
  failures.push(['native setup edit exceeds unchanged 100ms budget', x => { x.receipt.setupKeyPaint = [100.001]; }]);
  for (const [label, corrupt] of failures) { const value = make(); corrupt(value); h.ok(!evaluate(value).ok, `planted failure rejected: ${label}`); }
  const report = evaluate(make());
  h.eq([report.queueP95Ms, report.timestampPaintP95Ms], [3, 28], 'raw transport queue and timestamp-to-paint metrics remain explicitly reported');
  await h.done();
}
void main();
