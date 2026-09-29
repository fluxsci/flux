import { installSlideModelScaleProbe } from './slideModel3dScaleProbe.mjs';
import { slideModelFrameMetrics, positiveSlideModelHardware, slideModelCohortTiming } from './slideModel3dScaleMetrics.mjs';

/** Same real Present/key/publication scenario in browser and production Electron.
 * The adapter's wait polls from the host; it must never add a renderer clock. */
export async function runSlideModelScaleCohort(ui, fixture, { hardware = false, gpuFeatures } = {}) {
  const checks = [], receipt = { hardware, fixture: fixture.receipt, checks };
  const check = (value, label) => { checks.push({ ok: !!value, label }); if (!value) throw Error(label); };
  const evaluate = ui.evaluate;
  try {
    await evaluate(installSlideModelScaleProbe);
    await ui.present();
    const state = () => evaluate(() => window.__slideModelScaleProbe.read());
    const progress = () => evaluate(() => window.__slideModelScaleProbe.progress());
    const pixels = () => evaluate(() => [...document.querySelectorAll('.present .mount canvas[data-slide-model3d]')].filter(c => c.width && c.height && c.style.display !== 'none').map(source => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 48;
      const ctx = canvas.getContext('2d'); ctx.drawImage(source, 0, 0, 48, 48);
      const data = [...ctx.getImageData(0, 0, 48, 48).data]; let colored = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 32 && Math.max(...data.slice(i, i + 3)) - Math.min(...data.slice(i, i + 3)) > 35) colored++;
      return { id: source.dataset.slideModel3d, colored, data };
    }));
    const visible = async ids => {
      await ui.wait(async () => {
        const rows = await pixels(); return ids.every(id => rows.some(r => r.id === id && r.colored > 40));
      }, 'actual mesh publication', 90000);
      const current = await state();
      check(ids.every(id => current.canvases.some(c => c.id === id && c.rect.width > 0 && c.rect.height > 0 && c.rect.x >= -1 && c.rect.y >= -1 && c.rect.right <= current.viewport.width + 1 && c.rect.bottom <= current.viewport.height + 1)), 'all requested mesh boxes are inside the actual Present viewport');
      return current;
    };
    const idle = async name => {
      await ui.wait(async () => (await progress()).pending === 0, 'player animation completes', 90000);
      const before = await state();
      // This is the measured rest window, not a readiness delay.
      await new Promise(resolve => setTimeout(resolve, 500));
      const after = await state(); receipt[name] = { before, after, observationMs: 500 };
      check(before.requests === after.requests && before.callbacks === after.callbacks && before.stats.renders === after.stats.renders, 'zero model renders and host RAF requests/callbacks in 500ms at rest');
    };
    const play = async (name, ids, duration) => {
      const before = await pixels();
      const beforeState = await state(), inputsBefore = beforeState.inputs.length, eventsBefore = beforeState.visibility.length;
      await evaluate(() => { window.__slideModelScaleProbe.start(); window.__slideModelScaleStarted = performance.now(); });
      await ui.press('ArrowRight');
      await ui.wait(async () => evaluate(duration => {
        const p = window.__slideModelScaleProbe.progress();
        return p.frames >= 2 && performance.now() - window.__slideModelScaleStarted >= duration && p.pending === 0;
      }, duration), 'real animation finishes after delivered key', 90000);
      const frames = await evaluate(() => window.__slideModelScaleProbe.stop());
      const metrics = slideModelFrameMetrics(frames, ids, { hardware, minimumFrames: hardware ? 80 : 2 });
      const after = await pixels(), changed = ids.map(id => {
        const a = before.find(p => p.id === id), b = after.find(p => p.id === id);
        return { id, changed: b.data.filter((v, i) => Math.abs(v - a.data[i]) > 8).length, colored: b.colored };
      });
      receipt[name] = { metrics, frames, changed, state: await state() };
      receipt[name].deliveredInputs = receipt[name].state.inputs.slice(inputsBefore);
      receipt[name].visibilityEvents = receipt[name].state.visibility.slice(eventsBefore);
      receipt[name].timing = slideModelCohortTiming(frames, receipt[name].deliveredInputs, receipt[name].visibilityEvents, duration);
      check(changed.every(p => p.colored > 40 && p.changed > 50), 'every visible model publishes changed mesh pixels');
      check(receipt[name].deliveredInputs.filter(e => e.key === 'ArrowRight').length === 1, 'this animation was driven by exactly one trusted delivered key');
      if (hardware) {
        check(receipt[name].timing.uninterrupted, 'no transient native window blur or hidden state occurred during the cohort');
        check(receipt[name].timing.responsive, 'trusted cue reaches its first complete model publication within100ms');
        check(receipt[name].timing.complete, 'observed publication spans the complete authored animation duration');
        check(metrics.withinBudget, `${name} raw publication frame-gap p95 ${metrics.p95}ms ≤17ms`);
      }
      await ui.screenshot(name);
      await idle(name + 'Idle');
    };
    receipt.initial = await visible(['scale-single-model']);
    check(receipt.initial.stats.contexts === 1 && receipt.initial.owners === 1, 'Present uses one actual shared inline WebGL context');
    if (hardware) check(positiveSlideModelHardware(receipt.initial.renderer, gpuFeatures), 'positive hardware GPU identity and enabled native WebGL2 feature');
    await idle('initialIdle');
    await play('singleModel', ['scale-single-model'], 2400);
    await ui.press('ArrowRight');
    receipt.beforeBirth = await visible(['scale-source']);
    check(receipt.beforeBirth.stats.morphPairs === 1, 'real compatible morph geometry is warmed before its playback cue');
    check(receipt.beforeBirth.canvases.filter(c => fixture.ghostIds.includes(c.id)).every(c => c.width === 0 && c.height === 0), 'all unborn ghost backing canvases are released');
    await ui.press('ArrowRight');
    const ids = ['scale-source', ...fixture.ghostIds];
    await visible(ids); await idle('bornIdle');
    const distinct = await pixels();
    check(new Set(distinct.map(p => JSON.stringify(p.data))).size >= 6, 'ghost copies retain independent camera views');
    await ui.screenshot('eight-ghosts');
    await play('morphAndEightGhosts', ids, 2400);
    receipt.final = await state();
    check(receipt.final.stats.contexts === 1 && receipt.final.observedInlineContexts === 1 && receipt.final.stats.assets === 2 && receipt.final.stats.morphPairs === 1, 'nine independent views share two assets and one prepared morph pair without replacing the context');
    check(receipt.final.stats.residentBytes < 768 * 1024 * 1024, 'retained GLB bytes remain below the existing 768MiB budget');
    await ui.press('Escape');
    // Present opens in HTML fullscreen, where Chromium spends the first Escape leaving
    // fullscreen without delivering it; the second one reaches Present and closes it.
    await ui.wait(async () => evaluate(() => !document.fullscreenElement), 'Present leaves fullscreen');
    if (await evaluate(() => !!document.querySelector('.present'))) await ui.press('Escape');
    await ui.wait(async () => evaluate(() => !document.querySelector('.present') && !document[Symbol.for('flux.model3d.inlineHost')]), 'Present disposes inline host');
    check(true, 'closing Present disposes the actual inline pool');
    receipt.ok = true;
  } catch (error) { receipt.ok = false; receipt.error = String(error.stack || error); receipt.errorCode = error.code; }
  return receipt;
}
