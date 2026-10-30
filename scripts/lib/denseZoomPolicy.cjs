'use strict';
const { deepZoomDelivered } = require('../perf/input-probe-policy.cjs');
const p95 = values => {
  if (!Array.isArray(values) || !values.length || values.some(n => !Number.isFinite(n) || n < 0)) return Infinity;
  const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))];
};
const near = (a, b, tolerance = 3) => Array.isArray(a) && a.length === b.length && a.every((n, i) => Number.isFinite(n) && Math.abs(n - b[i]) <= tolerance);
/** Independent acceptance oracle; synthetic failures are exercised by the pure gate. */
function evaluateDenseZoom(phase, receipt, runtime) {
  const fixture = receipt?.fixture, stages = receipt?.stages ?? [], initial = receipt?.initial;
  const models = fixture?.modelIDs ?? [], supplement = fixture?.supplementIDs ?? [];
  const ownerOf = new Map(Object.entries(fixture?.figureElements ?? {}).flatMap(([figureId, ids]) => ids.map(id => [id, figureId])));
  const covered = (row, id) => row.ids?.includes(id) || row.rasters?.some(r => r.figureId === ownerOf.get(id) && r.png);
  const checks = [];
  const check = (ok, label) => checks.push({ ok: !!ok, label });
  check(deepZoomDelivered(phase), 'three actual native 16x→wide cycles deliver every injected event and painted barrier');
  check(phase.zoomTicks === phase.wheels && phase.proxyTicks === phase.zoomTicks && phase.zoomTicks >= 180,
    'every delivered zoom event uses the raster proxy throughout all three cycles');
  check(!phase.proxyAbort, 'no live→fallback membership abort occurs');
  check(initial?.nodes >= 30000 && initial.nodes <= 45000 && fixture?.densePrimitiveNodes === 72000 && fixture?.clippedWrappers === 18000,
    'the 72k-node dense model mounts only its 30–45k-node active figure');
  check(ownerOf.size === models.length && models.every(id => ownerOf.has(id)) && fixture?.activeFigureID === fixture?.frameIDs?.[0],
    'every fixture model has one explicit figure owner');
  check([initial, ...stages].every(row => row?.ids?.every(id => ownerOf.get(id) === fixture.activeFigureID) && row?.rasters?.length === 1 &&
    row.rasters.every(r => r.figureId === fixture.frameIDs[1] && r.png && r.width > 0 && r.height > 0 && r.width <= 4096 && r.height <= 4096 && r.width * r.height <= 3000000)),
    'every fold keeps inactive DOM absent and its one PNG within the atlas caps');
  check(fixture?.frameIDs?.length === 2 && fixture.frameIDs.every(id => initial?.frames?.includes(id)), 'both neighboring fixture frames start mounted');
  check(supplement.length === 2 && supplement.every(id => !initial?.ids?.includes(id)), 'two known supplement placements start undisplayed (culled or parked)');
  check(stages.length === 6 && stages.every((row, i) => row.cycle === Math.floor(i / 2) + 1 && row.label === (i % 2 ? 'wide-fold' : 'deep-fold')),
    'all three deep folds and all three wide folds are inspected');
  check(stages.length === 6 && stages.every(row => row.changedInitial?.length === 0 && row.removals?.length === 0) && receipt?.mutation?.removals?.length === 0,
    'initial SVG wrappers retain exact identity without any unmount/remount through folds');
  check(stages.filter(row => row.label === 'wide-fold').length === 3 && stages.filter(row => row.label === 'wide-fold').every(row => models.length > 0 && models.every(id => covered(row, id))),
    'every model is covered by active DOM or its figure PNG after every wide fold');
  check(supplement.length === 2 && supplement.every(id => stages.filter(row => row.label === 'wide-fold').every(row => covered(row, id))),
    'the inactive picture covers the two far placements at every wide fold');
  check([initial, ...stages].every(row => row?.nodes >= 30000 && row.nodes <= 45000 && row.nodes <= fixture?.maxSceneNodes && row.nodes <= initial.nodes + 500),
    'retention stays bounded by the active figure, without duplicated SVG artwork');
  check([initial, ...stages].every(row => row?.canvasCount >= 1 && row.canvasCount <= 2 && row.canvasPixels > 0 && row.canvasPixels <= 6000000 && row.canvasSizes?.every(size => size.every(n => n > 0 && n <= 4096))),
    'only the overview and at most one sharp plane remain resident, each ≤3MP and ≤4096 px a side');
  check(near(receipt?.widePixel, fixture?.markerColor ?? []), 'the final wide native frame contains the independently specified marker color');
  check(near(receipt?.beforeEditPixel, fixture?.markerColor ?? []) && near(receipt?.edit?.deletedPixel, [255, 255, 255]) && near(receipt?.edit?.restoredPixel, fixture?.markerColor ?? []),
    'native Delete/undo changes the captured marker to white and restores its authored pixels');
  for (const [name, presentation, markerPresent] of [['Delete', receipt?.edit?.deletePresentation, false], ['Undo', receipt?.edit?.undoPresentation, true]]) {
    const last = presentation?.attempts?.at(-1), win = presentation?.window, expected = presentation?.expectedWindow;
    check(presentation?.budgetMs === 100 && presentation.presentedInBudget === true && Number.isFinite(presentation.elapsedMs) && presentation.elapsedMs <= 100 && presentation.elapsedMs >= 0 && presentation.delivered?.entry >= 0 && presentation.attempts.length > 0,
      `${name} pixels reach the actual native capture surface within100ms of trusted key delivery`);
    check(last?.marker?.present === markerPresent && last?.layer?.present === markerPresent,
      `${name} native pixels agree with the live SVG and Layers DOM`);
    check(Number.isInteger(win?.id) && win.id > 0 && Number.isInteger(win?.webContentsID) && win.webContentsID > 0 && win.id === expected?.id && win.webContentsID === expected?.webContentsID && win.url === expected?.url && win.url.startsWith('file:') && win.visible && win.focused && presentation.attempts.every(row => row.focused && row.visible === 'visible'),
      `${name} captures the same visible focused production window throughout presentation polling`);
  }
  check(receipt?.edit?.deleted?.live === false && Number(receipt.edit.deleted.liveOpacity) === 1, 'editing an active capture cancels its raster and exposes current live SVG');
  check(runtime?.qualification?.mode === 'qualified' && runtime.qualification.productBackgroundThrottlingPreserved === true,
    'native timing preserves production background throttling on an isolated focused display');
  check(runtime?.wheelCadenceMs === 16, 'the qualified fixture explicitly injects at its declared 16ms display cadence; ordinary 8ms stress remains separate');
  check(['wheelEntryPaint', 'wheelPaint', 'wheelQueueDelay'].every(name => phase.rawTimings?.[name]?.length === phase.wheels),
    'every delivered wheel contributes all three unrounded latency observations');
  for (const [name, samples] of [['frame gap', phase.rawTimings?.frameGaps], ['wheel entry→paint', phase.rawTimings?.wheelEntryPaint], ['wheel timestamp→paint', phase.rawTimings?.wheelPaint], ['wheel queue', phase.rawTimings?.wheelQueueDelay], ['setup nudge/undo key→paint', receipt?.setupKeyPaint], ['edit key→paint', receipt?.edit?.keyPaint]])
    check(p95(samples) <= 100, `${name} p95 remains ≤100ms (${p95(samples).toFixed(2)}ms)`);
  return { ok: checks.every(row => row.ok), checks, maxLongTaskMs: Math.max(0, ...phase.longtasks ?? []),
    maxFrameGapMs: Math.max(0, ...phase.rawTimings?.frameGaps ?? []), maxWheelEntryPaintMs: Math.max(0, ...phase.rawTimings?.wheelEntryPaint ?? []),
    queueP95Ms: p95(phase.rawTimings?.wheelQueueDelay), timestampPaintP95Ms: p95(phase.rawTimings?.wheelPaint) };
}
module.exports = { evaluateDenseZoom, p95 };
